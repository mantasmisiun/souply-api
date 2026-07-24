import { Request, Response, NextFunction } from "express";
import { ensureTripForReceipt, relinkReceiptToListTrip, notifyTripReceiptPublished } from '../services/tripLinkService.js';
import sharp from "sharp";
import pool from "../config/db.js";
import { isTripMember } from "../models/tripModel.js";
import { createReceipt, getReceiptsByUserId, getReceiptById, deleteReceipt, getReceiptItemsWithDetails, updateReceiptFilePath, getReceiptByReceiptNoAndUser, getReceiptByAnyReceiptNoAndUser, getReceiptByAnyReceiptNoStoreDate, completeMandatorySwipes, userHideReceipt, reactivateHiddenReceipt, reassignAndReactivateReceipt } from "../models/receiptModel.js";
import { linkReceiptToList } from "../models/shoppingListModel.js";
import {
    getSwipeCandidatesWithDetails,
    getVerifiedStoreProductIdsForReceipt,
    getVotedPairKeysForUser,
} from "../models/receiptSwipeCandidateModel.js";
import { buildSwipeQueue } from "../services/swipeQueueService.js";
import { getMandatoryQueue, getServedResolveLineIdxs } from "../services/mandatoryQueueService.js";
import { snapshotReceiptComparison } from "../services/comparisonSnapshotService.js";
import { normalizeReceiptNo, normalizeReceiptNos } from "../utils/receiptMetadata.js";
import { getReverificationPairKeysForReceipt } from "../models/userEquivalenceModel.js";
import {
    unverifyReceiptLinePrice,
    upsertReceiptLineIssue,
    type IssueFlags,
} from "../models/receiptLineIssueModel.js";
import { getPresignedUrl, deleteReceiptImage } from "../services/storageService.js";
import { persistReceiptPrices, applyReceiptAutosave } from '../services/receiptSaveService.js';
import { getReceiptItemLines, replaceReceiptItems } from '../models/receiptItemModel.js';
import { getCachedChainCandidates, getCachedCrossChainCandidates } from '../models/storeProductModel.js';
import { findBestProductMatches } from '../utils/productMatcher.js';
import { computeItemConfidence } from '../services/itemConfidence.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { healReceipt as computeHealPlan, isSameReceipt, type HealLine } from '../services/receiptHealService.js';
import { withDeadlockRetry } from '../utils/withDeadlockRetry.js';
import { demoteReceiptLineDirect } from '../services/receiptLineDemotionService.js';
import { buildReceiptResolveCards, markServedResolveLinesAsked } from '../services/receiptResolveQueueService.js';
import { castReceiptLineVote } from '../services/receiptLineVoteService.js';
import { markLineResolved } from '../models/receiptLineResolutionModel.js';
import { deleteReceiptWithData } from '../services/receiptDeletionService.js';
import { getReceiptComparison } from '../services/receiptComparisonService.js';
import { hydrateReceiptCategoriesIfNeeded } from '../services/receiptHydrationService.js';
import { generateDefaultTemplate } from '../services/defaultTemplateService.js';
import {
    logFailedReceipt,
    type FailReason,
} from "../models/failedReceiptLogModel.js";
import { createUser } from "../models/userModel.js";
import { notifyTelegram, resolveEnv } from "../scrapers/shared/telegramAlert.js";

export const markSwipesDone = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        // Snapshot the publish state BEFORE clearing, so we notify trip members
        // exactly once — on the real transition to published (a receipt with a
        // mandatory queue becoming cleared). Already-published rows (required 0,
        // handled at link time) and repeat calls don't re-notify.
        const beforeSwipes = await getReceiptById(id);
        await completeMandatorySwipes(id);
        // Terminal ask-once: mark ONLY the Card-B lines actually SERVED this session
        // 'asked' (those the user did NOT resolve stay suppressed; a vote already marked
        // resolved_user at the /vote path). The served set is the client's own reported
        // indices when present, else the mandatory-queue snapshot the client was served —
        // NEVER a fresh recompute at completion, which would pick the NEXT top uncertain
        // lines (already-resolved served lines now excluded) and burn lines the user never
        // saw, permanently hiding them from future voluntary sessions. This is the ledger
        // write that USED to live on the resolve-queue GET — moved here (a real completion
        // event) so serving the queue stays idempotent and re-fetches never delete the
        // user's cards mid-session. Fail-soft: a ledger hiccup must not fail the completion
        // the client already acted on.
        try {
            const bodyIdxs = Array.isArray(req.body?.servedResolveLineIdxs)
                ? (req.body.servedResolveLineIdxs as unknown[])
                      .map((v) => Number(v))
                      .filter((n) => Number.isInteger(n) && n >= 0)
                : null;
            const servedIdxs = bodyIdxs ?? (req.authUserId ? getServedResolveLineIdxs(req.authUserId, id) : null);
            if (servedIdxs && servedIdxs.length > 0) {
                const conn = await (pool as any).getConnection();
                try {
                    await conn.beginTransaction();
                    await markServedResolveLinesAsked(id, conn, servedIdxs);
                    await conn.commit();
                } catch (e) {
                    await conn.rollback();
                    throw e;
                } finally {
                    conn.release();
                }
            }
        } catch (ledgerErr) {
            console.warn(`[markSwipesDone] ask-once ledger write failed for receipt ${id}:`, ledgerErr);
        }
        // Publish notification (re-timed off link): a queued receipt attached to
        // a trip has just cleared → tell the other members. Fire only on the true
        // pending→published transition to avoid double-fire with the link path.
        if (beforeSwipes && beforeSwipes.tripId != null) {
            const reqd = Number(beforeSwipes.mandatorySwipesRequired ?? 0);
            const done = Number(beforeSwipes.mandatorySwipesCompleted ?? 0);
            const wasPublished = reqd === 0 || done >= reqd;
            if (!wasPublished) {
                notifyTripReceiptPublished(id).catch(e =>
                    console.warn('[markSwipesDone] publish notify failed:', e?.message ?? e));
            }
        }
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptsByUserId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.userId);
        const receipts = await getReceiptsByUserId(userId);
        res.json(receipts);
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        // Lazy migration for pre-redesign receipts (see service docstring).
        const hydrated = await hydrateReceiptCategoriesIfNeeded(id, receipt, req.locale);
        res.json(hydrated);
    } catch (error) {
        next(error);
    }
};

/**
 * DEV-ONLY: hard delete a receipt and ALL the data it spawned (prices, orphan
 * StoreProducts/Products, MinIO image). Refuses in production/staging
 * (NODE_ENV==='production') so it can never wipe real price data from the
 * internet-facing API — the phone only exposes the long-press entry in dev.
 */
export const removeReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (process.env.NODE_ENV === 'production') {
            res.status(403).json({ error: 'Receipt purge is disabled in this environment' });
            return;
        }
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const result = await deleteReceiptWithData(id);
        if (!result.deleted) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/receipts/:id/user
 *
 * User-facing "remove this scan" BEFORE the mandatory swipe queue is cleared.
 * Soft-hides the receipt from every user-facing list (userDeletedAt), detaches
 * it from its trip/list, and deletes the stored photo — but KEEPS the shared
 * Price / ReceiptItem / learning rows (unlike the dev-only hard purge). Because
 * the prices survive, a later re-upload of the same paper un-hides + re-links
 * the row instead of erroring (see createReceiptFromOcr).
 *
 * GATE: allowed only while the mandatory queue is NOT cleared. "Cleared" =
 * required > 0 AND completed >= required — the paid-for swipe work is done, so
 * the row must stay; only the photo may be dropped (DELETE /:id/image → 423
 * points the client there). required === 0 (no queue) counts as NOT cleared.
 *
 * Ownership is proven by requireReceiptOwner middleware.
 */
export const hideReceiptForUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        const required = Number(receipt.mandatorySwipesRequired ?? 0);
        const completed = Number(receipt.mandatorySwipesCompleted ?? 0);
        const cleared = required > 0 && completed >= required;
        if (cleared) {
            res.status(423).json({
                error: 'swipes-cleared',
                message: 'Mandatory swipes are done — only the photo can be deleted now',
            });
            return;
        }
        const filePath = typeof receipt.filePath === 'string' ? receipt.filePath : null;
        await userHideReceipt(id);
        // MinIO is not transactional — do it after the DB write, best-effort. A
        // stranded object is harmless and a missing one is fine, so a failure here
        // must not fail the hide the client already acted on.
        try {
            await deleteReceiptImage(filePath);
        } catch (e: any) {
            console.warn(`[hideReceipt] image delete failed for receipt ${id}:`, e?.message ?? e);
        }
        res.status(200).json({ ok: true, hidden: true });
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/receipts/:id/image
 *
 * Photo-only delete (post-swipe): drop the stored MinIO image and clear
 * filePath. The Receipt row, ReceiptItem, Price and trip link all stay intact.
 * Allowed regardless of swipe state — this is the alternative the hide gate
 * (423) points the client to once the mandatory queue is cleared.
 *
 * Ownership is proven by requireReceiptOwner middleware.
 */
