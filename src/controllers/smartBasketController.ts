import type { Request, Response } from 'express';
import { buildSmartBasketPreview, type SmartBasketMode } from '../services/smartBasketService.js';

/** Caller identity: session (Bearer/cookie via requireUser) or verified user. */
function callerId(req: Request): string | null {
    if (req.authUserId) return req.authUserId;
    if (req.verifiedUser?.id) return String(req.verifiedUser.id);
    return null;
}

const MODES: SmartBasketMode[] = ['popular', 'discounts', 'personal'];

/**
 * POST /api/smart-basket/preview  { mode }
 * Returns the generated basket PREVIEW (no basket is created — the client
 * creates the draft via the existing basket endpoints on accept).
 */
export const previewSmartBasket = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = callerId(req);
        if (!userId) { res.status(401).json({ error: 'unauthorized' }); return; }
        const mode = String(req.body?.mode ?? '') as SmartBasketMode;
        if (!MODES.includes(mode)) {
            res.status(400).json({ error: 'invalid mode', modes: MODES });
            return;
        }
        const preview = await buildSmartBasketPreview(userId, mode, req.locale);
        res.json(preview);
    } catch (e) {
        console.error('[smartBasket] preview failed:', e);
        res.status(500).json({ error: 'preview failed' });
    }
};
