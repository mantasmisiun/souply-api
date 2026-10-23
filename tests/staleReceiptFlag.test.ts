import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { createTrip } from '../src/models/tripModel.js';

/**
 * "IS THIS THE RIGHT RECEIPT?" — the ⚠ badge on a trip's receipt card.
 *
 * The flag used to ask "was the receipt >30 days old WHEN UPLOADED", which is
 * the wrong question for a receipt that was uploaded long ago and only later
 * attached to a trip: a Maxima receipt from April, uploaded in April, attached
 * to a trip created in July scored 0 days and showed no warning at all — while
 * a receipt of the same age uploaded fresh onto that trip did.
 *
 * The question that matters is "is this receipt old relative to the SHOPPING it
 * documents", so the flag anchors on the trip, falling back to uploadedAt when
 * the trip predates the receipt (plan Monday, shop Friday → still fresh).
 */

const USER = 'stale-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAIN_ID = 9967;
const STORE = 99671;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

// createTrip (not a raw INSERT) so the TripMember row exists — the endpoint
// 404s non-members. createdAt is then set to the date under test.
const mkTrip = async (createdAt: string, isAdHoc = false): Promise<number> => {
    const id = await createTrip(USER, { isAdHoc });
    await q('UPDATE Trip SET createdAt = ? WHERE id = ?', [createdAt, id]);
    return id;
};
const mkReceipt = async (tripId: number, receiptDate: string, uploadedAt: string): Promise<number> => {
    const r = await q(
        `INSERT INTO Receipt (userId, storeId, filePath, receiptDate, uploadedAt, tripId,
                              processingStatus, mandatorySwipesRequired, mandatorySwipesCompleted)
         VALUES (?,?,?,?,?,?, 'completed', 0, 0)`,
        [USER, STORE, 'test://receipt.jpg', receiptDate, uploadedAt, tripId]);
    return Number(r.insertId);
};
const staleOf = async (tripId: number, receiptId: number): Promise<boolean> => {
    const res = await asUser(app, USER).get(`/api/trips/${tripId}/receipts`);
    const row = (res.body as any[]).find((r: any) => r.id === receiptId);
    return !!row?.staleReceipt;
};

beforeAll(async () => {
    await primeTokens(USER);
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'Stale Chain']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id',
        [STORE, CHAIN_ID, 'Stale Store', 'Test St. 9']);
});

afterAll(async () => {
    await q('DELETE FROM Receipt WHERE userId = ?', [USER]);
    await q('DELETE FROM TripMember WHERE userId = ?', [USER]);
    await q('DELETE FROM Trip WHERE createdByUserId = ?', [USER]);
    await q('DELETE FROM Store WHERE id = ?', [STORE]);
    await q('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
    await (pool as any).end();
});

describe('staleReceipt', () => {
    it('THE BUG: an old receipt attached to a much later trip is flagged', async () => {
        // Uploaded the day it was issued (so the old rule scored 0 days), then
        // attached to a trip created three months later.
        const trip = await mkTrip('2026-07-25 21:44:14');
        const receipt = await mkReceipt(trip, '2026-04-24 20:05:43', '2026-04-24 20:05:43');
        expect(await staleOf(trip, receipt)).toBe(true);
    });

    it('a receipt from the same day as the trip is not flagged', async () => {
        const trip = await mkTrip('2026-07-25 10:00:00');
        const receipt = await mkReceipt(trip, '2026-07-25 14:56:00', '2026-07-25 15:10:00');
        expect(await staleOf(trip, receipt)).toBe(false);
    });

    it('28 days stays under the threshold', async () => {
        const trip = await mkTrip('2026-07-25 13:37:46');
        const receipt = await mkReceipt(trip, '2026-06-27 09:15:00', '2026-07-25 13:42:42');
        expect(await staleOf(trip, receipt)).toBe(false);
    });

    it('a long-uploaded receipt on its own old trip is still judged on upload time', async () => {
        // Trip PREDATES the receipt (planned first, shopped later) → uploadedAt
        // is the anchor, so a fresh receipt on an old plan stays unflagged.
        const trip = await mkTrip('2026-05-01 09:00:00');
        const receipt = await mkReceipt(trip, '2026-05-20 18:00:00', '2026-05-20 18:30:00');
        expect(await staleOf(trip, receipt)).toBe(false);
    });

    it('ad-hoc trips never flag — the trip IS the uploaded receipt', async () => {
        const trip = await mkTrip('2026-07-25 21:44:14', true);
        const receipt = await mkReceipt(trip, '2026-04-24 20:05:43', '2026-04-24 20:05:43');
        expect(await staleOf(trip, receipt)).toBe(false);
    });
});
