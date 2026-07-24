import type { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { listTripsForUser } from '../services/tripListService.js';
import { isTripMember } from '../models/tripModel.js';
import { getTripStats, getMonthlyTripSpend } from '../services/tripStatsService.js';
import { computePlanningScore, monthlyPlanningScores, planningBaselineDelta } from '../services/planningScoreService.js';
import { assessQuality } from '../services/receiptHealService.js';
import { getTripComparison } from '../services/tripComparisonService.js';

export const listTrips = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.json(await listTripsForUser(req.authUserId!, (req as any).locale ?? 'lt'));
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
        res.json(await getTripStats(tripId, req.authUserId!, (req as any).locale ?? 'lt'));
    } catch (error) { next(error); }
};

/** Planning score + line pairs for the stage-5 matching UI — member-gated. */
export const fetchTripScore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }
        const score = await computePlanningScore(tripId);
        const deltaPct = await planningBaselineDelta(req.authUserId!, tripId, score.score);
        res.json({ ...score, deltaPct });
    } catch (error) { next(error); }
};

/**
 * Trip-level cross-store basket comparison for the "savings" sheet — the whole
 * trip's basket priced across nearby chains. Member-gated with the same
 * 404-over-403 probing defense as fetchTripReceipts/fetchTripScore.
 */
export const fetchTripComparison = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }
        res.json(await getTripComparison(tripId));
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

/** GET /api/trips/spend?month=YYYY-MM — per-trip spend for the month (default
 *  current), for the "Kelionės" spend donut. Own trips only (TripMember). */
export const fetchMonthlyTripSpend = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const month = typeof req.query.month === 'string' ? req.query.month : undefined;
        res.json(await getMonthlyTripSpend(req.authUserId!, month));
    } catch (error) { next(error); }
};


/**
 * Receipts attached to a trip, with their parsed items — the Receipts stage
 * screen's data (TRIP_MAP_SURFACE_PLAN.md rework: one screen per stage).
 * Member-gated with the same 404-over-403 probing defense.
 */
export const fetchTripReceipts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        const viewer = req.authUserId!;
        if (!(await isTripMember(tripId, viewer))) { res.status(404).json({ error: 'not found' }); return; }
        // Publish-gating: a receipt is invisible to OTHER members until its
        // uploader clears the mandatory swipe queue (published = required 0 or
        // completed >= required). The uploader always sees their own pending row.
        const [rows] = await pool.query(
            `SELECT r.id, r.storeId, r.receiptDate, r.processingStatus,
                    r.mandatorySwipesRequired, r.mandatorySwipesCompleted,
                    COALESCE(r.uploaderUserId, r.userId) AS uploaderUserId,
                    s.name AS storeName, s.address AS storeAddress, c.name AS chainName, c.id AS chainId,
                    -- Old-receipt flag: the receipt was already >30 days old WHEN
                    -- UPLOADED (uploadedAt is frozen at insert, so this never drifts
                    -- — fresh-at-upload stays fresh forever). Seen by all members.
                    -- SUPPRESSED for ad-hoc trips: the trip IS this uploaded receipt,
                    -- so an old date is intentional, not a "wrong receipt?" warning.
                    (t.isAdHoc = 0 AND r.receiptDate IS NOT NULL AND DATEDIFF(r.uploadedAt, r.receiptDate) > 30) AS staleReceipt,
                    JSON_EXTRACT(r.parsedData, '$.footer.total') AS printedTotal,
                    JSON_EXTRACT(r.parsedData, '$.footer.comboDiscount') AS comboDiscount
               FROM Receipt r
               JOIN Trip t ON t.id = r.tripId
               LEFT JOIN Store s ON s.id = r.storeId
               LEFT JOIN StoreChain c ON c.id = s.chainId
              WHERE r.tripId = ?
                AND r.userDeletedAt IS NULL
                AND (COALESCE(r.uploaderUserId, r.userId) = ?
                     OR r.mandatorySwipesRequired = 0
                     OR r.mandatorySwipesCompleted >= r.mandatorySwipesRequired)
              ORDER BY r.id ASC`,
            [tripId, viewer]) as any;
        const receipts = [] as any[];
        for (const r of rows as any[]) {
            const [items] = await pool.query(
                `SELECT id, lineIdx, name, price, quantity, unit, sizeUnit, matchedSpId, matchedName, storeProductImageUrl,
                        itemConfidence, priceImplausible,
                        ROUND((CASE WHEN promoPrice IS NOT NULL AND promoPrice > 0 THEN promoPrice ELSE price END)
                              * COALESCE(quantity, 1), 2) AS lineTotal
                   FROM ReceiptItem WHERE receiptId = ? ORDER BY lineIdx ASC`,
                [r.id]) as any;
            // Scan-quality signal → drives the "Perfotografuoti" (retake) banner.
            // lowQuality trips on unreadable-line fraction OR a reconciliation gap
            // vs the printed total; unmatchedCount is the user-facing "N unrecognised".
            const quality = assessQuality(
                (items as any[]).map((it) => ({
                    price: Number(it.lineTotal) || 0,
                    quantity: Number(it.quantity) || 1,
                    name: it.name ?? '',
                    matched: it.matchedSpId != null,
                    confirmed: false,
                    confidence: it.itemConfidence != null ? Number(it.itemConfidence) : 0.5,
                    implausible: !!it.priceImplausible,
                })),
                r.printedTotal != null ? Number(r.printedTotal) : null,
            );
            // printedTotal = the receipt's OWN footer total (what the user actually paid).
            // Surfaced so the detail card shows the recognised total, not a line-item sum
            // that a single mis-parsed line can throw off.
            const { printedTotal, comboDiscount, ...rr } = r;
            receipts.push({
                ...rr, items,
                printedTotal: printedTotal != null ? Number(printedTotal) : null,
                // Footer combo/set-deal discount (e.g. IKI RINKINYS) — the client applies
                // it proportionally for the receipt's net item prices + discount view.
                comboDiscount: Number(comboDiscount) > 0 ? Number(comboDiscount) : 0,
                lowQuality: quality.lowQuality, unmatchedCount: quality.unmatchedCount,
            });
        }
        res.json(receipts);
    } catch (error) { next(error); }
};

