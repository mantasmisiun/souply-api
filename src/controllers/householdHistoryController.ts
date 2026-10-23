import type { Request, Response, NextFunction } from 'express';
import { getHouseholdHistoryFeed } from '../services/householdHistory.js';
import { HouseholdActionError } from '../services/householdMembership.js';

/**
 * FAMILY SHOPPING §5.2 — the History tab's read.
 *
 * Self-scoped like the rest of `/households/mine`: the household is resolved
 * from the caller's own membership inside the service and never taken from the
 * URL, so there is no id to tamper with and a non-member has nothing to read.
 * The controller only shapes the response.
 */

const respondToError = (res: Response, e: unknown, next: NextFunction): void => {
    if (e instanceof HouseholdActionError) {
        res.status(e.status).json({ error: e.code });
        return;
    }
    next(e);
};

/**
 * GET /api/households/mine/history?limit=&cursor=
 *
 * `limit` is passed through unvalidated ON PURPOSE — the model clamps it to
 * [1, LEDGER_PAGE_MAX] and coerces junk to the default, which is the one place
 * that bound can be enforced for every caller. A 400 here would only teach a
 * client to retry with a number the server was going to pick anyway.
 */
export const getOwnHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawLimit = Number(req.query.limit);
        const page = await getHouseholdHistoryFeed({
            userId: req.authUserId!,
            limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
            cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        });
        if (!page) { res.status(404).json({ error: 'not found' }); return; }
        res.json(page);
    } catch (error) { respondToError(res, error, next); }
};
