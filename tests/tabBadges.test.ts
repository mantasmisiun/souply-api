import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';

/**
 * Souply 2.0 Phase-2 tab badges: ONE endpoint replacing the client's
 * 3-fetch poller. `trips` counts trip-ish units (active baskets ∪
 * standalone active lists ∪ completed receipt-less list groups, deduped
 * by basket) and must exclude the household shared basket; a split
 * awaiting receipts counts once.
 */

const USER = 'badge-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'badge-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHAIN_ID = 9962;
const STORE_A = 99621;
const STORE_B = 99622;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    await primeTokens(USER, OTHER);
    for (const u of [USER, OTHER]) {
        await q('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
        await q('DELETE FROM ShoppingList WHERE userId = ?', [u]);
        await q('DELETE FROM Basket WHERE userId = ?', [u]);
        await q('DELETE FROM TripMember WHERE userId = ?', [u]);
        await q('DELETE FROM Trip WHERE createdByUserId = ?', [u]);
        await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    }
    await q('DELETE FROM Household WHERE createdByUserId IN (?,?)', [USER, OTHER]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'Badge Chain']);
    for (const [id, name] of [[STORE_A, 'Badge A'], [STORE_B, 'Badge B']] as const) {
        await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [id, CHAIN_ID, name, 'Test St. 3']);
    }
});

afterAll(async () => {
    for (const u of [USER, OTHER]) {
        await q('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
        await q('DELETE FROM ShoppingList WHERE userId = ?', [u]);
        await q('DELETE FROM Basket WHERE userId = ?', [u]);
        await q('DELETE FROM TripMember WHERE userId = ?', [u]);
        await q('DELETE FROM Trip WHERE createdByUserId = ?', [u]);
    }
    await q('DELETE FROM Household WHERE createdByUserId IN (?,?)', [USER, OTHER]);
    await (pool as any).end();
});

const badges = async (uid = USER) => asUser(app, uid).get(`/api/users/${uid}/tab-badges`);

describe('GET /users/:id/tab-badges', () => {
    it('starts at zero', async () => {
        const r = await badges();
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ trips: 0, pendingSwipes: 0 });
    });

    it('counts an active basket and its lists as ONE unit', async () => {
        const b = await asUser(app, USER).post('/api/baskets').send({});
        const basketId = b.body.id;
        await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_A, basketId });
        await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_B, basketId });

        const r = await badges();
        expect(r.body.trips).toBe(1);
    });

    it('a completed split awaiting receipts still counts once; standalone active list adds one', async () => {
        // Complete the basket + both lists, no receipts → still ONE stage-4 unit.
        await q("UPDATE Basket SET status='completed' WHERE userId = ?", [USER]);
        await q("UPDATE ShoppingList SET status='completed' WHERE userId = ?", [USER]);
        let r = await badges();
        expect(r.body.trips).toBe(1);

        // Standalone active list (no basket) → separate unit. Created via
        // the ENDPOINT (raw SQL would skip the Phase-4 trip minting the
        // Trip-based badge now counts).
        const sl = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_A });
        expect([200, 201]).toContain(sl.status);
        r = await badges();
        expect(r.body.trips).toBe(2);
    });

    it('excludes the household shared basket from the count', async () => {
        const h = await asUser(app, USER).post('/api/households').send({});
        expect(h.status).toBe(201);
        const r = await badges();
        expect(r.body.trips).toBe(2); // unchanged — shared draft basket ignored
    });

    it('is self-scoped', async () => {
        const r = await asUser(app, OTHER).get(`/api/users/${USER}/tab-badges`);
        expect([403, 404]).toContain(r.status);
    });
});
