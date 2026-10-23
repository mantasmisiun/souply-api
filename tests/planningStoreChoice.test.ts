import pool from '../src/config/db.js';
import { createTrip } from '../src/models/tripModel.js';
import { computePlanningScore } from '../src/services/planningScoreService.js';

/**
 * storeChoice — "could this whole shopping have cost less somewhere else?"
 *
 * THE BUG: a split trip scored 100/100 (perfect store choice) while its own
 * Sutaupyta sheet said one Maxima shop would have been €0.40 cheaper. The metric
 * was summed from PER-RECEIPT snapshots, which compare each receipt only against
 * alternatives for its OWN items — nothing ever priced the whole basket at one
 * store, so "each half was well bought" read as "the trip was optimal". It also
 * inherited that comparison's flat imputation: alternatives equal to the paid
 * total (nothing to compare) scored as "you couldn't have done better".
 *
 * It now reads the TRIP comparison, and falls back to the per-receipt snapshots
 * only when no trip comparison is cached and computing one isn't allowed (the
 * monthly loops must not price a basket per trip).
 */

const USER = 'plansc-aaaa-aaaa-aaaa-aaaaaaaa';
const CHAIN = 99091;
const STORE = 990911;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

let lineIdx = 0;
/** A receipt with one priced line — the score returns early on a trip with no
 *  receipt lines at all, so storeChoice would never be reached. */
const mkReceipt = async (tripId: number, price = 5.00): Promise<number> => {
    const r = await q(
        `INSERT INTO Receipt (userId, storeId, filePath, receiptDate, tripId, processingStatus,
                              mandatorySwipesRequired, mandatorySwipesCompleted)
         VALUES (?,?,?,NOW(),?, 'completed', 0, 0)`, [USER, STORE, 'test://r.jpg', tripId]);
    const receiptId = Number(r.insertId);
    await q(`INSERT INTO ReceiptItem (receiptId, lineIdx, name, price, quantity) VALUES (?,?,?,?,1)`,
        [receiptId, lineIdx++, 'Line', price]);
    return receiptId;
};

/** Freeze a trip comparison directly — this test is about how the SCORE reads
 *  it, not about how it's computed (tripBasketComparison.test covers that). */
const freezeTripComparison = async (
    tripId: number, paidTotal: number, candidateTotals: number[],
) => {
    const candidates = candidateTotals.map((total, i) => ({
        storeId: STORE + i, storeName: `S${i}`, chainId: CHAIN + i, chainName: `C${i}`,
        chainLogoUrl: null, distanceKm: 1, total, carriedItems: 0, visited: i === 0,
    }));
    const payload = {
        segments: [], paidTotal, candidates,
        bestSingleTotal: Math.min(...candidateTotals),
        splitDelta: paidTotal - Math.min(...candidateTotals),
        unmatchedLineCount: 0, unmatchedLineTotal: 0, itemCount: candidates.length,
    };
    await q(
        `INSERT INTO TripComparisonSnapshot (tripId, paidTotal, bestSingleTotal, candidateCount, unmatchedLines, payload)
         VALUES (?,?,?,?,0,?)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), paidTotal = VALUES(paidTotal)`,
        [tripId, paidTotal, payload.bestSingleTotal, candidates.length, JSON.stringify(payload)],
    );
};

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [CHAIN, 'PlanSC']);
    await q(`INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?)
             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [STORE, CHAIN, 'PlanSC Store', 'X 1']);
});

afterAll(async () => {
    await q('DELETE s FROM ReceiptComparisonSnapshot s JOIN Receipt r ON r.id = s.receiptId WHERE r.userId = ?', [USER]);
    await q('DELETE FROM Receipt WHERE userId = ?', [USER]);
    await q('DELETE FROM TripComparisonSnapshot WHERE tripId IN (SELECT id FROM Trip WHERE createdByUserId = ?)', [USER]);
    await q('DELETE FROM TripMember WHERE userId = ?', [USER]);
    await q('DELETE FROM Trip WHERE createdByUserId = ?', [USER]);
    await q('DELETE FROM Store WHERE id = ?', [STORE]);
    await q('DELETE FROM StoreChain WHERE id = ?', [CHAIN]);
    await (pool as any).end();
});

describe('storeChoice from the trip comparison', () => {
    it('paying the cheapest single-store total is a perfect choice', async () => {
        const trip = await createTrip(USER, {});
        await mkReceipt(trip);
        await freezeTripComparison(trip, 10.00, [10.00, 12.00, 14.00]);
        const s = await computePlanningScore(trip);
        expect(s.storeChoice).toBe(1);
        expect(s.storeHeadroomEur).toBe(0);
    });

    it('THE BUG: paying above the best single shop is no longer a perfect choice', async () => {
        // Trip 191's shape: paid €6.31 across two stores, one shop would have
        // been €5.91, most alternatives ~€8.6.
        const trip = await createTrip(USER, {});
        await mkReceipt(trip);
        await freezeTripComparison(trip, 6.31, [5.91, 8.62, 8.62, 8.67, 8.79]);
        const s = await computePlanningScore(trip);
        // 0.5 + 0.5·(M−P)/(M−C) with M = 8.62, C = 5.91 → ~0.93
        expect(s.storeChoice).toBeGreaterThan(0.85);
        expect(s.storeChoice).toBeLessThan(1);
        expect(s.storeHeadroomEur).toBeCloseTo(0.40, 2);
    });

    it('paying at the most expensive end scores zero, and says how much it cost', async () => {
        const trip = await createTrip(USER, {});
        await mkReceipt(trip);
        await freezeTripComparison(trip, 4.03, [1.44, 1.88, 1.98, 2.23, 2.47]);
        const s = await computePlanningScore(trip);
        expect(s.storeChoice).toBe(0);
        expect(s.storeHeadroomEur).toBeCloseTo(2.59, 2);
    });

    it('genuinely equal prices everywhere still score 1 (nothing to beat)', async () => {
        const trip = await createTrip(USER, {});
        await mkReceipt(trip);
        await freezeTripComparison(trip, 5.00, [5.00, 5.00, 5.00]);
        const s = await computePlanningScore(trip);
        expect(s.storeChoice).toBe(1);
    });

    it('with no trip comparison cached, the per-receipt snapshots still answer', async () => {
        const trip = await createTrip(USER, {});
        const receipt = await mkReceipt(trip);
        await q(
            `INSERT INTO ReceiptComparisonSnapshot (receiptId, paidTotal, medianAltTotal, cheapestAltTotal, altCount, computedAt)
             VALUES (?,?,?,?,?,NOW())`, [receipt, 9.00, 10.00, 8.00, 4]);
        const s = await computePlanningScore(trip);   // allowLiveComparison off
        // 0.5 + 0.5·(10−9)/(10−8) = 0.75
        expect(s.storeChoice).toBeCloseTo(0.75, 2);
    });

    it('no comparison of any kind → storeChoice is null, not a guess', async () => {
        const trip = await createTrip(USER, {});
        await mkReceipt(trip);
        const s = await computePlanningScore(trip);
        expect(s.storeChoice).toBeNull();
    });
});