/** How long after trip creation the UPLOADER may still detach their own wrong
 *  receipt. The trip OWNER moderates with no window (see below). */
const RECEIPT_DETACH_WINDOW_DAYS = 7;

/**
 * "Wrong receipt": DETACH a receipt from the trip (tripId → NULL — the receipt
 * itself survives in the uploader's history; the slot reopens and the derived
 * stage falls back). Detach ONLY unlinks; it never deletes the receipt/items/
 * prices.
 *
 * Authz:
 *   • trip OWNER (Trip.createdByUserId) may detach ANY receipt in the trip
 *     (moderation) with NO time window.
 *   • the receipt's UPLOADER may detach their OWN receipt, still bounded by the
 *     7-day window (a week-old trip stays immutable for regular members).
 *   • any other member cannot detach → 403.
 */
export const detachTripReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        const receiptId = Number(req.params.receiptId);
        if (!Number.isFinite(tripId) || !Number.isFinite(receiptId)) { res.status(400).json({ error: 'bad id' }); return; }
        const viewer = req.authUserId!;
        // 404-over-403 probe defense: non-members learn nothing about the trip.
        if (!(await isTripMember(tripId, viewer))) { res.status(404).json({ error: 'not found' }); return; }
        const [[trip]] = await pool.query('SELECT createdByUserId, createdAt FROM Trip WHERE id = ?', [tripId]) as any;
        if (!trip) { res.status(404).json({ error: 'not found' }); return; }
        // The receipt must actually belong to this trip.
        const [[rcpt]] = await pool.query(
            'SELECT COALESCE(uploaderUserId, userId) AS uploaderId FROM Receipt WHERE id = ? AND tripId = ?',
            [receiptId, tripId]) as any;
        if (!rcpt) { res.status(404).json({ error: 'not found' }); return; }

        const isOwner = trip.createdByUserId === viewer;
        const isUploader = rcpt.uploaderId === viewer;
        if (!isOwner && !isUploader) { res.status(403).json({ error: 'forbidden' }); return; }
        // Only the uploader path is window-gated; the owner moderates freely.
        if (!isOwner) {
            const ageMs = Date.now() - new Date(trip.createdAt).getTime();
            if (ageMs > RECEIPT_DETACH_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
                res.status(423).json({ error: 'detach-window-closed' }); return;
            }
        }
        const [result] = await pool.query(
            'UPDATE Receipt SET tripId = NULL, shoppingListId = NULL WHERE id = ? AND tripId = ?',
            [receiptId, tripId]) as any;
        if (!result.affectedRows) { res.status(404).json({ error: 'not found' }); return; }
        res.json({ ok: true });
    } catch (error) { next(error); }
};
