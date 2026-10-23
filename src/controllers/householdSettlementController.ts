import type { Request, Response, NextFunction } from 'express';
import { getHouseholdLedgerView, HouseholdActionError } from '../services/householdMembership.js';
import { confirmSettlement, proposeSettlement } from '../services/householdSettlements.js';

/**
 * FAMILY SHOPPING — the settlement HTTP surface (spec §3.2).
 *
 * Self-scoped like the rest of /households/mine: the household is resolved from
 * the caller's own membership and never taken from the URL or the body, so
 * there is no household id for a caller to tamper with. Who may do what is
 * decided in the service (§3.2.1: only the two parties may propose, and only
 * the COUNTERPARTY may confirm) — the controller only shapes the response.
 */

/** Service errors carry their own status; anything else is a real 500. */
const respondToError = (res: Response, e: unknown, next: NextFunction): void => {
    if (e instanceof HouseholdActionError) {
        res.status(e.status).json({ error: e.code });
        return;
    }
    next(e);
};

/**
 * GET /households/mine/settlements — "what do I owe / who owes me".
 * `transfers` is §3.2's greedy simplification for the CALLER: the exact list
 * the settle-and-leave dialog renders, and the exact objects the propose
 * endpoint takes back.
 */
export const getOwnSettlements = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const view = await getHouseholdLedgerView(req.authUserId!);
        if (!view) { res.status(404).json({ error: 'not found' }); return; }
        res.json(view);
    } catch (error) { respondToError(res, error, next); }
};

/** POST /households/mine/settlements — "Mark as settled" (§3.2.1). Moves nothing. */
export const proposeOwnSettlement = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const from = typeof req.body?.from === 'string' ? req.body.from : null;
        const to = typeof req.body?.to === 'string' ? req.body.to : null;
        const amountCents = Number(req.body?.amountCents);
        if (!from || !to || !Number.isFinite(amountCents)) {
            res.status(400).json({ error: 'from, to and amountCents are required' });
            return;
        }
        const proposal = await proposeSettlement({
            proposer: req.authUserId!, from, to, amountCents,
        });
        res.status(201).json(proposal);
    } catch (error) { respondToError(res, error, next); }
};

/**
 * POST /households/mine/settlements/:settlementId/confirm — the second
 * signature (§3.2.1). 403 'proposer-cannot-confirm' is the interesting case:
 * without it, mutual confirmation would be decorative.
 */
export const confirmOwnSettlement = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = await confirmSettlement(req.authUserId!, String(req.params.settlementId ?? ''));
        res.json({ confirmed: true, ...result });
    } catch (error) { respondToError(res, error, next); }
};
