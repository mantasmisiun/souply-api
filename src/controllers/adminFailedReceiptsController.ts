import { Request, Response, NextFunction } from 'express';
import {
    getFailedReceipts,
    markFailedReceiptResolved,
} from '../models/failedReceiptLogModel.js';
import { resolveEnv } from '../scrapers/shared/telegramAlert.js';

/**
 * GET /api/admin/failed-receipts?status=new|resolved
 *
 * Surfaces unprocessable receipts (the FailedReceiptLog) for the admin panel,
 * scoped to THIS deployment's environment so prod admins don't see dev noise.
 * Defaults to the unresolved ('new') queue.
 */
export const getFailedReceiptsQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const status = req.query.status === 'resolved' ? 'resolved' : 'new';
        const rows = await getFailedReceipts(resolveEnv(), status);
        res.json(rows);
    } catch (e) {
        next(e);
    }
};

/**
 * POST /api/admin/failed-receipts/:id/resolve
 *
 * Marks a failed receipt resolved — used both when the admin dismisses it and
 * (later) after promoting it into a real Receipt.
 */
export const resolveFailedReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        await markFailedReceiptResolved(id);
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
};