export const deleteReceiptImageOnly = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        const filePath = typeof receipt.filePath === 'string' ? receipt.filePath : null;
        try {
            await deleteReceiptImage(filePath);
        } catch (e: any) {
            console.warn(`[deleteReceiptImage] MinIO delete failed for receipt ${id}:`, e?.message ?? e);
        }
        // filePath is NOT NULL — empty it (matches the createReceipt `filePath || ''`
        // convention). Keeps the row + prices + trip link untouched.
        await updateReceiptFilePath(id, '');
        res.status(200).json({ ok: true, imageDeleted: true });
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptImage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }

        // Optional downscaled variant: GET /receipts/:id/image?maxw=N streams a
        // sharp-resized JPEG (bytes, ONE request) so bandwidth-sensitive callers
        // (web, slow/cellular reopen) pull tens of KB instead of fetching the full
        // object via a second MinIO round-trip. No param → unchanged presigned-URL
        // JSON, so the mobile crop path keeps full resolution + the stable contract.
        // Degrades to the presigned URL on any transform failure.
        const maxwRaw = Number(req.query.maxw);
        const maxw = Number.isFinite(maxwRaw) ? Math.floor(maxwRaw) : 0;
        if (maxw >= 64 && maxw <= 4096) {
            try {
                const signed = await getPresignedUrl(receipt.filePath);
                const imgRes = await fetch(signed);
                if (!imgRes.ok) throw new Error(`minio fetch HTTP ${imgRes.status}`);
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const out = await sharp(buf)
                    .resize({ width: maxw, withoutEnlargement: true })
                    .jpeg({ quality: 82 })
                    .toBuffer();
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'private, max-age=120');
                res.send(out);
                return;
            } catch (e: any) {
                console.warn('[fetchReceiptImage] downscale failed, serving presigned URL', {
                    id, err: e?.message ?? String(e),
                });
                // fall through to the presigned-URL JSON
            }
        }

        const url = await getPresignedUrl(receipt.filePath);
        // Presign TTL is 1h, so a short client cache window is safe and spares
        // repeat presigns when a screen re-mounts.
        res.set('Cache-Control', 'private, max-age=120');
        res.json({ url });
    } catch (error: any) {
        if (error?.statusCode === 404) {
            res.status(404).json({ error: error.message });
            return;
        }
        next(error);
    }
};

export const fetchReceiptItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const items = await getReceiptItemsWithDetails(id, req.locale);
        res.json(items);
    } catch (error) {
        next(error);
    }
};

/**
 * Create a receipt record and persist its parsed prices.
 * Called once when receipt-process screen first completes OCR+matching.
 * Returns the new receipt ID.
 */
