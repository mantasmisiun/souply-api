import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    pickFlagQueueKeys,
    hydrateFlagQueueRows,
    encodeFlagKey,
    decodeFlagKey,
    FlagPickKey,
} from '../models/adminFlagQueueModel.js';
import {
    claimSpIds,
    completeLease,
    releaseAdminBatch,
    getActiveLeasesForAdmin,
} from '../models/adminLeaseModel.js';
import { logAdminAction } from '../services/adminActionLog.js';

/**
 * Admin Flags-tab endpoints.
 *
 * Shape mirrors the image/amount controllers: claim-batch, release-batch,
 * confirm, dismiss, skip. The only structural twist is that the lease
 * table is keyed on a single bigint (`spId`) while a flag is identified
 * by `(receiptId, lineIdx)`. We pack the pair into one int with
 * `encodeFlagKey` / `decodeFlagKey` so the existing lease helpers don't
 * need a second column.
 *
 * Action endpoint contract:
 *   - The URL takes a `flagKey` of the form `${receiptId}-${lineIdx}`.
 *   - `confirm` applies optional SP-field edits, optional suspect marks
 *     for the receipt's Price row, then resolves every `ReceiptLineIssue`
 *     row matching the key (one card represents N users' complaints).
 *   - `dismiss` marks all matching rows as 'dismissed' — the admin
 *     reviewed and decided no changes were warranted.
 *   - `skip` leaves the issue rows as 'pending' but logs an audit row.
 *     The 90-day filter in the picker (see adminFlagQueueModel) keeps
 *     skipped cards out of the queue for 90 days; they resurface after.
 */

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;

const VALID_UNITS = new Set(['g', 'kg', 'ml', 'l', 'vnt', 'rit']);

function adminIdOf(req: Request): string {
    return String(req.headers['x-admin-id']);
}

/**
 * Parse `${receiptId}-${lineIdx}` from a URL param. Returns null on
 * malformed input so the caller can 400.
 */
function parseFlagKey(raw: string): FlagPickKey | null {
    const m = /^(\d+)-(\d+)$/.exec(raw);
    if (!m) return null;
    const receiptId = Number(m[1]);
    const lineIdx = Number(m[2]);
    if (!Number.isFinite(receiptId) || !Number.isFinite(lineIdx)) return null;
    return { receiptId, lineIdx };
}

// ── GET /api/admin/flags/queue ──────────────────────────────────────
export const getFlagQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const leases = await getActiveLeasesForAdmin(adminId, 'flag');
        const keys = leases.map(l => decodeFlagKey(l.spId));
        const rows = await hydrateFlagQueueRows(keys, (req as any).locale);
        res.json({ rows, leaseCount: leases.length });
    } catch (e) { next(e); }
};

// ── POST /api/admin/flags/claim-batch ───────────────────────────────
export const claimFlagBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const requested = Number((req.body as any)?.size ?? DEFAULT_BATCH_SIZE);
        const size = Math.max(1, Math.min(MAX_BATCH_SIZE,
            Number.isFinite(requested) ? requested : DEFAULT_BATCH_SIZE));

        // Resume existing batch if any. Same one-batch-at-a-time
        // contract as the image/amount queues.
        const existing = await getActiveLeasesForAdmin(adminId, 'flag');
        if (existing.length > 0) {
            const keys = existing.map(l => decodeFlagKey(l.spId));
            const rows = await hydrateFlagQueueRows(keys, (req as any).locale);
            res.json({ rows, leaseCount: existing.length, resumed: true });
            return;
        }

        const keys = await pickFlagQueueKeys({ batchSize: size });
        if (keys.length === 0) {
            res.json({ rows: [], leaseCount: 0, resumed: false });
            return;
        }

        // Encode `(receiptId, lineIdx)` into the lease table's single
        // bigint column. claimSpIds inserts one lease row per encoded
        // key; the picker query already filters out anything actively
        // leased so concurrent admins won't collide.
        const encoded = keys.map(k => encodeFlagKey(k.receiptId, k.lineIdx));
        const leases = await claimSpIds({
            adminId,
            queueKind: 'flag',
            spIds: encoded,
        });
        const claimedKeys = leases.map(l => decodeFlagKey(l.spId));
        const rows = await hydrateFlagQueueRows(claimedKeys, (req as any).locale);
        res.json({ rows, leaseCount: leases.length, resumed: false });
    } catch (e) { next(e); }
};

// ── POST /api/admin/flags/release-batch ─────────────────────────────
export const releaseFlagBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const released = await releaseAdminBatch({ adminId, queueKind: 'flag' });
        res.json({ released });
    } catch (e) { next(e); }
};

