import type { Request, Response, NextFunction } from 'express';
import { getReceiptOwnerId } from '../models/receiptModel.js';

/**
 * Object-level authorization for `/receipts/:id/...` routes. Apply AFTER requireUser:
 * loads the receipt's owner and 403s unless it equals the token subject. Closes the
 * IDOR where a bare sequential :id let any caller read/tamper another user's receipt
 * (photo, basket, autosave, file-path repoint). 404 when the receipt doesn't exist,
 * so ownership can't be probed by response-code differences.
 *
 * `paramName` defaults to 'id' but a couple of routes use ':receiptId'.
 */
export function requireReceiptOwner(paramName: 'id' | 'receiptId' = 'id') {
    return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const receiptId = Number(req.params[paramName]);
        if (!Number.isFinite(receiptId) || receiptId <= 0) {
            res.status(400).json({ error: 'invalid receipt id' });
            return;
        }
        if (!req.authUserId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        const ownerId = await getReceiptOwnerId(receiptId);
        if (ownerId === null) {
            res.status(404).json({ error: 'receipt not found' });
            return;
        }
        if (ownerId !== req.authUserId) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        next();
    };
}