export const createReceiptFromOcr = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Owner = the token subject (requireUser), NEVER a client-supplied body userId —
        // otherwise a caller could create a receipt owned by another account.
        const userId = req.authUserId;
        const { filePath, fileType, parsedData } = req.body;
        if (!userId || !parsedData) {
            res.status(400).json({ error: 'auth and parsedData are required' });
            return;
        }
        // Shared re-link for a reactivated (un-hidden) receipt — mirrors a fresh
        // upload's trip/list wiring and restores the photo if the body carried one.
        // A list-scoped upload points the receipt at the list's trip (like the link
        // endpoint); a bare upload re-mints an ad-hoc trip (ensureTripForReceipt is a
        // no-op when tripId is already set, and hide/relinquish nulled it).
        const relinkReactivatedReceipt = async (rowId: number) => {
            if (filePath) {
                try { await updateReceiptFilePath(rowId, filePath); }
                catch (e: any) { console.warn(`[reactivate] filePath restore failed for receipt ${rowId}:`, e?.message ?? e); }
            }
            const reListId = Number.isFinite(Number(req.body?.shoppingListId)) && Number(req.body.shoppingListId) > 0
                ? Number(req.body.shoppingListId)
                : null;
            if (reListId != null) {
                await linkReceiptToList(rowId, reListId);
                await relinkReceiptToListTrip(rowId, reListId);
            } else {
                await ensureTripForReceipt(rowId, String(userId), null);
            }
        };
        // Reject duplicates early so re-photographing the same receipt doesn't
        // create parallel records. IKI synthesizes a `{date}-{time}-{cents}-iki-receipt`
        // number specifically so this check works when the receipt format has no
        // natural unique ID. OVERLAP matching: every distinctive identifier the footer
        // carries (receiptNos[]) is considered, not just the canonical — the paper
        // prints its id in several forms, so a re-scan whose canonical got OCR-garbled
        // still collides through a clean secondary id (e.g. the VMI "Kvito numeris").
        // Short low-entropy ids ("Kvitas 3157") are excluded inside the model. The
        // canonical-only check stays as a fallback for non-distinctive canonicals.
        const candidateReceiptNo = parsedData.footer?.receiptNo ?? null;
        const candidateReceiptNos: string[] = Array.isArray(parsedData.footer?.receiptNos) && parsedData.footer.receiptNos.length
            ? parsedData.footer.receiptNos
            : (candidateReceiptNo ? [candidateReceiptNo] : []);
        if (candidateReceiptNos.length) {
            const existing = (await getReceiptByAnyReceiptNoAndUser(candidateReceiptNos, String(userId)))
                ?? (candidateReceiptNo ? await getReceiptByReceiptNoAndUser(candidateReceiptNo, String(userId)) : null);
            if (existing) {
                // RE-UPLOAD OF A HIDDEN RECEIPT: the user removed this scan pre-swipe
                // (DELETE /receipts/:id/user set userDeletedAt, detached trip/list, wiped
                // the photo) but its idempotent Price rows were KEPT. Re-photographing the
                // same paper should ATTACH it back, not 409. Un-hide, re-link to the new
                // upload's context, and re-store the photo — WITHOUT re-ingesting prices
                // (they were kept) or re-firing the receipt_buy interaction.
                if (existing.userDeletedAt != null) {
                    await reactivateHiddenReceipt(existing.id);
                    await relinkReactivatedReceipt(existing.id);
                    res.status(200).json({ reactivated: true, receiptId: existing.id });
                    return;
                }
                // Same-user duplicate. The most common real-world cause is the ABORT-THEN-RETRY
                // case (receipt-238): the first POST exceeded the client timeout, the server
                // committed anyway, and the retry collides here. Hand back everything the client
                // needs to RESUME the pipeline against the existing row (photo upload + swipe
                // phase) instead of dropping the scan: the id + how many mandatory swipes remain.
                res.status(409).json({
                    error: 'duplicate',
                    message: 'Receipt already uploaded',
                    existingReceiptId: existing.id,
                    mandatorySwipesPending: Math.max(
                        0,
                        Number(existing.mandatorySwipesRequired ?? 0) - Number(existing.mandatorySwipesCompleted ?? 0),
                    ),
                    // TRUE when the existing row never got its photo (the abort-then-retry
                    // shape) — the client resumes ONLY then (or when swipes are pending).
                    // A COMPLETE duplicate (photo present, no pending swipes) must surface
                    // the "already uploaded" error instead: silently resuming a deliberate
                    // re-scan overwrote the stored photo with the new frame (user report).
                    photoPending: !(typeof existing.filePath === 'string' && existing.filePath.trim().length > 0),
                });
                return;
            }
        }
        // CROSS-USER witness overlap (upfront twin of the unique-key safety net
        // below): the unique key only collides on the exact canonical, so a
        // garbled canonical or synthetic-only capture on either side slips it —
        // but both scans carry the deterministic date+time+total witness in
        // receiptNos. Bounded by store + day, so the check is a handful of rows.
        {
            const dupStoreId = parsedData.header?.storeId ?? null;
            const dupDate = parsedData.footer?.date ?? null;
            if (candidateReceiptNos.length && dupStoreId != null && dupDate) {
                const other = await getReceiptByAnyReceiptNoStoreDate(
                    candidateReceiptNos, Number(dupStoreId), String(dupDate), String(userId),
                );
                if (other) {
                    // RELINQUISHED CROSS-USER RECEIPT: the colliding row was HIDDEN by
                    // its original uploader (userDeletedAt set, prices kept). One row per
                    // physical receipt — so instead of 409, hand it to THIS uploader:
                    // clear the hide + transfer ownership (userId + uploaderUserId), then
                    // re-link to the new upload's context. Prices/learning stay put; no
                    // receipt_buy re-fire.
                    if (other.userDeletedAt != null) {
                        await reassignAndReactivateReceipt(other.id, String(userId));
                        await relinkReactivatedReceipt(other.id);
                        res.status(200).json({ reactivated: true, receiptId: other.id });
                        return;
                    }
                    // Souply 2.0 SAME-TRIP EXEMPTION: a fellow trip member
                    // re-uploading the same physical receipt is EXPECTED
                    // ("either can upload") — hand back the existing receipt
                    // so the client links it instead of erroring out.
                    if (other.tripId != null && (await isTripMember(Number(other.tripId), String(userId)))) {
                        res.status(409).json({
                            error: 'duplicate',
                            sameTrip: true,
                            tripId: Number(other.tripId),
                            receiptId: Number(other.id),
                            message: 'Receipt already uploaded by a trip member',
                        });
                        return;
                    }
                    res.status(409).json({
                        error: 'duplicate',
                        crossAccount: true,
                        message: 'Receipt already registered to another account',
                    });
                    return;
                }
            }
        }
        // Ensure the User row exists before the FK-dependent Receipt insert.
        // INSERT IGNORE is idempotent, so this is a no-op when the user
        // already exists. Protects against DB resets where the phone still
        // has USER_SYNCED_KEY='1' but the user row is gone.
        await createUser(String(userId));
        // Receipt.storeId is resolved from parsedData later; initial insert can use null
        const storeId = parsedData.header?.storeId ?? null;
        const receiptId = await createReceipt(userId, storeId, filePath || '', fileType || 'image/jpeg');

        // Cross-user duplicate safety net. The upfront same-user check above
        // only catches re-uploads by the SAME user. The UNIQUE constraint on
        // (receiptNo, storeId, date) is cross-user — a different user
        // uploading the same physical receipt will collide here. Rather
        // than leak the error to the client, delete the orphan Receipt row
        // we just inserted and return a clean 409. The mobile app treats
        // 409 as a terminal state and navigates back to the Analize tab.
        try {
            const result = await withDeadlockRetry(() => persistReceiptPrices(receiptId, userId, parsedData, {
                chainId: parsedData.header?.chainId,
                storeId,
                receiptNo: parsedData.footer?.receiptNo ?? null,
                date: parsedData.footer?.date ?? null,
                time: parsedData.footer?.time ?? null,
                products: (parsedData.products || []).map((p: any) => ({
                    storeProductId: p.storeProductId ?? null,
                    matchConfirmed: !!p.matchConfirmed,
                    priceVerified: !!p.priceVerified,
                    price: p.price,
                    promoPrice: p.promoPrice,
                    quantity: p.quantity,
                    unit: p.unit,
                })),
            }, true), { label: `create receipt ${receiptId}` });
            res.status(201).json({ id: receiptId, ...result });
            // Fire-and-forget default-template regeneration. Runs after the
            // response has been sent so client-perceived latency is unaffected.
            // No-ops when the user doesn't qualify (< 3 receipts / < 2 chains)
            // or already has an autoUpdate=off default template — see
            // generateDefaultTemplate() for the full guard chain.
            generateDefaultTemplate(String(userId)).catch(e =>
                console.warn('[defaultTemplate] generation failed:', e?.message),
            );
            // 2.0: a bare upload becomes an AD-HOC trip (born stage 5,
            // scoreExempt). List uploads get re-pointed at the list's trip by
            // the link endpoint moments later (relinkReceiptToListTrip).
            ensureTripForReceipt(receiptId, String(userId), null).catch(e =>
                console.warn('[tripLink] ad-hoc trip mint failed:', e?.message),
            );
        } catch (err: any) {
            // Best-effort cleanup of the orphaned Receipt row on ANY persist failure —
            // createReceipt inserted the bare row BEFORE the (rolled-back) save
            // transaction, so a non-duplicate failure used to LEAK one empty row per
            // attempt (the garbled-date retry loop left 17 of them, surfacing as
            // "malformed parsedData" entries in the Analyze list). At this point the
            // row has no children (the transaction rolled back), so the delete is safe;
            // non-fatal if it fails.
            try {
                await deleteReceipt(receiptId);
            } catch (cleanupErr) {
                console.warn('Failed to clean up orphan receipt', receiptId, cleanupErr);
            }
            if (err?.code === 'ER_DUP_ENTRY' && /unique_receipt/i.test(String(err?.sqlMessage ?? ''))) {
                // Before declaring cross-account, check whether the colliding row is a
                // RELINQUISHED (hidden) receipt — the upfront witness check can miss it
                // when only the exact canonical collides. If so, transfer + reactivate
                // it to this uploader instead of erroring (same as branch above).
                try {
                    const dupStoreId = parsedData.header?.storeId ?? null;
                    const dupDate = parsedData.footer?.date ?? null;
                    if (candidateReceiptNos.length && dupStoreId != null && dupDate) {
                        const hidden = await getReceiptByAnyReceiptNoStoreDate(
                            candidateReceiptNos, Number(dupStoreId), String(dupDate),
                        );
                        if (hidden && hidden.userDeletedAt != null) {
                            await reassignAndReactivateReceipt(hidden.id, String(userId));
                            await relinkReactivatedReceipt(hidden.id);
                            res.status(200).json({ reactivated: true, receiptId: hidden.id });
                            return;
                        }
                    }
                } catch (reErr: any) {
                    console.warn('[reactivate] cross-user hidden-row transfer failed:', reErr?.message ?? reErr);
                    // fall through to the crossAccount 409
                }
                // Cross-account: a DIFFERENT user already uploaded this
                // physical receipt. Flag it so the client doesn't tell the
                // current user "you already uploaded this" (they didn't) and
                // doesn't try to link someone else's receipt to their list.
                res.status(409).json({
                    error: 'duplicate',
                    crossAccount: true,
                    message: 'Receipt already registered to another account',
                });
                return;
            }
            throw err;
        }
    } catch (error) {
        next(error);
    }
};

/**
 * Update an existing receipt with edited parsedData.
 * New Price rows added for changed products (dedup'd, clearance-filtered).
 * Existing prices are not deleted — historical edits stay as price history.
 */
export const updateReceiptFromOcr = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        // Identity from the token (requireUser + requireReceiptOwner already proved the
        // caller owns this receipt). The body userId is ignored.
        const userId = req.authUserId;
        const { parsedData } = req.body;
        if (isNaN(id) || !userId || !parsedData) {
            res.status(400).json({ error: 'Invalid id or missing auth/parsedData' });
            return;
        }

        try {
            // NON-DESTRUCTIVE autosave: merges client-owned edits into the existing
            // ReceiptItem/Price rows instead of re-running the full save pipeline
            // (which DELETE+INSERTed items, cascade-deleted prices, and overwrote
            // server-side vote/reject state with the client's stale blob).
            const result = await withDeadlockRetry(() => applyReceiptAutosave(id, userId, parsedData, {
                chainId: parsedData.header?.chainId,
                storeId: parsedData.header?.storeId ?? null,
                receiptNo: parsedData.footer?.receiptNo ?? null,
                date: parsedData.footer?.date ?? null,
                time: parsedData.footer?.time ?? null,
                products: (parsedData.products || []).map((p: any) => ({
                    storeProductId: p.storeProductId ?? null,
                    matchConfirmed: !!p.matchConfirmed,
                    priceVerified: !!p.priceVerified,
                    price: p.price,
                    promoPrice: p.promoPrice,
                    quantity: p.quantity,
                    unit: p.unit,
                })),
            }), { label: `autosave receipt ${id}` });
            res.json({ id, ...result });
        } catch (err: any) {
            // Duplicate-receipt safety net for the update path. This
            // fires when an auto-save would push the row into the
            // (receiptNo, storeId, date) tuple owned by another
            // Receipt — typically because two rows accidentally point
            // at the same physical receipt (e.g. mobile re-OCR via
            // rehydration finds the same identity fields as a
            // pre-existing sibling row). Return 409 instead of 500
            // so the client can detect the collision and decide what
            // to do (we currently log + ignore on the client side —
            // the local state still reflects the corrected values,
            // and the user can manually delete the sibling row).
            if (err?.code === 'ER_DUP_ENTRY' && /unique_receipt/i.test(String(err?.sqlMessage ?? ''))) {
                res.status(409).json({
                    error: 'duplicate',
                    message: 'Receipt with this number already exists for the user at this store/date',
                    receiptId: id,
                });
                return;
            }
            throw err;
        }
    } catch (error) {
        next(error);
    }
};

