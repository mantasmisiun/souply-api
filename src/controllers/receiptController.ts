import { Request, Response, NextFunction } from "express";
import pool from "../config/db.js";
import { createReceipt, getReceiptsByUserId, getReceiptById, deleteReceipt, getReceiptItemsWithDetails, updateReceiptFilePath, getReceiptByReceiptNoAndUser, completeMandatorySwipes } from "../models/receiptModel.js";
import {
    getSwipeCandidatesWithDetails,
    getVerifiedStoreProductIdsForReceipt,
    getVotedPairKeysForUser,
} from "../models/receiptSwipeCandidateModel.js";
import { buildSwipeQueue } from "../services/swipeQueueService.js";
import { getReverificationPairKeysForReceipt } from "../models/userEquivalenceModel.js";
import {
    unverifyReceiptLinePrice,
    upsertReceiptLineIssue,
    type IssueFlags,
} from "../models/receiptLineIssueModel.js";
import { getPresignedUrl } from "../services/storageService.js";
import { persistReceiptPrices } from '../services/receiptSaveService.js';
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

export const removeReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        await deleteReceipt(id);
        res.status(204).send();
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
        const url = await getPresignedUrl(receipt.filePath);
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
        const { userId, filePath, fileType, parsedData } = req.body;
        if (!userId || !parsedData) {
            res.status(400).json({ error: 'userId and parsedData are required' });
            return;
        }
        // Reject duplicates early so re-photographing the same receipt doesn't
        // create parallel records. IKI synthesizes a `{date}-{time}-{cents}-iki-receipt`
        // number specifically so this check works when the receipt format has no
        // natural unique ID.
        const candidateReceiptNo = parsedData.footer?.receiptNo ?? null;
        if (candidateReceiptNo) {
            const existing = await getReceiptByReceiptNoAndUser(candidateReceiptNo, String(userId));
            if (existing) {
                res.status(409).json({
                    error: 'duplicate',
                    message: 'Receipt already uploaded',
                    existingReceiptId: existing.id,
                });
                return;
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
            const result = await persistReceiptPrices(receiptId, userId, parsedData, {
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
            }, true);
            res.status(201).json({ id: receiptId, ...result });
            // Fire-and-forget default-template regeneration. Runs after the
            // response has been sent so client-perceived latency is unaffected.
            // No-ops when the user doesn't qualify (< 3 receipts / < 2 chains)
            // or already has an autoUpdate=off default template — see
            // generateDefaultTemplate() for the full guard chain.
            generateDefaultTemplate(String(userId)).catch(e =>
                console.warn('[defaultTemplate] generation failed:', e?.message),
            );
        } catch (err: any) {
            if (err?.code === 'ER_DUP_ENTRY' && /unique_receipt/i.test(String(err?.sqlMessage ?? ''))) {
                // Best-effort cleanup of the orphaned Receipt row. Non-fatal
                // if it fails — FK cascade on Price catches residual Price
                // rows, and a stray empty Receipt row is harmless.
                try {
                    await deleteReceipt(receiptId);
                } catch (cleanupErr) {
                    console.warn('Failed to clean up orphan receipt', receiptId, cleanupErr);
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
        const { userId, parsedData } = req.body;
        if (isNaN(id) || !userId || !parsedData) {
            res.status(400).json({ error: 'Invalid id or missing userId/parsedData' });
            return;
        }

        try {
            const result = await persistReceiptPrices(id, userId, parsedData, {
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
            });
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
        const { convertPdfBufferToImagePages } = await import('../services/pdfService.js');
        const pages = await convertPdfBufferToImagePages(pdfBuffer);
        res.json({
            images: pages.map((b) => b.toString('base64')),
            mimeType: 'image/png',
        });
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

        const receipt: any = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }

        const parsedDataIsString = typeof receipt.parsedData === 'string';
        let parsed: any;
        try {
            parsed = parsedDataIsString ? JSON.parse(receipt.parsedData) : receipt.parsedData;
        } catch {
            res.status(500).json({ error: 'Malformed parsedData' });
            return;
        }
        if (!parsed || typeof parsed !== 'object') {
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
        // Identity fields capped at 64 chars to keep an abusive
        // client from injecting unbounded text. Empty strings reject
        // so the field doesn't get clobbered when the parser failed.
        const isOkString = (s: any): s is string =>
            typeof s === 'string' && s.length > 0 && s.length <= 64;
        if (isOkString(reqReceiptNo)) {
            parsed.footer.receiptNo = reqReceiptNo;
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

        await pool.query(
            'UPDATE Receipt SET parsedData = ? WHERE id = ?',
            [JSON.stringify(parsed), id],
        );
        res.json({ id, ok: true });
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
        const userId = typeof req.query.userId === 'string' ? req.query.userId : null;

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
        const { userId, flags, note } = req.body ?? {};
        if (!userId || typeof userId !== 'string') {
            res.status(400).json({ error: 'userId is required' });
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
