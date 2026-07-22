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
const CHAIN_ID = 9964;
const STORE_A = 99641;
const STORE_B = 99642;

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
    await q('DELETE FROM TripLineLink WHERE createdByUserId = ?', [USER]);
    await q('DELETE FROM StoreProduct WHERE id = 95011');
    await q('DELETE FROM Product WHERE id IN (501, 502)');
    await q('DELETE FROM Category WHERE id = 9970');
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
        expect(la.body.tripId).toBe(tripId); // clients land back on the trip
        listA = la.body.id ?? la.body.listId;
        const lb = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_B, basketId });
        expect([200, 201]).toContain(lb.status);

        const rows = await q('SELECT id, tripId FROM ShoppingList WHERE userId = ? AND basketId = ?', [USER, basketId]);
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(r.tripId).toBe(tripId);
    });

    it('DELETE /baskets/:id/shopping-lists reconciles the store selection (owner only)', async () => {
        // A stranger cannot wipe the owner's lists.
        const STRANGER = 'trplk-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        await primeTokens(STRANGER);
        expect((await asUser(app, STRANGER).delete(`/api/baskets/${basketId}/shopping-lists`)).status).toBe(403);
        expect(await q('SELECT id FROM ShoppingList WHERE basketId = ?', [basketId])).toHaveLength(2);

        // Owner replaces the selection: old lists gone, trip survives, re-create
        // reattaches to the SAME trip (members/receipts preserved).
        expect((await asUser(app, USER).delete(`/api/baskets/${basketId}/shopping-lists`)).status).toBe(204);
        expect(await q('SELECT id FROM ShoppingList WHERE basketId = ?', [basketId])).toHaveLength(0);
        expect(await q('SELECT id FROM Trip WHERE id = ?', [tripId])).toHaveLength(1);

        const re = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_A, basketId });
        expect([200, 201]).toContain(re.status);
        expect(re.body.tripId).toBe(tripId);
        listA = re.body.id ?? re.body.listId;
        const lb = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_B, basketId });
        expect([200, 201]).toContain(lb.status);
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

    it('per-trip stats aggregate from ReceiptItem (spend, chain, member split)', async () => {
        // The earlier test linked ONE receipt (on listA) into the trip. Give
        // it two items: 2×1.50 regular + 1×0.80 promo (promo price wins).
        const [receipt] = await q('SELECT id FROM Receipt WHERE userId = ? AND tripId = ?', [USER, tripId]);
        await q("INSERT INTO ReceiptItem (receiptId, lineIdx, name, price, quantity) VALUES (?, 0, 'a', 1.50, 2)", [receipt.id]);
        await q("INSERT INTO ReceiptItem (receiptId, lineIdx, name, price, promoPrice, quantity) VALUES (?, 1, 'b', 1.20, 0.80, 1)", [receipt.id]);

        const r = await asUser(app, USER).get(`/api/trips/${tripId}/stats`);
        expect(r.status).toBe(200);
        expect(r.body.receiptCount).toBe(1);
        expect(r.body.totalSpent).toBeCloseTo(3.80); // 2×1.50 + 0.80
        expect(r.body.chainBreakdown).toHaveLength(1);
        expect(r.body.chainBreakdown[0].chainName).toBe('TripLink Chain');
        expect(r.body.memberSpend).toHaveLength(1);
        expect(r.body.memberSpend[0].userId).toBe(USER);
        expect(r.body.memberSpend[0].receiptCount).toBe(1);
    });

    it('planning score: coverage/discipline/precision + manual link/unlink', async () => {
        // Plan: listA gets TWO items (products 501, 502); the receipt (already
        // in the trip, from the stats test) carries product 501 at 3.00 and an
        // unmatched line at 0.80. Auto pair on 501 → coverage 0.5,
        // discipline 3.00/3.80, precision 1.
        await q("INSERT INTO Category (id, name) VALUES (9970, 'Score Cat') ON DUPLICATE KEY UPDATE name=VALUES(name)");
        await q("INSERT INTO Product (id, name, categoryId) VALUES (501,'Score Milk', 9970), (502,'Score Bread', 9970) ON DUPLICATE KEY UPDATE name=VALUES(name)");
        await q("INSERT INTO StoreProduct (id, chainId, productId, storeProductName) VALUES (95011, ?, 501, 'Score Milk SP') ON DUPLICATE KEY UPDATE productId=VALUES(productId)", [CHAIN_ID]);
        const [receipt] = await q('SELECT id FROM Receipt WHERE userId = ? AND tripId = ?', [USER, tripId]);
        // Re-point the stats-test items: line a → product 501, line b stays unmatched.
        await q("UPDATE ReceiptItem SET matchedSpId = 95011, price = 1.50, promoPrice = NULL, quantity = 2 WHERE receiptId = ? AND lineIdx = 0", [receipt.id]);
        const li1 = await q("INSERT INTO ShoppingListItem (listId, productId, quantity) VALUES (?, 501, 2)", [listA]);
        const li2 = await q("INSERT INTO ShoppingListItem (listId, productId, quantity) VALUES (?, 502, 1)", [listA]);

        let r = await asUser(app, USER).get(`/api/trips/${tripId}/score`);
        expect(r.status).toBe(200);
        expect(r.body.coverage).toBeCloseTo(0.5);
        expect(r.body.discipline).toBeCloseTo(3.0 / 3.8, 2);
        expect(r.body.precision).toBeCloseTo(1);
        expect(r.body.pairs).toHaveLength(1);
        expect(r.body.unmatchedListItems).toHaveLength(1);
        expect(r.body.unmatchedReceiptItems).toHaveLength(1);
        const expected = Math.round(100 * (0.4 * 0.5 + 0.4 * (3.0 / 3.8) + 0.2 * 1));
        expect(r.body.score).toBe(expected);

        // MANUAL link of the leftover pair (bread ↔ the 0.80 line, both sides
        // category-less → plausibility passes) lifts coverage to ~0.95.
        const link = await asUser(app, USER).post(`/api/trips/${tripId}/line-links`).send({
            listItemId: li2.insertId, receiptItemId: r.body.unmatchedReceiptItems[0].receiptItemId, action: 'link',
        });
        expect(link.status).toBe(200);
        expect(link.body.pairs).toHaveLength(2);
        expect(link.body.coverage).toBeCloseTo(0.95); // (1 + 0.9)/2

        // Unlink restores the previous state (manual row deleted).
        const unlink = await asUser(app, USER).post(`/api/trips/${tripId}/line-links`).send({
            listItemId: li2.insertId, receiptItemId: link.body.pairs[0].receiptItemId === li2.insertId ? 0 : link.body.pairs.find((p:any)=>p.source==='manual').receiptItemId, action: 'unlink',
        });
        expect(unlink.status).toBe(200);

        // Monthly series includes this month with a numeric score.
        const monthly = await asUser(app, USER).get('/api/planning-score/monthly');
        expect(monthly.status).toBe(200);
        const nowKey = new Date().toISOString().slice(0, 7);
        const m = monthly.body.find((x: any) => x.month === nowKey);
        expect(m).toBeTruthy();
        expect(typeof m.score).toBe('number');
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