/**
 * Mobile-side MinIO upload helper: returns a presigned PUT URL.
 * Body: { filename, mimeType }
 * Response: { uploadUrl, filePath (what to store on Receipt.filePath) }
 */
export const getReceiptUploadUrl = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { filename, mimeType } = req.body;
        if (!filename) {
            res.status(400).json({ error: 'filename is required' });
            return;
        }
        const { getPresignedUploadUrl } = await import('../services/storageService.js');
        const { uploadUrl, filePath } = await getPresignedUploadUrl(filename, mimeType || 'image/jpeg');
        res.json({ uploadUrl, filePath });
    } catch (error) {
        next(error);
    }
};

/**
 * Convert a PDF (base64) to one PNG per page (each base64) — used by the
 * mobile app when the user uploads a downloaded Rimi/Maxima receipt PDF.
 * The client OCRs each page separately and merges the line lists.
 *
 * Returning per-page images instead of a stitched one: ML Kit accuracy
 * drops sharply on very large images, and Android's Image decoder may
 * downsample-scramble giant stitched receipts. Per-page avoids both.
 *
 * Rasterisation goes through `pdftoppm` (poppler) — same tool the dev
 * batch staging script uses. Keeping rasterizer + DPI identical means
 * a PDF that parses correctly in Kvitų paketinis testas parses the
 * same way through this endpoint.
 *
 * Body:     { pdfBase64: string }
 * Response: { images: string[] (base64 PNGs, one per page), mimeType: 'image/png' }
 */
export const convertPdfToImage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { pdfBase64 } = req.body;
        if (!pdfBase64 || typeof pdfBase64 !== 'string') {
            res.status(400).json({ error: 'pdfBase64 is required' });
            return;
        }
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
        if (pdfBuffer.length === 0) {
            res.status(400).json({ error: 'pdfBase64 decoded to an empty buffer' });
            return;
        }
        // Hard binary-size cap (independent of the 10mb JSON body limit) so a giant
        // decoded blob can't reach the rasteriser.
        const MAX_PDF_BYTES = 8 * 1024 * 1024;
        if (pdfBuffer.length > MAX_PDF_BYTES) {
            res.status(413).json({ error: 'pdf too large' });
            return;
        }
        const { convertPdfBufferToImagePages, PdfTooLargeError } = await import('../services/pdfService.js');
        try {
            const pages = await convertPdfBufferToImagePages(pdfBuffer);
            res.json({
                images: pages.map((b) => b.toString('base64')),
                mimeType: 'image/png',
            });
        } catch (inner: any) {
            if (inner instanceof PdfTooLargeError) {
                res.status(413).json({ error: 'pdf too large or too complex' });
                return;
            }
            throw inner;
        }
    } catch (error: any) {
        console.error('PDF → PNG conversion failed:', error?.message ?? error);
        next(error);
    }
};

 //Set Receipt.filePath after mobile finishes MinIO upload.
export const setReceiptFilePath = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { filePath } = req.body;
        if (isNaN(id) || !filePath) {
            res.status(400).json({ error: 'Invalid id or missing filePath' });
            return;
        }
        await updateReceiptFilePath(id, filePath);
        res.json({ id, filePath });
    } catch (error) {
        next(error);
    }
};

// Minimal Region validator. Anything else on the object is ignored —
// keeps the parser free to evolve without breaking the endpoint.
const isRegion = (r: any): boolean =>
    !!r &&
    typeof r === 'object' &&
    Number.isFinite(r.yTop) &&
    Number.isFinite(r.yBottom) &&
    Number.isFinite(r.xLeft) &&
    Number.isFinite(r.xRight);

// Allow-list for `kind` so a malformed client can't inject arbitrary
// strings. Stays in sync with shared/parsers/rimiParser.ts RegionKind.
const ALLOWED_KINDS = new Set([
    'storeName',
    'storeAddress',
    'storeCode',
    'total',
    'date',
    'time',
    'dateTime',
    'receiptNo',
]);

interface SanitisedRegion {
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
    kind?: string;
}

const sanitiseRegions = (arr: any): SanitisedRegion[] | null => {
    if (!Array.isArray(arr)) return null;
    return arr.filter(isRegion).map((r: any) => {
        const out: SanitisedRegion = {
            yTop: Number(r.yTop),
            yBottom: Number(r.yBottom),
            xLeft: Number(r.xLeft),
            xRight: Number(r.xRight),
        };
        if (typeof r.kind === 'string' && ALLOWED_KINDS.has(r.kind)) {
            out.kind = r.kind;
        }
        return out;
    });
};

/**
 * PATCH /api/receipts/:id/regions
 *
 * Rehydration for pre-current-parser receipts. The mobile app re-runs
 * OCR + parser locally on the cached receipt image and PATCHes the
 * results here so the next open is free.
 *
 * Body:
 *   {
 *     headerLineRegions: Region[],
 *     footerLineRegions: Region[],
 *     regionsVersion?: string,
 *     total?: number | null,
 *     totalSavings?: number | null,
 *   }
 *
 * Always merges `lineRegions` (parser-emitted bbox geometry — safe to
 * overwrite). For `total` / `totalSavings`, applies the value ONLY
 * when the stored value is null (i.e. original parse failed). This
 * preserves any user edits while letting parser fixes for variant OCR
 * (e.g. `ė`→`ê` substitution) backfill the missing data.
 */
