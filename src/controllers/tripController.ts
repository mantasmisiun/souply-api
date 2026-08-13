import type { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { listTripsForUser } from '../services/tripListService.js';
import { isTripMember } from '../models/tripModel.js';
import { getTripStats, getMonthlyTripSpend } from '../services/tripStatsService.js';
import { computePlanningScore, monthlyPlanningScores, planningBaselineDelta } from '../services/planningScoreService.js';
import { attributeComboDiscount } from '../services/comboAttribution.js';
import { assessQuality } from '../services/receiptHealService.js';
import { getTripComparison } from '../services/tripComparisonService.js';
import { attachReceiptToTrip } from '../services/tripLinkService.js';
import { readTripBasketComparison, snapshotTripComparison } from '../services/tripBasketComparison.js';
import { getReceiptOwnerId } from '../models/receiptModel.js';
import { convertTripToFamily } from '../services/tripFamilyConversion.js';
import { HouseholdActionError } from '../services/householdMembership.js';
import { LedgerError } from '../services/householdLedger.js';
import { isReceiptRecorded } from '../models/householdLedgerModel.js';

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
        const score = await computePlanningScore(tripId, { allowLiveComparison: true });
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
        res.json(await computePlanningScore(tripId, { allowLiveComparison: true }));
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
/** parsedData.footer.loyalty as MySQL hands it back (JSON string or object). */
const parseLoyalty = (raw: unknown): { program: string; redeemed: number; earned: number | null; balance: number | null } | null => {
    if (raw == null) return null;
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw as any;
        if (!o || typeof o !== 'object') return null;
        return {
            program: String(o.program ?? 'unknown'),
            redeemed: Number(o.redeemed) || 0,
            earned: o.earned == null ? null : Number(o.earned),
            balance: o.balance == null ? null : Number(o.balance),
        };
    } catch { return null; }
};

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
                    -- Old-receipt flag: is this receipt old RELATIVE TO THE SHOPPING
                    -- IT DOCUMENTS? Anchored on the trip, not on uploadedAt: a
                    -- receipt uploaded months ago and only now attached to today's
                    -- trip scored 0 days against its own upload and showed no
                    -- warning at all (reported: a April receipt on a July trip, no
                    -- flag). The trip's creation date is what the receipt is meant
                    -- to match; uploadedAt remains the fallback for a receipt whose
                    -- trip predates it (plan Monday, shop Friday → still fresh).
                    -- Both are frozen values, so the flag never drifts with time.
                    -- SUPPRESSED for ad-hoc trips: the trip IS this uploaded receipt,
                    -- so an old date is intentional, not a "wrong receipt?" warning.
                    (t.isAdHoc = 0 AND r.receiptDate IS NOT NULL
                        AND DATEDIFF(GREATEST(t.createdAt, r.uploadedAt), r.receiptDate) > 30) AS staleReceipt,
                    JSON_EXTRACT(r.parsedData, '$.footer.total') AS printedTotal,
                    JSON_EXTRACT(r.parsedData, '$.footer.comboDiscount') AS comboDiscount,
                    JSON_EXTRACT(r.parsedData, '$.footer.loyalty') AS loyalty,
                    JSON_EXTRACT(r.parsedData, '$.footer.comboDiscountAnchors') AS comboAnchors
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
            // Loyalty money ("MAXIMOS pinigai") — redeemed reduces THIS bill, so
            // reconciliation must know about it; earned/balance ride along for the
            // stats surfaces.
            const loyalty = parseLoyalty(r.loyalty);
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
                // Set-deal discounts come off the FOOTER, not the lines — without
                // this the line sum legitimately overshoots the total and a clean
                // receipt gets flagged for a retake.
                Number.isFinite(Number(r.comboDiscount)) ? Number(r.comboDiscount) : null,
                loyalty?.redeemed ?? null,
            );
            // printedTotal = the receipt's OWN footer total (what the user actually paid).
            // Surfaced so the detail card shows the recognised total, not a line-item sum
            // that a single mis-parsed line can throw off.
            const { printedTotal, comboDiscount, comboAnchors, loyalty: _rawLoyalty, ...rr } = r;
            const combo = Number(comboDiscount) > 0 ? Number(comboDiscount) : 0;
            // WHICH lines the set deal is shown against. A deal needs 2+ qualifying
            // items, so spreading it over every line made unrelated products (a lone
            // bottle of vinegar next to 2× water) look discounted. Tiered: the line
            // it was printed under → plain multiples → everything. DISPLAY ONLY —
            // item price/promoPrice are untouched so price learning and cross-store
            // comparison keep the true unit prices.
            let anchors: number[] = [];
            try {
                const a = typeof comboAnchors === 'string' ? JSON.parse(comboAnchors) : comboAnchors;
                if (Array.isArray(a)) anchors = a.filter((n: any) => Number.isInteger(n));
            } catch { /* no anchors → the tiers below still apply */ }
            const attribution = attributeComboDiscount(
                (items as any[]).map((it) => ({
                    matchedSpId: it.matchedSpId ?? null,
                    name: it.name ?? '',
                    quantity: Number(it.quantity) || 1,
                    lineTotal: Number(it.lineTotal) || 0,
                })),
                combo, anchors,
            );
            const itemsWithShare = (items as any[]).map((it, i) => ({
                ...it, comboShare: attribution.shares[i] ?? 0,
            }));
            receipts.push({
                ...rr, items: itemsWithShare,
                printedTotal: printedTotal != null ? Number(printedTotal) : null,
                comboDiscount: combo,
                /** Deal amount that couldn't be placed on any line (all capped) —
                 *  keep showing this at footer level so the total still adds up. */
                comboUnattributed: attribution.unattributed,
                comboBasis: attribution.basis,
                loyalty,
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
 * GET /api/trips/:id/basket-comparison
 *
 * The trip-level Sutaupyta: your spend split by store, and the whole basket
 * priced at each nearby store as a single shop. Frozen per trip (prices drift,
 * verdicts shouldn't) — see tripBasketComparison.
 */
export const fetchTripBasketComparison = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }
        const fresh = String(req.query.refresh ?? '') === '1';
        res.json(fresh
            ? await snapshotTripComparison(tripId)
            : await readTripBasketComparison(tripId));
    } catch (error) { next(error); }
};

