import type { Request, Response, NextFunction } from 'express';
import { getFamilyReceiptView, setReceiptItemScope } from '../services/receiptFamilyScope.js';
import { HouseholdActionError } from '../services/householdMembership.js';
import { LedgerError } from '../services/householdLedger.js';

/**
 * FAMILY SHOPPING §4 — the HTTP surface for family/personal items.
 *
 * NOTE WHAT IS NOT HERE: `requireReceiptOwner`. Every other /receipts/:id route
 * is owner-bound, which is correct for them and is exactly why a household
 * member who did not upload the receipt currently cannot read a family trip at
 * all. These two routes are the deliberate exception, so the authorization they
 * do instead is done in the SERVICE, against household membership — one place,
 * next to the data it is protecting, rather than as a middleware whose reach
 * would be easy to widen by accident later.
 *
 * Both answer 404 rather than 403 for "not your household": a bare sequential
 * receipt id must not be probeable for existence.
 */

const respondToError = (res: Response, e: unknown, next: NextFunction): void => {
    if (e instanceof HouseholdActionError) {
        res.status(e.status).json({ error: e.code });
        return;
    }
    // A ledger invariant that failed is a 409, not a 500: the request was
    // well-formed, the receipt's state refuses it (e.g. a settlement confirmed
    // between the lock check and the restatement).
    if (e instanceof LedgerError) {
        res.status(409).json({ error: 'ledger-conflict', message: e.message });
        return;
    }
    next(e);
};

const receiptIdOf = (req: Request, res: Response): number | null => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'invalid receipt id' });
        return null;
    }
    return id;
};

/**
 * GET /api/receipts/:id/family — §4.5.
 *
 * The family section of a family trip's receipt, for any member of that
 * household. Family items ONLY: no personal items, no grand total, no image.
 * Served identically to the uploader; there is no viewer-dependent branch here
 * to get wrong. The uploader's own full view stays at GET /receipts/:id.
 */
export const fetchFamilyReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = receiptIdOf(req, res);
        if (id === null) return;
        const view = await getFamilyReceiptView({ receiptId: id, viewerUserId: req.authUserId! });
        if (!view) { res.status(404).json({ error: 'not found' }); return; }
        res.json(view);
    } catch (error) { respondToError(res, error, next); }
};

/**
 * PATCH /api/receipts/:id/family/scope — §4.1 (one tap) and §4.2 (bulk edit).
 *
 * Body: { scope: 'family' | 'personal', lineIdx?: number, lineIdxs?: number[] }
 * One endpoint for both because they are the same write: §4.2's selection mode
 * is a longer list, not a different operation.
 *
 * The response carries `ledger` ('none' | 'restated' | 'adjusted') so the client
 * can tell the user an audit entry was created — §4.4's adjustment is supposed
 * to be VISIBLE, and silently succeeding would defeat that.
 */
export const patchReceiptItemScope = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = receiptIdOf(req, res);
        if (id === null) return;

        const scope = req.body?.scope;
        if (scope !== 'family' && scope !== 'personal') {
            res.status(400).json({ error: 'scope must be "family" or "personal"' });
            return;
        }
        const raw = Array.isArray(req.body?.lineIdxs)
            ? req.body.lineIdxs
            : (req.body?.lineIdx !== undefined ? [req.body.lineIdx] : []);
        const lineIdxs = raw
            .map((v: unknown) => Number(v))
            .filter((v: number) => Number.isInteger(v) && v >= 0);
        if (lineIdxs.length === 0) {
            res.status(400).json({ error: 'lineIdx or lineIdxs is required' });
            return;
        }
        // Bounded so one request cannot be turned into an unbounded write.
        if (lineIdxs.length > 500) {
            res.status(400).json({ error: 'too many lines' });
            return;
        }

        const result = await setReceiptItemScope({
            receiptId: id,
            actorUserId: req.authUserId!,
            lineIdxs,
            isPersonal: scope === 'personal',
        });
        res.json(result);
    } catch (error) { respondToError(res, error, next); }
};