export const updateReceiptRegions = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const headerLineRegions = sanitiseRegions(req.body?.headerLineRegions);
        const footerLineRegions = sanitiseRegions(req.body?.footerLineRegions);
        if (headerLineRegions === null || footerLineRegions === null) {
            res.status(400).json({ error: 'headerLineRegions and footerLineRegions must be arrays' });
            return;
        }

        // Read-modify-write the parsedData blob under a ROW LOCK so this can't race the
        // debounced autosave PUT (which also writes the blob) into a lost update — the
        // FOR UPDATE below serializes the two on the Receipt row. Everything through the
        // final UPDATE runs in this one transaction.
        const conn = await (pool as any).getConnection();
        let committed = false;
        try {
        await conn.beginTransaction();
        const [lockRows]: any = await conn.query(
            'SELECT parsedData, receiptNos, receiptNoCanonical AS receiptNo FROM Receipt WHERE id = ? FOR UPDATE',
            [id],
        );
        const receipt: any = lockRows[0];
        if (!receipt) {
            await conn.rollback();
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }

        const parsedDataIsString = typeof receipt.parsedData === 'string';
        let parsed: any;
        try {
            parsed = parsedDataIsString ? JSON.parse(receipt.parsedData) : receipt.parsedData;
        } catch {
            await conn.rollback();
            res.status(500).json({ error: 'Malformed parsedData' });
            return;
        }
        if (!parsed || typeof parsed !== 'object') {
            await conn.rollback();
            res.status(500).json({ error: 'Malformed parsedData' });
            return;
        }

        parsed.header = parsed.header ?? {};
        parsed.footer = parsed.footer ?? {};
        if (headerLineRegions.length > 0) parsed.header.lineRegions = headerLineRegions;
        if (footerLineRegions.length > 0) parsed.footer.lineRegions = footerLineRegions;

        // Value + identity fields. The client only sends these when
        // its local re-parse produced a value (REGIONS_VERSION bump
        // triggered fresh parsing). Mirroring the mobile rule: when
        // a value arrives, treat it as authoritative and overwrite
        // any stale persisted value. This fixes:
        //   • Receipts whose earlier parser revision stored a wrong
        //     total (e.g. OCR-mangled Mokėti row → null fallback).
        //   • Receipts pointing to a swapped image — common with the
        //     dev batch tool, which can create multiple rows with
        //     colliding filePath but different parsedData. Re-parsing
        //     the actual image and persisting receiptNo/date/time
        //     converges the row back to what the image shows.
        // We leave a field alone when the client omits it (parser
        // couldn't produce a value — preserves DB state).
        const reqTotal = req.body?.total;
        const reqSavings = req.body?.totalSavings;
        const reqReceiptNo = req.body?.receiptNo;
        const reqDate = req.body?.date;
        const reqTime = req.body?.time;
        if (typeof reqTotal === 'number' && Number.isFinite(reqTotal)) {
            parsed.footer.total = reqTotal;
        }
        if (typeof reqSavings === 'number' && Number.isFinite(reqSavings)) {
            parsed.footer.totalSavings = reqSavings;
        }
        // Identity fields capped at 50 chars — both to stop an abusive client injecting unbounded
        // text AND to match receiptNoCanonical VARCHAR(50): a longer receiptNos[0] would truncate in
        // the generated column and break the receiptNos[0] === receiptNoCanonical invariant. Empty
        // strings reject so a failed-parse field isn't clobbered.
        const isOkString = (s: any): s is string =>
            typeof s === 'string' && s.length > 0 && s.length <= 50;
        if (isOkString(reqReceiptNo)) {
            parsed.footer.receiptNo = reqReceiptNo;
        }
        // The re-parse may find MORE identifiers than the original (e.g. an earlier parser revision
        // captured only "Kvito Nr."; the new one also reads "Kvitas"/"Kvito numeris"). Take the
        // client's fresh array as authoritative so the receiptNos column converges to the full set
        // instead of staying stuck on the stale stored value (receipt-143).
        const reqReceiptNos: string[] = Array.isArray(req.body?.receiptNos)
            ? req.body.receiptNos.filter((v: unknown): v is string => isOkString(v)).map((v: string) => v.trim())
            : [];
        if (reqReceiptNos.length > 0) {
            parsed.footer.receiptNos = reqReceiptNos;
        }
        if (isOkString(reqDate)) {
            parsed.footer.date = reqDate;
        }
        if (isOkString(reqTime)) {
            parsed.footer.time = reqTime;
        }

        // Stamp the parser revision so the mobile client can detect
        // when persisted bands came from an outdated parser and force
        // another re-OCR. Accepts any short string; mobile owns the
        // comparison logic (this endpoint just stores opaquely).
        const versionRaw = req.body?.regionsVersion;
        if (typeof versionRaw === 'string' && versionRaw.length > 0 && versionRaw.length <= 32) {
            parsed.header.regionsVersion = versionRaw;
        }

        // Keep the receiptNos column (the functional, recovery-read identifier set) in lockstep with
        // the corrected footer, so a re-parsed receipt number is still recovery-matchable (recovery
        // reads the column, not this blob). The canonical id (the generated receiptNoCanonical = the
        // UNIQUE dedup key, surfaced here as receipt.receiptNo via the model alias) is kept PINNED as
        // receiptNos[0], so the re-parse folds in the new ids WITHOUT changing identity.
        const idPool: string[] = [
            ...(Array.isArray(parsed.footer.receiptNos)
                ? parsed.footer.receiptNos.filter((v: unknown): v is string => typeof v === 'string')
                : []),
            typeof parsed.footer.receiptNo === 'string' ? parsed.footer.receiptNo : '',
        ].filter(Boolean);
        const recomputedReceiptNos = normalizeReceiptNos(idPool, normalizeReceiptNo(receipt.receiptNo ?? null));
        parsed.footer.receiptNos = recomputedReceiptNos;

        try {
            await conn.query(
                'UPDATE Receipt SET parsedData = ?, receiptNos = ? WHERE id = ?',
                [JSON.stringify(parsed), recomputedReceiptNos.length ? JSON.stringify(recomputedReceiptNos) : null, id],
            );
        } catch (e: any) {
            // Writing receiptNos changes the generated canonical (the dedup key). It's pinned to the
            // existing canonical, so it only moves for a row that had NONE — and a re-parse could then
            // mint an id that collides with another receipt. A regions edit must never change identity:
            // keep the stored receiptNos and persist only the corrected bands/parse.
            if (e?.code === 'ER_DUP_ENTRY' && /unique_receipt/i.test(String(e?.sqlMessage ?? ''))) {
                let stored: string[] = [];
                try { const a = JSON.parse(receipt.receiptNos ?? 'null'); if (Array.isArray(a)) stored = a.map(String); } catch { /* leave [] */ }
                parsed.footer.receiptNos = stored;
                console.warn(`[regions] receiptNos change for receipt ${id} would collide on unique_receipt — kept existing identity, persisted parsedData only`);
                await conn.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(parsed), id]);
            } else {
                throw e;
            }
        }
        await conn.commit();
        committed = true;
        res.json({ id, ok: true });
        } catch (txErr) {
            if (!committed) { try { await conn.rollback(); } catch { /* already gone */ } }
            throw txErr;
        } finally {
            conn.release();
        }
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptComparison = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        // Optional `?maxDistanceKm=N` — clamped to [0, 200] to defend
        // against pathological values. Service applies its own default
        // when omitted.
        const rawMax = req.query.maxDistanceKm;
        const maxDistanceKm =
            typeof rawMax === 'string' && rawMax.trim() !== '' && Number.isFinite(Number(rawMax))
                ? Math.min(200, Math.max(0, Number(rawMax)))
                : undefined;

        const comparison = await getReceiptComparison(id, { maxDistanceKm });
        res.json(comparison);
    } catch (error: any) {
        if (error?.statusCode === 404) {
            res.status(404).json({ error: error.message });
            return;
        }
        if (error?.statusCode === 400) {
            res.status(400).json({ error: error.message });
            return;
        }
        next(error);
    }
};

/**
 * Build the swipe queue for a receipt: for each line that has at least one
 * candidate, pair the OCR-side info (pulled from parsedData) with the matcher
 * candidates (joined with StoreProduct + StoreChain). Items are ordered by
 * ascending top-candidate matchScore so the user sees the lowest-confidence
 * pairs first — that's where their judgement matters most.
 */
export const fetchReceiptSwipeQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const userId = req.authUserId ?? null; // token subject; owns-check already passed

        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }

        const parsedData =
            typeof receipt.parsedData === 'string'
                ? JSON.parse(receipt.parsedData)
                : receipt.parsedData;
        const parsedProducts: any[] = Array.isArray(parsedData?.products)
            ? parsedData.products
            : [];

        // Collect SP IDs present in this receipt for the re-verification lookup.
        const receiptSpIds = parsedProducts
            .map((p: any) => Number(p.storeProductId))
            .filter((spId: number) => spId > 0);

        const [flat, votedPairs, verifiedSpIds, reverificationPairs] = await Promise.all([
            getSwipeCandidatesWithDetails(id),
            // Cards the user has already acted on shouldn't appear again.
            //  - Cross-SP pairs (line.SP ≠ candidate.SP): skip when a
            //    StoreProductMatchVote exists for (userId, sortedPair).
            //  - Self-pairs (line.SP = candidate.SP): read the live
            //    Price.priceVerified from the DB — the parsed JSON isn't the
            //    source of truth once swipes start flipping the Price column.
            userId ? getVotedPairKeysForUser(userId) : Promise.resolve(new Set<string>()),
            userId ? getVerifiedStoreProductIdsForReceipt(id) : Promise.resolve(new Set<number>()),
            // Re-verification exception: pairs flagged after a global demotion
            // are re-surfaced even though the user has already voted on them.
            userId && receiptSpIds.length > 0
                ? getReverificationPairKeysForReceipt(userId, receiptSpIds)
                : Promise.resolve(new Set<string>()),
        ]);

        const items = buildSwipeQueue(
            flat,
            parsedProducts,
            userId ? votedPairs : new Set<string>(),
            userId ? verifiedSpIds : new Set<number>(),
            userId ? reverificationPairs : new Set<string>(),
        );

        res.json({ receiptId: id, items });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/receipts/:id/lines/:idx/report-issue
 * Body: { userId, flags: {name, price, amount, discount}, note? }
 *
 * User-facing flag for a suspect receipt line. Writes / updates a row in
 * ReceiptLineIssue and marks the line's Price as unverified so it stops
 * feeding trusted totals until admin resolves.
 */