// ── POST /api/admin/flags/:flagKey/confirm ──────────────────────────
// Body:
//   {
//     sp?: {
//       storeProductName?, brandName?, amount?, unit?, isWeighable?, imageUrl?
//     },
//     productLink?:
//       | { mode: 'pick',   productId: number }
//       | { mode: 'create', name: string },
//     categoryId?: number,   // applied to the EFFECTIVE Product (post-link)
//     priceSuspect?: boolean,
//     discountSuspect?: boolean,
//   }
//
// `sp.storeProductName` is the chain-specific OCR'd label (the
// "Atpažintas tekstas" field). `productLink` re-points this SP at a
// different Product (or creates one). `categoryId` updates the
// matched Product's category. The SP unique key
// (chainId, productId, amount, unit) is enforced by MySQL — on a
// productId-change collision we merge: redirect Prices/BasketItems/
// ShoppingListItems from this SP to the existing target SP, then
// delete the now-redundant SP. Heals historical data in one step.
export const confirmFlag = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flagKey = parseFlagKey(String(req.params.flagKey));
        if (!flagKey) {
            res.status(400).json({ error: 'invalid flagKey' });
            return;
        }
        const adminId = adminIdOf(req);
        const body = (req.body ?? {}) as {
            sp?: {
                storeProductName?: unknown;
                brandName?: unknown;
                amount?: unknown;
                unit?: unknown;
                isWeighable?: unknown;
                imageUrl?: unknown;
            };
            productLink?: {
                mode?: unknown;
                productId?: unknown;
                name?: unknown;
            };
            categoryId?: unknown;
            /** Direct edits to the receipt's Price row. `price` is the
             *  line total; `promoPrice` of explicit `null` removes a
             *  phantom discount, a number replaces or adds it. Omitting
             *  a field = no change. Patvirtinti always stamps the row
             *  as priceVerified=1 (admin reviewed). */
            receiptPrice?: {
                price?: unknown;
                promoPrice?: unknown;
            };
        };

        // Resolve the SP behind this receipt line via parsedData —
        // Price has no lineIdx column, so for multi-line receipts we
        // can't infer the SP from (receiptId) alone. The receipt's
        // parsedData carries a `products[lineIdx].storeProductId` map.
        const [spRows]: any = await pool.query(
            `SELECT sp.id AS spId, sp.chainId, sp.productId,
                    sp.storeProductName, sp.brandName,
                    sp.amount, sp.unit, sp.isWeighable, sp.imageUrl,
                    p.categoryId AS productCategoryId,
                    pr.id AS priceId, pr.priceVerified,
                    pr.price, pr.promoPrice
               FROM Receipt rcpt
               JOIN StoreProduct sp
                 ON sp.id = CAST(
                      JSON_UNQUOTE(JSON_EXTRACT(
                          rcpt.parsedData,
                          CONCAT('$.products[', ?, '].storeProductId')
                      )) AS UNSIGNED
                  )
               JOIN Product p ON p.id = sp.productId
               LEFT JOIN Price pr
                      ON pr.receiptId = rcpt.id
                     AND pr.storeProductId = sp.id
                     AND pr.isFallback = 0
              WHERE rcpt.id = ?
              LIMIT 1`,
            [flagKey.lineIdx, flagKey.receiptId],
        );
        if (!spRows[0]) {
            res.status(404).json({ error: 'price/SP for this receipt line not found' });
            return;
        }
        const current = spRows[0];
        let spId = Number(current.spId);
        const priceId = current.priceId !== null && current.priceId !== undefined
            ? Number(current.priceId) : null;

        // ── Resolve target Product ─────────────────────────────────
        let targetProductId = Number(current.productId);
        let productLinkAction: 'pick' | 'create' | null = null;
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (body.productLink && typeof body.productLink === 'object') {
            const mode = String(body.productLink.mode ?? '');
            if (mode === 'pick') {
                const pid = Number(body.productLink.productId);
                if (!Number.isFinite(pid) || pid <= 0) {
                    res.status(400).json({ error: 'productLink.productId required for mode=pick' });
                    return;
                }
                // Ignore no-op picks (admin picked the current product again).
                if (pid !== targetProductId) {
                    targetProductId = pid;
                    productLinkAction = 'pick';
                    before.productId = Number(current.productId);
                    after.productId = pid;
                }
            } else if (mode === 'create') {
                const name = typeof body.productLink.name === 'string'
                    ? body.productLink.name.trim() : '';
                if (name.length === 0) {
                    res.status(400).json({ error: 'productLink.name required for mode=create' });
                    return;
                }
                // Choose category for the new Product: the body-supplied
                // categoryId wins (admin can pick before saving), else
                // inherit the current Product's category.
                const newCategoryId = typeof body.categoryId === 'number' && body.categoryId > 0
                    ? body.categoryId
                    : (current.productCategoryId ?? null);
                if (newCategoryId === null) {
                    res.status(400).json({ error: 'categoryId required to create a new Product (current has none)' });
                    return;
                }
                const [ins]: any = await pool.query(
                    `INSERT INTO Product (name, categoryId) VALUES (?, ?)`,
                    [name, newCategoryId],
                );
                targetProductId = Number(ins.insertId);
                productLinkAction = 'create';
                before.productId = Number(current.productId);
                after.productId = targetProductId;
                after.createdProductName = name;
                after.createdProductCategoryId = newCategoryId;
            }
        }

        // ── Build SP UPDATE list ──────────────────────────────────
        const spUpdates: { col: string; val: any }[] = [];
        const sp = body.sp ?? {};

        if (typeof sp.storeProductName === 'string'
            && sp.storeProductName.trim().length > 0
            && sp.storeProductName !== current.storeProductName) {
            spUpdates.push({ col: 'storeProductName', val: sp.storeProductName.trim() });
            before.storeProductName = current.storeProductName;
            after.storeProductName = sp.storeProductName.trim();
        }
        if ('brandName' in sp && sp.brandName !== undefined) {
            const v = sp.brandName === null ? null
                : (typeof sp.brandName === 'string' ? sp.brandName.trim() : null);
            if (v !== current.brandName) {
                spUpdates.push({ col: 'brandName', val: v });
                before.brandName = current.brandName;
                after.brandName = v;
            }
        }
        if (sp.amount !== undefined) {
            const amountNum = typeof sp.amount === 'number' ? sp.amount : Number.NaN;
            if (!Number.isFinite(amountNum) || amountNum <= 0) {
                res.status(400).json({ error: 'amount must be a positive number' });
                return;
            }
            const currentAmount = current.amount !== null && current.amount !== undefined
                ? parseFloat(String(current.amount)) : null;
            if (currentAmount !== amountNum) {
                spUpdates.push({ col: 'amount', val: amountNum });
                before.amount = currentAmount;
                after.amount = amountNum;
            }
        }
        if (sp.unit !== undefined) {
            if (typeof sp.unit !== 'string' || !VALID_UNITS.has(sp.unit)) {
                res.status(400).json({ error: 'unit must be one of g, kg, ml, l, vnt, rit' });
                return;
            }
            if (sp.unit !== current.unit) {
                spUpdates.push({ col: 'unit', val: sp.unit });
                before.unit = current.unit;
                after.unit = sp.unit;
            }
        }
        if (sp.isWeighable !== undefined) {
            const iw = !!sp.isWeighable;
            if (iw !== !!Number(current.isWeighable)) {
                spUpdates.push({ col: 'isWeighable', val: iw ? 1 : 0 });
                before.isWeighable = !!Number(current.isWeighable);
                after.isWeighable = iw;
            }
        }
        if (sp.imageUrl !== undefined) {
            const v = sp.imageUrl === null ? null
                : (typeof sp.imageUrl === 'string' ? sp.imageUrl : null);
            if (v !== current.imageUrl) {
                spUpdates.push({ col: 'imageUrl', val: v });
                before.imageUrl = current.imageUrl;
                after.imageUrl = v;
            }
        }
        if (productLinkAction) {
            spUpdates.push({ col: 'productId', val: targetProductId });
        }

        // ── Apply SP UPDATE with merge-on-collision ───────────────
        // The unique key (chainId, productId, amount, unit) trips on:
        //   (a) amount/unit edit that lands on an existing slot
        //       — historically surfaced as 409 to the admin
        //   (b) productId change that lands on an existing slot for
        //       the new product — that's a legitimate "this SP and
        //       the existing one are duplicates, merge them" case
        if (spUpdates.length > 0) {
            try {
                await pool.query(
                    `UPDATE StoreProduct SET ${spUpdates.map(u => `${u.col} = ?`).join(', ')} WHERE id = ?`,
                    [...spUpdates.map(u => u.val), spId],
                );
            } catch (err: any) {
                if (err?.code !== 'ER_DUP_ENTRY') throw err;
                if (productLinkAction) {
                    // (b) productId collision — merge into the existing SP.
                    const [[existing]]: any = await pool.query(
                        `SELECT id FROM StoreProduct
                          WHERE chainId = ?
                            AND productId = ?
                            AND COALESCE(amount, -1) = COALESCE(?, -1)
                            AND COALESCE(unit, '')  = COALESCE(?, '')
                            AND id != ?
                          LIMIT 1`,
                        [
                            Number(current.chainId),
                            targetProductId,
                            current.amount !== null ? parseFloat(String(current.amount)) : null,
                            current.unit ?? null,
                            spId,
                        ],
                    );
                    if (!existing) throw err;
                    const targetSpId = Number(existing.id);
                    // Redirect Prices first — this is the load-bearing
                    // table. BasketItem / ShoppingListItem follow on a
                    // best-effort basis (some installs may not have
                    // them or use different column names).
                    await pool.query(
                        `UPDATE Price SET storeProductId = ? WHERE storeProductId = ?`,
                        [targetSpId, spId],
                    );
                    try {
                        await pool.query(
                            `UPDATE BasketItem SET storeProductId = ? WHERE storeProductId = ?`,
                            [targetSpId, spId],
                        );
                    } catch (e) {
                        console.warn('[flag/confirm] BasketItem redirect skipped', e);
                    }
                    try {
                        await pool.query(
                            `UPDATE ShoppingListItem SET storeProductId = ? WHERE storeProductId = ?`,
                            [targetSpId, spId],
                        );
                    } catch (e) {
                        console.warn('[flag/confirm] ShoppingListItem redirect skipped', e);
                    }
                    // Best-effort delete. FK ON DELETE CASCADE on
                    // ImagePropagationLog / PendingImageUpload cleans
                    // those up; anything that refuses leaves the SP
                    // orphaned (no Prices → invisible to queries) which
                    // is acceptable for v1.
                    try {
                        await pool.query(
                            `DELETE FROM StoreProduct WHERE id = ?`,
                            [spId],
                        );
                    } catch (e) {
                        console.warn('[flag/confirm] old SP delete failed (orphaned)', e);
                    }
                    after.mergedIntoSpId = targetSpId;
                    spId = targetSpId;
                } else {
                    // (a) amount/unit collision without a productId
                    // change — historical 409 path; admin needs to
                    // adjust values.
                    res.status(409).json({
                        error: 'duplicate_size',
                        message: 'Another StoreProduct in the same chain already has this amount + unit',
                    });
                    return;
                }
            }
        }

        // ── Apply category to the EFFECTIVE Product ────────────────
        // If we re-linked or merged, the "effective" Product is the
        // target one (possibly newly created). Otherwise it's the
        // original Product behind this SP.
        if (typeof body.categoryId === 'number' && body.categoryId > 0) {
            const effectiveProductId = targetProductId;
            // Skip when category is unchanged. For 'create' the
            // INSERT above already set categoryId, so no-op.
            const currentCategoryForTarget =
                productLinkAction === 'create'
                    ? body.categoryId   // just set by INSERT
                    : (productLinkAction === 'pick'
                        ? null /* unknown — let UPDATE be idempotent */
                        : (current.productCategoryId ?? null));
            if (currentCategoryForTarget !== body.categoryId) {
                await pool.query(
                    `UPDATE Product SET categoryId = ? WHERE id = ?`,
                    [body.categoryId, effectiveProductId],
                );
                before.categoryId = currentCategoryForTarget;
                after.categoryId = body.categoryId;
            }
        }

        // ── Receipt Price edits ──────────────────────────────────
        // Direct price/discount edits live here. Patvirtinti is the
        // act of reviewing, so the row stamps as `priceVerified=1`
        // even when the admin didn't touch the values — they looked
        // at it and accepted what's there. Edits are surfaced into
        // the audit `valueBefore/valueAfter` JSON so the row can be
        // restored from the audit log later.
        if (priceId !== null) {
            const priceUpdates: { col: string; val: any }[] = [];
            const rp = body.receiptPrice ?? {};
            const currentPrice = current.price !== null && current.price !== undefined
                ? parseFloat(String(current.price)) : null;
            const currentPromo = current.promoPrice !== null && current.promoPrice !== undefined
                ? parseFloat(String(current.promoPrice)) : null;

            if (rp.price !== undefined) {
                const n = typeof rp.price === 'number' ? rp.price : Number.NaN;
                if (!Number.isFinite(n) || n < 0) {
                    res.status(400).json({ error: 'receiptPrice.price must be a non-negative number' });
                    return;
                }
                if (n !== currentPrice) {
                    priceUpdates.push({ col: 'price', val: n });
                    before.price = currentPrice;
                    after.price = n;
                }
            }
            if ('promoPrice' in rp) {
                if (rp.promoPrice === null) {
                    if (currentPromo !== null) {
                        priceUpdates.push({ col: 'promoPrice', val: null });
                        before.promoPrice = currentPromo;
                        after.promoPrice = null;
                    }
                } else if (rp.promoPrice !== undefined) {
                    const n = typeof rp.promoPrice === 'number' ? rp.promoPrice : Number.NaN;
                    if (!Number.isFinite(n) || n < 0) {
                        res.status(400).json({ error: 'receiptPrice.promoPrice must be a non-negative number or null' });
                        return;
                    }
                    if (n !== currentPromo) {
                        priceUpdates.push({ col: 'promoPrice', val: n });
                        before.promoPrice = currentPromo;
                        after.promoPrice = n;
                    }
                }
            }
            // Always stamp as verified — admin reviewed this row.
            // Push as the last update so it lands in the same SQL.
            const wasVerified = !!Number(current.priceVerified);
            if (!wasVerified) {
                priceUpdates.push({ col: 'priceVerified', val: 1 });
                before.priceVerified = false;
                after.priceVerified = true;
            }
            if (priceUpdates.length > 0) {
                await pool.query(
                    `UPDATE Price SET ${priceUpdates.map(u => `${u.col} = ?`).join(', ')} WHERE id = ?`,
                    [...priceUpdates.map(u => u.val), priceId],
                );
            }
        }

        // Mark every matching ReceiptLineIssue row as resolved. One
        // card can represent N users — they all close together.
        await pool.query(
            `UPDATE ReceiptLineIssue
                SET status = 'resolved', resolvedBy = ?, resolvedAt = NOW()
              WHERE receiptId = ? AND receiptLineIdx = ? AND status = 'pending'`,
            [adminId, flagKey.receiptId, flagKey.lineIdx],
        );

        const targetId = encodeFlagKey(flagKey.receiptId, flagKey.lineIdx);

        await logAdminAction({
            adminUserId: adminId,
            action: 'flag_resolve',
            targetType: 'ReceiptLineIssue',
            targetId,
            valueBefore: before,
            valueAfter: after,
        });

        await completeLease({
            adminId,
            queueKind: 'flag',
            spId: targetId,
        });

        res.json({
            flagKey: `${flagKey.receiptId}-${flagKey.lineIdx}`,
            spId,
            applied: after,
        });
    } catch (e) { next(e); }
};

