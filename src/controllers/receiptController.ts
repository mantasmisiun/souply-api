import { Request, Response, NextFunction } from "express";
import { ensureTripForReceipt } from '../services/tripLinkService.js';
import sharp from "sharp";
import pool from "../config/db.js";
import { isTripMember } from "../models/tripModel.js";
import { createReceipt, getReceiptsByUserId, getReceiptById, deleteReceipt, getReceiptItemsWithDetails, updateReceiptFilePath, getReceiptByReceiptNoAndUser, getReceiptByAnyReceiptNoAndUser, getReceiptByAnyReceiptNoStoreDate, completeMandatorySwipes } from "../models/receiptModel.js";
import {
    getSwipeCandidatesWithDetails,
    getVerifiedStoreProductIdsForReceipt,
    getVotedPairKeysForUser,
} from "../models/receiptSwipeCandidateModel.js";
import { buildSwipeQueue } from "../services/swipeQueueService.js";
import { getMandatoryQueue } from "../services/mandatoryQueueService.js";
import { normalizeReceiptNo, normalizeReceiptNos } from "../utils/receiptMetadata.js";
import { getReverificationPairKeysForReceipt } from "../models/userEquivalenceModel.js";
import {
    unverifyReceiptLinePrice,
    upsertReceiptLineIssue,
    type IssueFlags,
} from "../models/receiptLineIssueModel.js";
import { getPresignedUrl } from "../services/storageService.js";
import { persistReceiptPrices, applyReceiptAutosave } from '../services/receiptSaveService.js';
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
        await completeMandatorySwipes(id);
        // Terminal ask-once: the resolve-queue Card-B lines offered this session that
        // the user did NOT resolve (a vote marks them resolved_user at the /vote path)
        // are recorded 'asked' now, so future sessions don't re-nag them. This is the
        // ledger write that USED to live on the resolve-queue GET — moved here (a real
        // completion event) so serving the queue stays idempotent and re-fetches never
        // delete the user's cards mid-session. Fail-soft: a ledger hiccup must not fail
        // the completion the client already acted on.
        try {
            const conn = await (pool as any).getConnection();
            try {
                await conn.beginTransaction();
                await markServedResolveLinesAsked(id, conn);
                await conn.commit();
            } catch (e) {
                await conn.rollback();
                throw e;
            } finally {
                conn.release();
            }
        } catch (ledgerErr) {
            console.warn(`[markSwipesDone] ask-once ledger write failed for receipt ${id}:`, ledgerErr);
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