export const reportReceiptLineIssue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        const lineIdx = Number(req.params.idx);
        if (isNaN(receiptId) || isNaN(lineIdx) || lineIdx < 0) {
            res.status(400).json({ error: 'Invalid receipt id or line index' });
            return;
        }
        const { flags, note } = req.body ?? {};
        const userId = req.authUserId; // token subject; owns-check already passed
        if (!userId || typeof userId !== 'string') {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        if (!flags || typeof flags !== 'object') {
            res.status(400).json({ error: 'flags object is required' });
            return;
        }
        const parsedFlags: IssueFlags = {
            name: !!flags.name,
            price: !!flags.price,
            amount: !!flags.amount,
            discount: !!flags.discount,
            image: !!flags.image,
        };
        if (
            !parsedFlags.name &&
            !parsedFlags.price &&
            !parsedFlags.amount &&
            !parsedFlags.discount &&
            !parsedFlags.image
        ) {
            res.status(400).json({ error: 'At least one flag must be true' });
            return;
        }

        const flaggedCount = await upsertReceiptLineIssue(
            receiptId,
            lineIdx,
            userId,
            parsedFlags,
            typeof note === 'string' ? note.slice(0, 500) : null
        );

        // Resolve the line's storeProductId from parsedData so we can flip
        // priceVerified. Silent-no-op if there's no resolved SP (pre-C2a or
        // chain-unrecognized receipt).
        const receipt = await getReceiptById(receiptId);
        const parsedData =
            receipt && typeof receipt.parsedData === 'string'
                ? JSON.parse(receipt.parsedData)
                : receipt?.parsedData;
        const linePRaw = parsedData?.products?.[lineIdx]?.storeProductId;
        const lineSpId = Number.isFinite(linePRaw) ? Number(linePRaw) : null;
        if (lineSpId !== null) {
            await unverifyReceiptLinePrice(receiptId, lineSpId);
        }

        res.json({ ok: true, flaggedCount });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/receipts/:id/lines/:idx/reject-match
 *
 * Direct "this isn't the right product" rejection of a line's own match (the
 * self-pair gesture from the Items tab menu). Demotes the line — re-points it to
 * a same-chain runner-up altMatch (≥ auto-apply) or clears it to the OCR name with
 * a userRejected confidence veto — and returns the mutated line so the app can
 * update that row in place. Idempotent-ish: a line with no resolved SP returns
 * `demoted:false`.
 */
export const rejectReceiptLineMatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        const lineIdx = Number(req.params.idx);
        if (isNaN(receiptId) || isNaN(lineIdx) || lineIdx < 0) {
            res.status(400).json({ error: 'Invalid receipt id or line index' });
            return;
        }
        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            const line = await demoteReceiptLineDirect(receiptId, lineIdx, conn);
            await conn.commit();
            res.json({ ok: true, demoted: !!line, line: line ?? null });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/receipts/:id/lines/:idx/vote
 *   body: { vote: 'identical'|'similar'|'different', proposedSpId?: number }
 *
 * A Card-B swipe on a receipt line: identical → confirm + price-verify; similar →
 * keep product, flag variant, price unverified; different → demote. Records the
 * line resolved in the ledger (one shot) and returns the mutated line so the app
 * patches the row in place.
 *
 * `proposedSpId` (PROPOSED cards only — an UNLINKED line whose card showed the best
 * altMatches candidate): identical LINKS that SP to the line, different/similar
 * record the alias verdict without touching the line. The id is validated server-
 * side against the line's stored altMatches + the receipt's chain — a client can
 * never link an arbitrary SP.
 */
export const submitReceiptLineVote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        const lineIdx = Number(req.params.idx);
        const vote = req.body?.vote;
        const proposedSpId = Number.isFinite(Number(req.body?.proposedSpId)) && Number(req.body?.proposedSpId) > 0
            ? Number(req.body.proposedSpId)
            : null;
        // Used by the vocabulary capture (Issue H) to attribute the alias confirmation to
        // a distinct user (the K-user auto-promote). From the token subject, not the body.
        const userId = req.authUserId;
        if (isNaN(receiptId) || isNaN(lineIdx) || lineIdx < 0) {
            res.status(400).json({ error: 'Invalid receipt id or line index' });
            return;
        }
        if (vote !== 'identical' && vote !== 'similar' && vote !== 'different') {
            res.status(400).json({ error: 'vote must be identical, similar, or different' });
            return;
        }
        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            const line = await castReceiptLineVote(receiptId, lineIdx, vote, conn, userId, proposedSpId);
            await markLineResolved(receiptId, lineIdx, 'user', vote, conn);
            await conn.commit();
            res.json({ ok: true, line: line ?? null });
            // A line-mutating vote (link OR demote) changes the cross-store comparison —
            // recompute the FROZEN ReceiptComparisonSnapshot so Sutaupyta + Planavimas
            // (storeChoice) adapt to the new knowledge. Fire-and-forget + idempotent; it
            // re-reads getReceiptById which already reflects the just-committed link, and
            // it covers the VOLUNTARY path (which never calls /complete-swipes).
            if (line) void snapshotReceiptComparison(receiptId).catch((e) =>
                console.warn(`[vote] snapshot recompute failed r${receiptId}:`, (e as Error)?.message));
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/receipts/:id/resolve-queue
 *
 * The MANDATORY post-scan "fix your receipt" cards (Card B) — the few highest
 * needs-human uncertain lines that aren't already asked/resolved.
 *
 * PURE READ (idempotent). Serving must NOT mutate the ledger: the client's
 * loadQueue re-runs on [sessionNum, receiptIdx], on remount, and twice under
 * React StrictMode — if the GET marked lines 'asked', the SECOND fetch would
 * find them already asked and return ZERO cards, so the user's own cards would
 * silently vanish mid-session ("cards not showing up"). The terminal ask-once
 * write now lives in POST /complete-swipes (markSwipesDone) and the per-line
 * vote (markLineResolved), i.e. on a real user action, not on a read.
 * See shared/SWIPE_QUEUE_REDESIGN.md.
 */
export const getReceiptResolveQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        if (isNaN(receiptId)) {
            res.status(400).json({ error: 'Invalid receipt id' });
            return;
        }
        // Voluntary "Help identify products" requests more cards via ?max=N.
        const maxRaw = Number(req.query.max);
        const limit = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 20) : undefined;
        const { cards, image } = await buildReceiptResolveCards(receiptId, pool, limit);
        res.json({ receiptId, cards, image });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/receipts/log-fail
 *
 * Append a FailedReceiptLog row. Called by the mobile Analize flow
 * when it bails out BEFORE creating a Receipt (OCR produced nothing,
 * chain couldn't be detected, or store lookup failed). Purposely
 * lightweight — no FK checks, no cleanup logic. Lets us answer the
 * "random receipt vs OCR missed" question without polluting Receipt.
 *
 * Validates `failReason` against the ENUM; everything else passes
 * through with length caps in the model.
 */
const VALID_FAIL_REASONS: ReadonlySet<FailReason> = new Set([
    'ocr_no_text',
    'ocr_error',
    'chain_unrecognized',
    'store_unrecognized',
    'parse_failed',
    'mask_failed',
    'no_products',
    'doubled_scan',
]);

export const logAnalizeFailure = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const {
            userId,
            failReason,
            ocrLineCount,
            ocrPreview,
            detectedChainName,
            extractedStoreAddress,
            imageFilePath,
            failedBucketPath,
            shoppingListId,
            parsedData,
        } = req.body ?? {};

        if (!failReason || !VALID_FAIL_REASONS.has(failReason)) {
            res.status(400).json({
                error: `failReason must be one of ${[...VALID_FAIL_REASONS].join(', ')}`,
            });
            return;
        }

        const cleanChain =
            typeof detectedChainName === 'string' ? detectedChainName.slice(0, 64) : null;
        const cleanAddress =
            typeof extractedStoreAddress === 'string' ? extractedStoreAddress.slice(0, 255) : null;

        const id = await logFailedReceipt({
            userId: typeof userId === 'string' && userId.trim() ? userId.trim() : null,
            failReason,
            ocrLineCount: Number.isFinite(ocrLineCount) ? Number(ocrLineCount) : null,
            ocrPreview: typeof ocrPreview === 'string' ? ocrPreview : null,
            detectedChainName: cleanChain,
            extractedStoreAddress: cleanAddress,
            imageFilePath:
                typeof imageFilePath === 'string' ? imageFilePath.slice(0, 512) : null,
            failedBucketPath:
                typeof failedBucketPath === 'string' ? failedBucketPath.slice(0, 512) : null,
            shoppingListId: Number.isFinite(shoppingListId) ? Number(shoppingListId) : null,
            parsedData:
                parsedData == null
                    ? null
                    : typeof parsedData === 'string'
                        ? parsedData
                        : JSON.stringify(parsedData),
        });

        // Telegram cadence by env: staging = immediate per failure; dev =
        // silent; production = rolled into the 20:00 digest (not here).
        if (resolveEnv() === 'staging') {
            notifyTelegram(
                `⚠️ <b>Nepavyko apdoroti kvito</b>\n` +
                `Priežastis: <code>${failReason}</code>` +
                (cleanChain ? `\nTinklas: ${cleanChain}` : '') +
                (cleanAddress ? `\nAdresas: ${cleanAddress}` : ''),
            ).catch((e) => console.warn('[logAnalizeFailure] telegram failed:', e?.message ?? e));
        }

        res.status(201).json({ id });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/receipts/reocr-telemetry
 *
 * Lightweight, fire-and-forget endpoint for the on-device product re-OCR pass
 * (souply-app utils/productReocr*). The mobile client reports each pass's
 * accept/reject decision plus the garbage/reconciliation deltas so we can watch,
 * in aggregate, whether on-device re-OCR is helping or regressing once the
 * `PRODUCT_REOCR_ENABLED` flag is flipped. Deliberately NO DB write — just a
 * single structured server log line (grep-able / aggregatable). Always 204.
 */
export const logReocrTelemetry = async (req: Request, res: Response) => {
    const { receiptNo, accepted, detail } = req.body ?? {};
    console.log(
        '[reocr-telemetry]',
        JSON.stringify({
            receiptNo: typeof receiptNo === 'string' ? receiptNo.slice(0, 64) : null,
            accepted: !!accepted,
            detail: typeof detail === 'string' ? detail.slice(0, 200) : null,
        }),
    );
    res.status(204).end();
};

/**
 * GET /api/receipts/:id/mandatory-queue
 *
 * ONE-SHOT mandatory swipe session: Card-B resolve cards + receipt-anchored pair
 * cards + relatedTo top-up + Slot-2c orphan backfill, assembled server-side (see
 * mandatoryQueueService). Replaces the client's four sequential requests. Served
 * from the save-time snapshot when fresh (revalidated against the vote/resolution
 * ledgers), built live otherwise.
 */
export const fetchMandatoryQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        const userId = req.authUserId;
        if (isNaN(receiptId) || !userId) {
            res.status(400).json({ error: 'Invalid receipt id' });
            return;
        }
        const { cards, image, slotCounts, fromSnapshot } = await getMandatoryQueue(userId, receiptId, req.locale);
        res.json({ receiptId, cards, image, slotCounts, fromSnapshot });
    } catch (error) {
        next(error);
    }
};