// ── POST /api/admin/flags/:flagKey/dismiss ──────────────────────────
// Admin reviewed the flag and decided no changes are warranted. Marks
// every matching ReceiptLineIssue row as 'dismissed' (distinct from
// 'resolved' so we can later tell "admin took action" apart from
// "admin disagreed with the user").
export const dismissFlag = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flagKey = parseFlagKey(String(req.params.flagKey));
        if (!flagKey) {
            res.status(400).json({ error: 'invalid flagKey' });
            return;
        }
        const adminId = adminIdOf(req);
        const targetId = encodeFlagKey(flagKey.receiptId, flagKey.lineIdx);

        await pool.query(
            `UPDATE ReceiptLineIssue
                SET status = 'dismissed', resolvedBy = ?, resolvedAt = NOW()
              WHERE receiptId = ? AND receiptLineIdx = ? AND status = 'pending'`,
            [adminId, flagKey.receiptId, flagKey.lineIdx],
        );
        await logAdminAction({
            adminUserId: adminId,
            action: 'flag_dismiss',
            targetType: 'ReceiptLineIssue',
            targetId,
        });
        await completeLease({ adminId, queueKind: 'flag', spId: targetId });

        res.json({ flagKey: `${flagKey.receiptId}-${flagKey.lineIdx}`, dismissed: true });
    } catch (e) { next(e); }
};

// ── POST /api/admin/flags/:flagKey/skip ─────────────────────────────
// Logs an audit row and frees the lease. The ReceiptLineIssue rows
// stay 'pending' but the picker's 90-day recently-resolved filter
// excludes anything with a recent flag_skip — they resurface after 90
// days for another look.
export const skipFlagCard = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flagKey = parseFlagKey(String(req.params.flagKey));
        if (!flagKey) {
            res.status(400).json({ error: 'invalid flagKey' });
            return;
        }
        const adminId = adminIdOf(req);
        const targetId = encodeFlagKey(flagKey.receiptId, flagKey.lineIdx);

        await logAdminAction({
            adminUserId: adminId,
            action: 'flag_skip',
            targetType: 'ReceiptLineIssue',
            targetId,
        });
        await completeLease({ adminId, queueKind: 'flag', spId: targetId });
        res.json({ flagKey: `${flagKey.receiptId}-${flagKey.lineIdx}`, skipped: true });
    } catch (e) { next(e); }
};
