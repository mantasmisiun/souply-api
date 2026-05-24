import { Request, Response, NextFunction } from 'express';
import {
    getProductSourceReceipt,
    applyReceiptSplit,
} from '../models/adminReceiptSplitModel.js';
import { completeLease } from '../models/adminLeaseModel.js';

function adminIdOf(req: Request): string {
    return String(req.headers['x-admin-id']);
}

// ── GET /api/admin/uncategorised/:productId/source-receipt ──────────
// Returns the most recent receipt-sourced Price for this product so
// the client can render the crop image and pre-fill the split form.
// The crop URL itself is constructed client-side from receiptId + lineIdx
// using the same helper as the Flags tab.
export const getSourceReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const productId = Number(req.params.productId);
        if (!Number.isFinite(productId)) {
            res.status(400).json({ error: 'invalid productId' });
            return;
        }
        const info = await getProductSourceReceipt(productId);
        if (!info) {
            res.status(404).json({ error: 'no receipt source found for this product' });
            return;
        }
        res.json(info);
    } catch (e) { next(e); }
};

// ── POST /api/admin/uncategorised/:productId/split ──────────────────
// Body: {
//   priceId: number,
//   top:    { name, price, promoPrice, amount, unit },
//   bottom: { name, price, promoPrice, amount, unit },
// }
// top    → new Product + SP + Price (goes through the matching pipeline)
// bottom → overwrites the existing Product / SP / Price
// On success the lease is completed and the card disappears from the queue.
export const applySplit = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const productId = Number(req.params.productId);
        if (!Number.isFinite(productId)) {
            res.status(400).json({ error: 'invalid productId' });
            return;
        }
        const adminId = adminIdOf(req);
        const { priceId, top, bottom } = (req.body ?? {}) as {
            priceId?: unknown;
            top?: unknown;
            bottom?: unknown;
        };

        const pid = Number(priceId);
        if (!Number.isFinite(pid) || pid <= 0) {
            res.status(400).json({ error: 'priceId is required' });
            return;
        }
        if (!isValidSplitItem(top)) {
            res.status(400).json({ error: 'top item is invalid' });
            return;
        }
        if (!isValidSplitItem(bottom)) {
            res.status(400).json({ error: 'bottom item is invalid' });
            return;
        }

        const result = await applyReceiptSplit({
            adminId,
            productId,
            priceId: pid,
            top: top as any,
            bottom: bottom as any,
        });

        await completeLease({ adminId, queueKind: 'uncategorised', spId: productId });

        res.json({ productId, ...result });
    } catch (e) { next(e); }
};

function isValidSplitItem(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const i = item as Record<string, unknown>;
    return (
        typeof i.name === 'string' && i.name.trim().length > 0 &&
        Number.isFinite(Number(i.price)) &&
        (i.promoPrice == null || Number.isFinite(Number(i.promoPrice))) &&
        (i.amount == null || Number.isFinite(Number(i.amount)))
    );
}