// ── RETAKE / HEAL ─────────────────────────────────────────────────────────────
// POST /receipts/:id/heal — a retake is a SECOND observation of the SAME receipt.
// The app re-runs the on-device OCR+parse+match and posts the candidate parse; we
// align it against the stored lines and heal (best-of, never-downgrade), then
// replace the item set in place — kept lines stay identical (their SP survives),
// only healed/inserted lines re-swipe. Different receipt → 409 (client offers a
// full replace). Owner-gated by the `owns` middleware on the route.

const lineTotalOf = (l: any): number => {
    const unit = (l?.promoPrice != null && Number(l.promoPrice) > 0) ? Number(l.promoPrice) : Number(l?.price);
    return (Number.isFinite(unit) ? unit : 0) * (Number(l?.quantity) > 0 ? Number(l.quantity) : 1);
};
const confScore = (ic: any): number => {
    if (ic == null) return 0.5;
    if (typeof ic === 'number') return ic;
    if (typeof ic === 'object' && typeof ic.score === 'number') return ic.score;
    return 0.5;
};
const toHealLine = (l: any): HealLine<any> => ({
    price: lineTotalOf(l),
    quantity: Number(l?.quantity) > 0 ? Number(l.quantity) : 1,
    name: typeof l?.name === 'string' ? l.name : '',
    matched: l?.storeProductId != null && Number(l.storeProductId) > 0,
    confirmed: !!l?.matchConfirmed,
    confidence: confScore(l?.itemConfidence),
    implausible: !!l?.priceImplausible,
    ref: l,
});