/**
 * POST /api/trips/:id/attach-receipt   { receiptId }
 *
 * Put a receipt on this trip WITHOUT claiming a planned store slot — the
 * "I shopped somewhere the plan didn't include" case. Slot fulfilment is a
 * separate statement (POST /shopping-lists/:id/link-receipt), and forcing the
 * two together is what made an off-plan receipt borrow an unrelated store's
 * slot just to join the trip.
 *
 * Membership rules mirror detach: any trip member may attach a receipt they
 * uploaded/own; the receipt must be theirs.
 */
export const attachTripReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        const receiptId = Number(req.body?.receiptId);
        if (!Number.isFinite(tripId) || !Number.isFinite(receiptId)) { res.status(400).json({ error: 'bad id' }); return; }
        const viewer = req.authUserId!;
        // 404-over-403 probe defense: non-members learn nothing about the trip.
        if (!(await isTripMember(tripId, viewer))) { res.status(404).json({ error: 'not found' }); return; }
        const owner = await getReceiptOwnerId(receiptId);
        if (owner === null) { res.status(404).json({ error: 'receipt not found' }); return; }
        if (owner !== viewer) { res.status(403).json({ error: 'forbidden' }); return; }
        await attachReceiptToTrip(receiptId, tripId);
        res.json({ ok: true });
    } catch (error) { next(error); }
};

/**
 * POST /api/trips/:id/convert-to-family — family spec §7.
 *
 * Turns an existing PERSONAL trip into a family one: `Trip.householdId` is set
 * and every receipt already on it enters the household ledger at its FAMILY
 * subtotal (§4.3). One-way — see tripFamilyConversion for why there is no
 * inverse, and for the participant-set choice.
 *
 * The membership probe defense is layered exactly like the rest of this file:
 * a non-member of the TRIP gets 404 (a bare trip id must not be probeable),
 * and only past that gate does the service answer 403 for "your trip? no" /
 * "your household? no". Everything else the service decides, because the rules
 * are ledger rules and belong next to the ledger.
 */
export const postConvertTripToFamily = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        const viewer = req.authUserId!;
        if (!(await isTripMember(tripId, viewer))) { res.status(404).json({ error: 'not found' }); return; }
        res.json(await convertTripToFamily(tripId, viewer));
    } catch (error) {
        if (error instanceof HouseholdActionError) {
            res.status(error.status).json({ error: error.code });
            return;
        }
        // A ledger invariant refusing the request is a 409, not a 500 — same
        // mapping receiptFamilyController uses for the §4.4 path.
        if (error instanceof LedgerError) {
            res.status(409).json({ error: 'ledger-conflict', message: error.message });
            return;
        }
        next(error);
    }
};

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
        const [[trip]] = await pool.query('SELECT createdByUserId, createdAt, householdId FROM Trip WHERE id = ?', [tripId]) as any;
        if (!trip) { res.status(404).json({ error: 'not found' }); return; }
        // The receipt must actually belong to this trip.
        const [[rcpt]] = await pool.query(
            'SELECT COALESCE(uploaderUserId, userId) AS uploaderId FROM Receipt WHERE id = ? AND tripId = ?',
            [receiptId, tripId]) as any;
        if (!rcpt) { res.status(404).json({ error: 'not found' }); return; }

        const isOwner = trip.createdByUserId === viewer;
        const isUploader = rcpt.uploaderId === viewer;
        if (!isOwner && !isUploader) { res.status(403).json({ error: 'forbidden' }); return; }
        /**
         * §8 — A RECEIPT COUNTED INTO THE LEDGER CANNOT LEAVE ITS FAMILY TRIP.
         *
         * `assertReceiptDeletable` already blocks DELETE for such a receipt,
         * but it decides on Receipt.tripId → Trip.householdId — so detaching
         * first sets householdId out of reach and the delete then sails
         * through. Detach → delete was a two-step way to remove a receipt the
         * ledger still has a `receipt_recorded` for, which is precisely the
         * stranded-shares outcome §8 exists to prevent. It is only reachable at
         * all now that §7's conversion actually writes into the ledger.
         *
         * 423 Locked, matching the delete gate's own answer. §4.4's adjustment
         * path remains the sanctioned correction: toggle the items to personal
         * and the receipt's family subtotal drains to zero, visibly.
         */
        if (trip.householdId != null && await isReceiptRecorded(Number(trip.householdId), receiptId)) {
            res.status(423).json({ error: 'receipt-counted-in-ledger' }); return;
        }
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
