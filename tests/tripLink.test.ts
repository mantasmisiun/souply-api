import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { ensureTripForReceipt, relinkReceiptToListTrip } from '../src/services/tripLinkService.js';

/**
 * Souply 2.0 Phase-4 trip minting at persist time: every basket / list /
 * ad-hoc receipt lives inside a trip from birth; the /api/trips list derives
 * stages; the upload→link flow re-points receipts and GCs churn ad-hoc trips.
 */

const USER = 'trplk-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAIN_ID = 9963;
const STORE_A = 99631;
const STORE_B = 99632;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

let basketId: number;
let tripId: number;
let listA: number;

beforeAll(async () => {
    await primeTokens(USER);
    await q('DELETE FROM Receipt WHERE userId = ?', [USER]);
    await q('DELETE FROM ShoppingListMember WHERE userId = ?', [USER]);
    await q('DELETE FROM ShoppingList WHERE userId = ?', [USER]);
    await q('DELETE FROM Basket WHERE userId = ?', [USER]);
    await q('DELETE FROM TripMember WHERE userId = ?', [USER]);
    await q('DELETE FROM Trip WHERE createdByUserId = ?', [USER]);
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'TripLink Chain']);
    for (const [id, name] of [[STORE_A, 'TripLink A'], [STORE_B, 'TripLink B']] as const) {
        await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [id, CHAIN_ID, name, 'Test St. 4']);
    }
});

afterAll(async () => {
    await q('DELETE FROM Receipt WHERE userId = ?', [USER]);
    await q('DELETE FROM ShoppingListMember WHERE userId = ?', [USER]);
    await q('DELETE FROM ShoppingList WHERE userId = ?', [USER]);
    await q('DELETE FROM Basket WHERE userId = ?', [USER]);
    await q('DELETE FROM TripMember WHERE userId = ?', [USER]);
    await q('DELETE FROM Trip WHERE createdByUserId = ?', [USER]);
    await (pool as any).end();
});

describe('trip minting at persist time', () => {
    it('POST /baskets mints a trip with owner membership', async () => {
        const b = await asUser(app, USER).post('/api/baskets').send({});
        expect([200, 201]).toContain(b.status);
        basketId = b.body.id;

        const [row] = await q('SELECT tripId FROM Basket WHERE id = ?', [basketId]);
        expect(row.tripId).not.toBeNull();
        tripId = row.tripId;
        const members = await q('SELECT * FROM TripMember WHERE tripId = ?', [tripId]);
        expect(members).toHaveLength(1);
        expect(members[0].userId).toBe(USER);
        expect(members[0].role).toBe('owner');
    });

    it('lists on the basket JOIN its trip (a split shares one trip)', async () => {
        const la = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_A, basketId });
        expect([200, 201]).toContain(la.status);
        listA = la.body.id ?? la.body.listId;
        const lb = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_B, basketId });
        expect([200, 201]).toContain(lb.status);

        const rows = await q('SELECT id, tripId FROM ShoppingList WHERE userId = ? AND basketId = ?', [USER, basketId]);
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(r.tripId).toBe(tripId);
    });

    it('GET /api/trips derives the stage and slot facts', async () => {
        const r = await asUser(app, USER).get('/api/trips');
        expect(r.status).toBe(200);
        const trip = r.body.find((t: any) => t.id === tripId);
        expect(trip).toBeTruthy();
        expect(trip.stage).toBe(3); // lists exist, not completed
        expect(trip.slots).toHaveLength(2);
        expect(trip.memberCount).toBe(1);
        expect(trip.slots.map((s: any) => s.storeId).sort()).toEqual([STORE_A, STORE_B]);

        // Completing every list moves the trip to stage 4 (receipts open).
        await q("UPDATE ShoppingList SET status='completed' WHERE basketId = ?", [basketId]);
        const r2 = await asUser(app, USER).get('/api/trips');
        expect(r2.body.find((t: any) => t.id === tripId).stage).toBe(4);
    });

    it('ad-hoc receipt mints a stage-5 scoreExempt trip; linking moves + GCs it', async () => {
        const ins = await q(
            "INSERT INTO Receipt (userId, storeId, filePath, fileType) VALUES (?, ?, '', 'image/jpeg')",
            [USER, STORE_A]);
        const receiptId = ins.insertId;

        const adhocTrip = await ensureTripForReceipt(receiptId, USER, null);
        const [t] = await q('SELECT * FROM Trip WHERE id = ?', [adhocTrip]);
        expect(t.isAdHoc).toBe(1);
        expect(t.scoreExempt).toBe(1);
        const trips = await asUser(app, USER).get('/api/trips');
        expect(trips.body.find((x: any) => x.id === adhocTrip).stage).toBe(5);

        // The link flow re-points the receipt at the list's trip and GCs
        // the churn ad-hoc trip (nothing else referenced it).
        await q('UPDATE Receipt SET shoppingListId = ? WHERE id = ?', [listA, receiptId]);
        await relinkReceiptToListTrip(receiptId, listA);
        const [after] = await q('SELECT tripId FROM Receipt WHERE id = ?', [receiptId]);
        expect(after.tripId).toBe(tripId);
        const gone = await q('SELECT id FROM Trip WHERE id = ?', [adhocTrip]);
        expect(gone).toHaveLength(0);
    });

    it('"Nepirkau čia" closes slots — skipping every open slot lands stage 5', async () => {
        // Lists are completed (stage 4 from the earlier test) and only ONE
        // receipt arrived (listA). Skip the other slot → all slots closed.
        const rows = await q('SELECT id FROM ShoppingList WHERE basketId = ? ORDER BY id', [basketId]);
        const listB = rows.find((r: any) => r.id !== listA).id;

        const skip = await asUser(app, USER).post(`/api/shopping-lists/${listB}/skip-receipt`).send({});
        expect(skip.status).toBe(200);
        let r = await asUser(app, USER).get('/api/trips');
        expect(r.body.find((t: any) => t.id === tripId).stage).toBe(5);

        // Unskip reopens the slot → back to stage 4.
        await asUser(app, USER).post(`/api/shopping-lists/${listB}/unskip-receipt`).send({});
        r = await asUser(app, USER).get('/api/trips');
        expect(r.body.find((t: any) => t.id === tripId).stage).toBe(4);
    });

    it('archive/unarchive round-trip via the member-gated endpoints', async () => {
        const a = await asUser(app, USER).post(`/api/trips/${tripId}/archive`).send({});
        expect(a.status).toBe(200);
        let r = await asUser(app, USER).get('/api/trips');
        expect(r.body.find((t: any) => t.id === tripId).archivedAt).not.toBeNull();

        const u = await asUser(app, USER).post(`/api/trips/${tripId}/unarchive`).send({});
        expect(u.status).toBe(200);
        r = await asUser(app, USER).get('/api/trips');
        expect(r.body.find((t: any) => t.id === tripId).archivedAt).toBeNull();
    });
});