export const healReceiptFromRetake = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        const parsedData = req.body?.parsedData;
        const newFilePath = typeof req.body?.filePath === 'string' && req.body.filePath ? req.body.filePath : null;
        // The client uploads the retake IMAGE separately (after this call), so it
        // signals here that the stored image is being replaced → adopt the retake's
        // geometry (regions/dims) so the bands + crops line up with the new photo.
        const swapImage = req.body?.swapImage === true || newFilePath != null;
        if (!Number.isFinite(receiptId) || !parsedData) { res.status(400).json({ error: 'receiptId and parsedData required' }); return; }

        const [[receipt]]: any = await pool.query('SELECT id, parsedData, filePath FROM Receipt WHERE id = ?', [receiptId]);
        if (!receipt) { res.status(404).json({ error: 'not found' }); return; }
        const existingParsed = typeof receipt.parsedData === 'string' ? JSON.parse(receipt.parsedData) : (receipt.parsedData ?? {});

        // Same-receipt guard — a retake of a DIFFERENT receipt aborts (→ full replace).
        const numOrNull = (v: any): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
        const identity = (pd: any) => ({
            chainId: numOrNull(pd?.header?.chainId),
            receiptNo: pd?.footer?.receiptNo != null ? String(pd.footer.receiptNo) : null,
            // ALL printed id forms — so a retake that garbled one form still matches on another.
            receiptNos: Array.isArray(pd?.footer?.receiptNos)
                ? pd.footer.receiptNos.filter((v: any) => typeof v === 'string')
                : null,
            date: pd?.footer?.date != null ? String(pd.footer.date) : null,
            total: numOrNull(pd?.footer?.total),
        });
        if (!isSameReceipt(identity(existingParsed), identity(parsedData))) {
            res.status(409).json({ error: 'different-receipt' });
            return;
        }

        const existingLines = await getReceiptItemLines(receiptId);
        const candidateLines: any[] = Array.isArray(parsedData.products) ? parsedData.products : [];
        const total = numOrNull(existingParsed?.footer?.total);
        const plan = computeHealPlan(existingLines.map(toHealLine), candidateLines.map(toHealLine), total);

        // No improvement → touch nothing (don't reset the user's completed swipes).
        if (plan.healedCount === 0 && plan.insertedCount === 0) {
            // No line improvement → leave the ITEMS (and completed swipes) untouched.
            // A retake still delivers fresh reproducibility geometry the stored blob
            // may lack: `wordsDump` (the off-device reparse input). Persist it into
            // parsedData ONLY (never the products/items) so a same-parse retake still
            // makes the receipt reparseable — the interactive scan stores wordsDump,
            // but a queue/heal receipt otherwise never gets one.
            const candWd = (parsedData as any)?.wordsDump;
            let wordsDumpStored = false;
            if (candWd != null && JSON.stringify(existingParsed?.wordsDump ?? null) !== JSON.stringify(candWd)) {
                const nextParsed = { ...existingParsed, wordsDump: candWd };
                await pool.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(nextParsed), receiptId]);
                wordsDumpStored = true;
            }
            res.json({ changed: false, healed: 0, inserted: 0, kept: plan.keptCount, wordsDumpStored });
            return;
        }

        // Splice the healed line set from the two parsed-line lists.
        const healedLines = plan.lines.map((pl) => {
            if (pl.op === 'inserted') return { ...(pl.candidate!.ref as any) };
            const base: any = { ...(pl.existing!.ref as any) };
            // The stored image becomes the RETAKE photo, so a line's crop geometry
            // must come from the retake (candidate) — keeping the OLD region would
            // crop the new image at stale coordinates. (Retake-missed lines have no
            // candidate → keep the old region; they're rare.)
            if (pl.candidate?.ref) {
                const c: any = pl.candidate.ref;
                base.region = c.region ?? base.region;
                base.rawLines = c.rawLines ?? base.rawLines;
            }
            if (pl.op !== 'healed') return base;
            base.name = pl.name;
            if (pl.takeCandidatePrice && pl.candidate?.ref) {
                const c: any = pl.candidate.ref;
                base.price = c.price; base.promoPrice = c.promoPrice; base.quantity = c.quantity;
                base.unit = c.unit; base.pricePerUnit = c.pricePerUnit; base.amount = c.amount; base.sizeUnit = c.sizeUnit;
                base.priceImplausible = false;
            }
            if (pl.takeCandidateMatch && pl.candidate?.ref) {
                const c: any = pl.candidate.ref;
                base.storeProductId = c.storeProductId;
                base.matchedName = c.matchedName;
                base.storeProductImageUrl = c.storeProductImageUrl;
                base.matchConfidence = c.matchConfidence;
                base.categoryId = c.categoryId; base.categoryName = c.categoryName; base.categoryL2Name = c.categoryL2Name;
                base.itemConfidence = c.itemConfidence; base.altMatches = c.altMatches;
                base.matchSource = 'heal';
                base.matchConfirmed = false; // healed match must be re-verified
            }
            return base;
        });

        // RE-MATCH unmatched lines against the CURRENT server catalogue. The
        // original scan matched against a staler catalogue / worse OCR, leaving
        // altMatches empty — so nothing could auto-apply AND the voluntary crop
        // queue had no candidate to offer. This re-runs the SAME matcher the scan
        // uses (findBestProductMatches): confident same-chain hits auto-apply, the
        // rest get populated altMatches (→ crop cards) + kept surface-eligible (S3).
        const rematchChainId = numOrNull(existingParsed?.header?.chainId);
        let rematched = 0;
        if (rematchChainId != null) {
            try {
                const cands = await getCachedChainCandidates(rematchChainId, req.locale);
                const autoApply = RECOGNITION.match.autoApplyThreshold;
                for (const line of healedLines) {
                    const nm = String(line.name ?? '');
                    if (line.storeProductId != null && Number(line.storeProductId) > 0) {
                        // Already matched (kept/heal). Recompute a band-less confidence
                        // (heal-applied lines were persisted without a computed band);
                        // leave good ones untouched so a confirmed line isn't disturbed.
                        const ic: any = line.itemConfidence;
                        if (nm && (!ic || typeof ic.band !== 'string')) {
                            line.itemConfidence = computeItemConfidence({
                                nameConf: Number(line.matchConfidence) || 0.9, nameText: nm,
                                priceVerified: !!line.priceVerified, viaPromo: false, gapToRunnerUp: 0,
                                source: 'reused', priceImplausible: !!line.priceImplausible,
                                userConfirmed: !!line.matchConfirmed,
                            });
                        }
                        continue;
                    }
                    if (!nm) continue;
                    let ms = findBestProductMatches(nm, null, line.unit ?? null, cands, undefined, undefined, !!line.isWeighable);
                    let crossChain = false;
                    if (ms.length === 0) {
                        const xc = await getCachedCrossChainCandidates(rematchChainId, req.locale);
                        ms = findBestProductMatches(nm, null, line.unit ?? null, xc, RECOGNITION.match.minConfidenceCrossChain, undefined, !!line.isWeighable);
                        crossChain = ms.length > 0;
                    }
                    // Store candidates (strip the big image urls — never rendered from altMatches).
                    line.altMatches = ms.map((m: any) => { const { imageUrl: _drop, ...rest } = m; return rest; });
                    const gap = ms.length >= 2 ? ms[0].confidence - ms[1].confidence : 0;
                    if (ms.length > 0 && ms[0].confidence >= autoApply && !crossChain) {
                        const top: any = ms[0];
                        line.storeProductId = top.storeProductId;
                        line.matchedName = top.name;
                        line.matchConfidence = top.confidence;
                        line.matchConfirmed = false;
                        line.matchSource = 'heal-rematch';
                        // Consistent confidence for a matched line — no stale unmatched veto.
                        line.itemConfidence = computeItemConfidence({
                            nameConf: top.confidence, nameText: nm, priceVerified: false, viaPromo: false,
                            gapToRunnerUp: gap, source: 'reused', priceImplausible: !!line.priceImplausible,
                        });
                        rematched++;
                    } else {
                        // Unmatched (candidates or none) → a clean 'unmatched' confidence
                        // (band S3 + the honest veto) so a crop card can still surface it.
                        line.itemConfidence = computeItemConfidence({
                            nameConf: ms.length > 0 ? ms[0].confidence : 0, nameText: nm, priceVerified: false,
                            viaPromo: false, gapToRunnerUp: gap, source: 'unmatched', priceImplausible: !!line.priceImplausible,
                        });
                    }
                }
            } catch (e) {
                console.warn(`[heal] re-match failed for receipt ${receiptId}:`, (e as Error)?.message);
            }
        }

        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            await replaceReceiptItems(receiptId, healedLines, conn);
            // NB: mandatory swipes are NOT reset — that would re-lock the stats and
            // bounce the user into a fresh swipe flow. Healed lines that are still
            // uncertain surface through the voluntary "identify products" queue.
            // GEOMETRY comes from the RETAKE parse: the stored image is now the
            // retake photo, so header/footer band regions (address, PVM, date, time,
            // total, receipt-no) + the image dims + product crops must all come from
            // the candidate — keeping the OLD regions draws every band at stale
            // coordinates (shifted overlays / crops "between products"). We keep only
            // the TRUSTED identity VALUES (they cleared the capture gate). No new image
            // → keep the existing geometry (nothing was swapped).
            const mergedParsed = !swapImage
                ? { ...existingParsed, products: healedLines }
                : {
                    ...parsedData, // retake: header, image, footer.lineRegions
                    footer: {
                        ...(parsedData?.footer ?? {}),
                        receiptNo: existingParsed?.footer?.receiptNo ?? parsedData?.footer?.receiptNo,
                        receiptNos: existingParsed?.footer?.receiptNos ?? parsedData?.footer?.receiptNos,
                        date: existingParsed?.footer?.date ?? parsedData?.footer?.date,
                        time: existingParsed?.footer?.time ?? parsedData?.footer?.time,
                        total: existingParsed?.footer?.total ?? parsedData?.footer?.total,
                        totalSavings: existingParsed?.footer?.totalSavings ?? parsedData?.footer?.totalSavings,
                    },
                    products: healedLines,
                };
            const params: any[] = [JSON.stringify(mergedParsed)];
            let sql = 'UPDATE Receipt SET parsedData = ?';
            if (newFilePath) { sql += ', filePath = ?'; params.push(newFilePath); }
            sql += ' WHERE id = ?'; params.push(receiptId);
            await conn.query(sql, params);
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        // Re-freeze the cross-store comparison against the healed line set.
        snapshotReceiptComparison(receiptId).catch((e) =>
            console.warn(`[heal] snapshot recompute failed for receipt ${receiptId}:`, (e as Error)?.message));

        res.json({
            changed: true,
            healed: plan.healedCount,
            inserted: plan.insertedCount,
            kept: plan.keptCount,
            rematched,
        });
    } catch (error) { next(error); }
};

// POST /receipts/:id/dev-replace — DEV-ONLY full re-parse REPLACE.
// The retake/heal endpoint above MERGES conservatively (keeps existing plausible line values), so a
// parser change that only CORRECTS an already-priced line (e.g. removing a phantom discount) never
// surfaces on an already-stored receipt. This endpoint overwrites the receipt's lines + blob
// ENTIRELY with the fresh parse, so the dev re-run button can verify parser changes on the cached
// photo. Refused in production (like the dev hard-purge) so it can never clobber a real receipt.
export const devReplaceReceiptParse = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (process.env.NODE_ENV === 'production') { res.status(403).json({ error: 'dev-only' }); return; }
        const receiptId = Number(req.params.id);
        const parsedData = req.body?.parsedData;
        if (!Number.isFinite(receiptId) || !parsedData) { res.status(400).json({ error: 'receiptId and parsedData required' }); return; }
        const [[receipt]]: any = await pool.query('SELECT id FROM Receipt WHERE id = ?', [receiptId]);
        if (!receipt) { res.status(404).json({ error: 'not found' }); return; }

        const products = Array.isArray(parsedData.products) ? parsedData.products : [];
        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            await replaceReceiptItems(receiptId, products, conn);
            // Overwrite the whole blob so wordsDump/footer/header/regions match the fresh parse
            // (products[] are re-derived from ReceiptItem on read, per the ReceiptItem migration).
            await conn.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(parsedData), receiptId]);
            await conn.commit();
        } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

        snapshotReceiptComparison(receiptId).catch((e) =>
            console.warn(`[dev-replace] snapshot recompute failed for receipt ${receiptId}:`, (e as Error)?.message));

        res.json({ changed: true, replaced: products.length });
    } catch (error) { next(error); }
};
