import type { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { listTripsForUser } from '../services/tripListService.js';
import { isTripMember } from '../models/tripModel.js';
import { getTripStats } from '../services/tripStatsService.js';
import { computePlanningScore, monthlyPlanningScores } from '../services/planningScoreService.js';

export const listTrips = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.json(await listTripsForUser(req.authUserId!));
    } catch (error) { next(error); }
};

const setArchived = async (req: Request, res: Response, next: NextFunction, archived: boolean) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        // 404-over-403: membership probes must not reveal trip existence.
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }
        await pool.query('UPDATE Trip SET archivedAt = ? WHERE id = ?', [archived ? new Date() : null, tripId]);
        res.json({ id: tripId, archived });
    } catch (error) { next(error); }
};

/** Manual archive ("nebeaktualu") — resume is unarchive (spec: tap = explicit resume). */
export const archiveTripById = (req: Request, res: Response, next: NextFunction) => setArchived(req, res, next, true);
export const unarchiveTripById = (req: Request, res: Response, next: NextFunction) => setArchived(req, res, next, false);

/** Per-trip stats (spend, donut, chains, member split) — member-gated. */
export const fetchTripStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }
        res.json(await getTripStats(tripId));
    } catch (error) { next(error); }
};

/** Planning score + line pairs for the stage-5 matching UI — member-gated. */
export const fetchTripScore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }
        res.json(await computePlanningScore(tripId));
    } catch (error) { next(error); }
};

/**
 * Manual connect/disconnect of a list↔receipt pair. Connect enforces the
 * plausible-candidate rule server-side: when BOTH lines resolve to catalog
 * products they must share an L2 category family; name-floor filtering for
 * unresolved lines is the client's picker concern.
 */
export const putTripLineLink = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        const { listItemId, receiptItemId, action } = req.body ?? {};
        if (!Number.isFinite(tripId) || !Number.isFinite(Number(listItemId)) || !Number.isFinite(Number(receiptItemId))) {
            res.status(400).json({ error: 'bad ids' }); return;
        }
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }

        if (action === 'unlink') {
            const [r]: any = await pool.query(
                "DELETE FROM TripLineLink WHERE tripId = ? AND listItemId = ? AND receiptItemId = ? AND kind = 'manual'",
                [tripId, listItemId, receiptItemId]);
            if (r.affectedRows === 0) {
                // No manual row → this was an AUTO pair; suppress it.
                await pool.query(
                    "INSERT IGNORE INTO TripLineLink (tripId, listItemId, receiptItemId, kind, createdByUserId) VALUES (?,?,?,'suppressed',?)",
                    [tripId, listItemId, receiptItemId, req.authUserId]);
            }
        } else {
            // Plausibility: both product-resolved → same L2 family required.
            const [[li]]: any = await pool.query(
                `SELECT COALESCE(sli.productId, sp.productId) AS productId FROM ShoppingListItem sli
                 LEFT JOIN StoreProduct sp ON sp.id = sli.storeProductId WHERE sli.id = ?`, [listItemId]);
            const [[ri]]: any = await pool.query(
                `SELECT sp.productId FROM ReceiptItem ri LEFT JOIN StoreProduct sp ON sp.id = ri.matchedSpId WHERE ri.id = ?`, [receiptItemId]);
            if (li?.productId != null && ri?.productId != null && Number(li.productId) !== Number(ri.productId)) {
                const [[fam]]: any = await pool.query(
                    `SELECT (l2a.id = l2b.id) AS sameFamily FROM Product pa
                       JOIN Category ca ON ca.id = pa.categoryId
                       LEFT JOIN Category l2a ON l2a.id = COALESCE(ca.parentCategoryId, ca.id)
                       JOIN Product pb ON pb.id = ?
                       JOIN Category cb ON cb.id = pb.categoryId
                       LEFT JOIN Category l2b ON l2b.id = COALESCE(cb.parentCategoryId, cb.id)
                      WHERE pa.id = ?`, [ri.productId, li.productId]);
                if (!fam?.sameFamily) { res.status(422).json({ error: 'implausible-pair' }); return; }
            }
            await pool.query(
                "DELETE FROM TripLineLink WHERE tripId = ? AND listItemId = ? AND receiptItemId = ? AND kind = 'suppressed'",
                [tripId, listItemId, receiptItemId]);
            await pool.query(
                "INSERT IGNORE INTO TripLineLink (tripId, listItemId, receiptItemId, kind, createdByUserId) VALUES (?,?,?,'manual',?)",
                [tripId, listItemId, receiptItemId, req.authUserId]);
        }
        res.json(await computePlanningScore(tripId));
    } catch (error) { next(error); }
};

/** Monthly planning-score series for the Profilis card (self-scoped). */
export const fetchMonthlyPlanningScore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.json(await monthlyPlanningScores(req.authUserId!));
    } catch (error) { next(error); }
};
