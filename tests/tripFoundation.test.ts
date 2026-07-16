import pool from '../src/config/db.js';
import { createTrip, getTripById, isTripMember, getTripStage, getTripStageFacts, archiveTrip } from '../src/models/tripModel.js';

/**
 * Trip aggregate integration (Phase 1a): facts loader + derived stage over
 * REAL Basket/ShoppingList/Receipt rows, exercising the per-store slot
 * semantics end-to-end (including the "papildomas" off-plan receipt).
 */

const USER = 'tripfd-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAIN_ID = 9962;
const STORE_A = 99621;
const STORE_B = 99622;
const STORE_X = 99623; // off-plan store for the extra-receipt case

let tripId: number;
let basketId: number;
let listA: number;
let listB: number;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'TripFd Chain']);
    for (const [id, name] of [[STORE_A, 'TripFd A'], [STORE_B, 'TripFd B'], [STORE_X, 'TripFd X']] as const) {
        await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [id, CHAIN_ID, name, 'Test St. 3']);
    }
});

afterAll(async () => {
    await q('DELETE FROM Receipt WHERE userId = ?', [USER]);
    await q('DELETE FROM ShoppingList WHERE userId = ?', [USER]);
    await q('DELETE FROM Basket WHERE userId = ?', [USER]);
    await q('DELETE FROM TripMember WHERE userId = ?', [USER]);
    await q('DELETE FROM Trip WHERE createdByUserId = ?', [USER]);
    await (pool as any).end();
});

describe('trip foundation', () => {
    it('creates a trip with owner membership', async () => {
        tripId = await createTrip(USER, { name: 'Testinis apsipirkimas' });
        const trip = await getTripById(tripId);
        expect(trip?.createdByUserId).toBe(USER);
        expect(trip?.isAdHoc).toBe(0);
        expect(await isTripMember(tripId, USER)).toBe(true);
        expect(await isTripMember(tripId, 'someone-else-0000-0000-000000000000')).toBe(false);
    });

    it('stage 1 with an uncalculated basket', async () => {
        const r: any = await q('INSERT INTO Basket (userId, status, tripId) VALUES (?, "draft", ?)', [USER, tripId]);
        basketId = r.insertId;
        expect(await getTripStage(tripId)).toBe(1);
    });

    it('stage 2 once the basket is calculated', async () => {
        await q('UPDATE Basket SET hasBeenCalculated = 1, status = "compared" WHERE id = ?', [basketId]);
        expect(await getTripStage(tripId)).toBe(2);
    });

    it('stage 3 while any store list is active', async () => {
        const a: any = await q('INSERT INTO ShoppingList (userId, storeId, status, basketId, tripId) VALUES (?,?,"active",?,?)', [USER, STORE_A, basketId, tripId]);
        const b: any = await q('INSERT INTO ShoppingList (userId, storeId, status, basketId, tripId) VALUES (?,?,"active",?,?)', [USER, STORE_B, basketId, tripId]);
        listA = a.insertId; listB = b.insertId;
        expect(await getTripStage(tripId)).toBe(3);

        await q('UPDATE ShoppingList SET status = "completed" WHERE id = ?', [listA]);
        expect(await getTripStage(tripId)).toBe(3); // B still shopping
    });

    it('stage 4 when all lists completed but a slot is open', async () => {
        await q('UPDATE ShoppingList SET status = "completed" WHERE id = ?', [listB]);
        expect(await getTripStage(tripId)).toBe(4);
    });

    it('receipt on slot A + skip on slot B → stage 5; off-plan receipt counts as extra', async () => {
        await q('INSERT INTO Receipt (userId, storeId, filePath, tripId, uploaderUserId) VALUES (?,?,?,?,?)',
            [USER, STORE_A, 'test/tripfd-a.jpg', tripId, USER]);
        expect(await getTripStage(tripId)).toBe(4); // B slot still open

        await q('UPDATE ShoppingList SET receiptSkippedAt = NOW() WHERE id = ?', [listB]);
        expect(await getTripStage(tripId)).toBe(5);

        await q('INSERT INTO Receipt (userId, storeId, filePath, tripId, uploaderUserId) VALUES (?,?,?,?,?)',
            [USER, STORE_X, 'test/tripfd-x.jpg', tripId, USER]);
        const facts = await getTripStageFacts(tripId);
        expect(facts?.extraReceiptCount).toBe(1);
        expect(await getTripStage(tripId)).toBe(5); // extras never reopen slots
    });

    it('ad-hoc trips are stage 5 and archive/unarchive round-trips', async () => {
        const adHoc = await createTrip(USER, { isAdHoc: true, scoreExempt: true, archivedAt: new Date() });
        expect(await getTripStage(adHoc)).toBe(5);
        const t = await getTripById(adHoc);
        expect(t?.scoreExempt).toBe(1);
        expect(t?.archivedAt).not.toBeNull();
        await archiveTrip(adHoc, false);
        expect((await getTripById(adHoc))?.archivedAt).toBeNull();
    });
});
