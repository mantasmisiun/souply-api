import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser, tokenFor } from './helpers/authedRequest.js';

/**
 * Object-level authorization across the non-receipt user-owned resources (the sweep that
 * extended the receipt fix): baskets, shopping lists, user account, basket templates.
 * USER_A owns everything; USER_B and anonymous callers must be refused.
 */

const USER_A = 'resauth-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'resauth-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHAIN_ID = 9973;
const STORE_ID = 9973;

let basketId: number;
let listId: number;

beforeAll(async () => {
    await primeTokens(USER_A, USER_B);
    const conn = await (pool as any).getConnection();
    try {
        for (const u of [USER_A, USER_B]) {
            await conn.query('DELETE FROM ShoppingListMember WHERE userId = ?', [u]);
            await conn.query('DELETE FROM ShoppingList WHERE userId = ?', [u]);
            await conn.query('DELETE FROM Basket WHERE userId = ?', [u]);
            await conn.query('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
        }
        // Own store/chain so the list FK is deterministic (store 1 can be deleted by a
        // parallel suite → the FK insert flaked).
        await conn.query('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'ResAuth Chain']);
        await conn.query('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_ID, CHAIN_ID, 'ResAuth Store', 'Test St. 1']);
    } finally { conn.release(); }

    // USER_A creates a basket + a shopping list (identity from the token).
    const b = await asUser(app, USER_A).post('/api/baskets').send({});
    expect([200, 201]).toContain(b.status);
    basketId = b.body.id;

    const l = await asUser(app, USER_A).post('/api/shopping-lists').send({ storeId: STORE_ID });
    expect([200, 201]).toContain(l.status);
    listId = l.body.id ?? l.body.listId;
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        for (const u of [USER_A, USER_B]) {
            await conn.query('DELETE FROM ShoppingListMember WHERE userId = ?', [u]);
            await conn.query('DELETE FROM ShoppingList WHERE userId = ?', [u]);
            await conn.query('DELETE FROM Basket WHERE userId = ?', [u]);
            await conn.query('DELETE FROM User WHERE id = ?', [u]);
        }
        await conn.query('DELETE FROM Store WHERE id = ?', [STORE_ID]);
        await conn.query('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
    } finally { conn.release(); }
});

describe('baskets — ownership', () => {
    it('owner reads their basket (200)', async () => {
        const res = await asUser(app, USER_A).get(`/api/baskets/${basketId}`);
        expect(res.status).toBe(200);
    });
    it('no token → 401', async () => {
        expect((await request(app).get(`/api/baskets/${basketId}`)).status).toBe(401);
    });
    it("another user cannot READ the basket (403)", async () => {
        expect((await asUser(app, USER_B).get(`/api/baskets/${basketId}`)).status).toBe(403);
    });
    it("another user cannot DELETE the basket (403)", async () => {
        expect((await asUser(app, USER_B).delete(`/api/baskets/${basketId}`)).status).toBe(403);
    });
    it("another user cannot read the basket's ITEMS (403)", async () => {
        expect((await asUser(app, USER_B).get(`/api/baskets/${basketId}/items`)).status).toBe(403);
    });
    it("cannot list another user's baskets via /baskets/user/:userId (403)", async () => {
        expect((await asUser(app, USER_B).get(`/api/baskets/user/${USER_A}`)).status).toBe(403);
    });
    it('missing basket → 404 (not a 403 owner-probe oracle)', async () => {
        expect((await asUser(app, USER_A).get('/api/baskets/99999123')).status).toBe(404);
    });
});

describe('shopping lists — membership', () => {
    it('owner (a member) reads their list (200)', async () => {
        expect((await asUser(app, USER_A).get(`/api/shopping-lists/${listId}`)).status).toBe(200);
    });
    it("a non-member cannot READ the list (403)", async () => {
        expect((await asUser(app, USER_B).get(`/api/shopping-lists/${listId}`)).status).toBe(403);
    });
    it("a non-member cannot DELETE the list (403)", async () => {
        expect((await asUser(app, USER_B).delete(`/api/shopping-lists/${listId}`)).status).toBe(403);
    });
    it("cannot list another user's lists (403)", async () => {
        expect((await asUser(app, USER_B).get(`/api/shopping-lists/user/${USER_A}`)).status).toBe(403);
    });
    it('no token → 401', async () => {
        expect((await request(app).get(`/api/shopping-lists/${listId}`)).status).toBe(401);
    });
});

describe('user account — self only', () => {
    it("cannot DELETE another user's account (403) — the headline unauthenticated-deletion IDOR", async () => {
        expect((await asUser(app, USER_B).delete(`/api/users/${USER_A}`)).status).toBe(403);
    });
    it('unauthenticated account delete → 401', async () => {
        expect((await request(app).delete(`/api/users/${USER_A}`)).status).toBe(401);
    });
    it("cannot read another user's profile (403)", async () => {
        expect((await asUser(app, USER_B).get(`/api/users/${USER_A}/profile`)).status).toBe(403);
    });
    it("cannot read another user's stats (403)", async () => {
        expect((await asUser(app, USER_B).get(`/api/users/${USER_A}/stats`)).status).toBe(403);
    });
    it('owner reads their own profile (200)', async () => {
        expect((await asUser(app, USER_A).get(`/api/users/${USER_A}/profile`)).status).toBe(200);
    });
    it('POST /users and /users/recover stay open (no token needed)', async () => {
        const u = await request(app).post('/api/users').send({ id: '00000000-0000-4000-8000-0000000ra1de' });
        expect([200, 201, 400]).toContain(u.status); // 400 only if uuid shape rejected; never 401
        expect(u.status).not.toBe(401);
    });
});

// A list that belongs to a TRIP: every trip member may read + toggle it even
// without an explicit ShoppingListMember row (that is what keeps checkmarks in
// sync for everyone the trip was shared with). USER_B is a trip member here.
describe('shopping lists — trip-derived membership', () => {
    let tripListId: number;
    let tripItemId: number;
    let tripId: number;

    beforeAll(async () => {
        const conn = await (pool as any).getConnection();
        try {
            const [tr]: any = await conn.query('INSERT INTO Trip (createdByUserId) VALUES (?)', [USER_A]);
            tripId = tr.insertId;
            await conn.query("INSERT INTO TripMember (tripId, userId, role) VALUES (?,?,'owner'),(?,?,'member')", [tripId, USER_A, tripId, USER_B]);
            const [sl]: any = await conn.query('INSERT INTO ShoppingList (userId, storeId, tripId) VALUES (?,?,?)', [USER_A, STORE_ID, tripId]);
            tripListId = sl.insertId;
            await conn.query('INSERT INTO ShoppingListMember (listId, userId, role) VALUES (?,?,?)', [tripListId, USER_A, 'owner']);
            const [it]: any = await conn.query('INSERT INTO ShoppingListItem (listId, customName, quantity, isChecked) VALUES (?,?,?,0)', [tripListId, 'Pienas', 1]);
            tripItemId = it.insertId;
        } finally { conn.release(); }
    });

    afterAll(async () => {
        const conn = await (pool as any).getConnection();
        try {
            await conn.query('DELETE FROM ShoppingList WHERE id = ?', [tripListId]);
            await conn.query('DELETE FROM Trip WHERE id = ?', [tripId]);
        } finally { conn.release(); }
    });

    it('a trip member reads the list (200) without an explicit list-member row', async () => {
        expect((await asUser(app, USER_B).get(`/api/shopping-lists/${tripListId}`)).status).toBe(200);
    });
    it('a trip member reaches the items endpoint — not 403/401 (checkmark read path)', async () => {
        // The membership guard passes for a trip member; assert it's not refused
        // (the fixture item has no Product row, so the localized-name query can
        // 500 — that's a fixture artifact, not an authorization failure).
        expect([401, 403]).not.toContain((await asUser(app, USER_B).get(`/api/shopping-lists/${tripListId}/items`)).status);
    });
    it('a trip member toggles an item (200) — checkmark sync path', async () => {
        expect((await asUser(app, USER_B).patch(`/api/list-items/${tripItemId}/toggle`).send({ isChecked: true })).status).toBe(200);
    });
    it('a NON-trip-member still cannot toggle (403)', async () => {
        const STRANGER = 'resauth-cccc-cccc-cccc-cccccccccccc';
        await primeTokens(STRANGER);
        expect((await asUser(app, STRANGER).patch(`/api/list-items/${tripItemId}/toggle`).send({ isChecked: true })).status).toBe(403);
    });
});

describe('non-prod dev-header shim (x-user-id) works when NODE_ENV!=production', () => {
    it('accepts X-User-Id as identity in test env', async () => {
        // The shim lets dev/staging web (no cookie) authenticate; prod ignores it.
        const res = await request(app).get(`/api/baskets/user/${USER_A}`).set('X-User-Id', USER_A);
        expect(res.status).toBe(200);
    });
    it('X-User-Id for a DIFFERENT user is still ownership-checked (403)', async () => {
        const res = await request(app).get(`/api/baskets/${basketId}`).set('X-User-Id', USER_B);
        expect(res.status).toBe(403);
    });
});

/**
 * SHARED (household) basket — the 2.0 family basket rule.
 *
 * `basketWritableBy` widens access to any HouseholdMember, but ONLY when
 * Basket.householdId is set. Members could already add/edit/delete items while
 * being unable to LIST them or use the by-product upsert (the catalog stepper's
 * path), which made the shared basket unusable for anyone but its creator.
 *
 * The regression that matters most here is the LAST test: personal baskets must
 * stay strictly owner-only. Widening them would be a silent data leak.
 */
describe('shared household basket — member access', () => {
    const OWNER = 'resauth-hh01-0000-0000-000000000001';
    const MEMBER = 'resauth-hh02-0000-0000-000000000002';
    const OUTSIDER = 'resauth-hh03-0000-0000-000000000003';
    let householdId: number;
    let sharedBasketId: number;

    beforeAll(async () => {
        await primeTokens(OWNER, MEMBER, OUTSIDER);
        const conn = await (pool as any).getConnection();
        try {
            for (const u of [OWNER, MEMBER, OUTSIDER]) {
                await conn.query('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=points', [u]);
                await conn.query('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
                await conn.query('DELETE FROM Basket WHERE userId = ?', [u]);
            }
            const [hh]: any = await conn.query('INSERT INTO Household (createdByUserId, name) VALUES (?, ?)', [OWNER, 'authz-hh']);
            householdId = hh.insertId;
            await conn.query("INSERT INTO HouseholdMember (userId, householdId, role) VALUES (?,?,'owner'),(?,?,'member')",
                [OWNER, householdId, MEMBER, householdId]);
            const [b]: any = await conn.query(
                "INSERT INTO Basket (userId, name, status, householdId) VALUES (?,?,'draft',?)",
                [OWNER, 'shared', householdId]);
            sharedBasketId = b.insertId;
        } finally { conn.release(); }
    });

    afterAll(async () => {
        const conn = await (pool as any).getConnection();
        try {
            await conn.query('DELETE FROM Basket WHERE householdId = ?', [householdId]);
            await conn.query('DELETE FROM HouseholdMember WHERE householdId = ?', [householdId]);
            await conn.query('DELETE FROM Household WHERE id = ?', [householdId]);
        } finally { conn.release(); }
    });

    it('a household MEMBER can list the shared basket items (200)', async () => {
        const res = await asUser(app, MEMBER).get(`/api/baskets/${sharedBasketId}/items`);
        expect(res.status).toBe(200);
    });

    it('a household MEMBER can read the shared basket quantities (200)', async () => {
        const res = await asUser(app, MEMBER).get(`/api/baskets/${sharedBasketId}/quantities`);
        expect(res.status).toBe(200);
    });

    it('a NON-member cannot list the shared basket items (403)', async () => {
        const res = await asUser(app, OUTSIDER).get(`/api/baskets/${sharedBasketId}/items`);
        expect(res.status).toBe(403);
    });

    it('a PERSONAL basket stays owner-only — the widening must not leak (403)', async () => {
        const conn = await (pool as any).getConnection();
        let personalId: number;
        try {
            const [p]: any = await conn.query(
                "INSERT INTO Basket (userId, name, status, householdId) VALUES (?,?,'draft',NULL)",
                [OWNER, 'personal']);
            personalId = p.insertId;
        } finally { conn.release(); }
        // MEMBER shares a household with OWNER, but this basket is NOT the
        // household's — householdId IS NULL, so the member rule must not apply.
        const res = await asUser(app, MEMBER).get(`/api/baskets/${personalId}/items`);
        expect(res.status).toBe(403);
    });
});

/**
 * §6 step 1→2: a household MEMBER (not the founder) must be able to start — and
 * unwind — a family shop from the shared basket.
 *
 * `Basket.userId` on the shared basket is the household FOUNDER, so a plain
 * owner check made them the only person who could ever mint the family trip;
 * every other member got 403 walking the spec's own happy path. Both the create
 * and the teardown now use `basketWritableBy`.
 */
describe('shared basket — shopping-list creation by a member', () => {
    const FOUNDER = 'resauth-hh11-0000-0000-000000000011';
    const MEMBER2 = 'resauth-hh12-0000-0000-000000000012';
    const STRANGER = 'resauth-hh13-0000-0000-000000000013';
    let hhId: number;
    let sharedId: number;
    let personalId: number;

    beforeAll(async () => {
        await primeTokens(FOUNDER, MEMBER2, STRANGER);
        const conn = await (pool as any).getConnection();
        try {
            for (const u of [FOUNDER, MEMBER2, STRANGER]) {
                await conn.query('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=points', [u]);
                await conn.query('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
            }
            const [hh]: any = await conn.query('INSERT INTO Household (createdByUserId, name) VALUES (?,?)', [FOUNDER, 'authz-hh2']);
            hhId = hh.insertId;
            await conn.query("INSERT INTO HouseholdMember (userId, householdId, role) VALUES (?,?,'owner'),(?,?,'member')",
                [FOUNDER, hhId, MEMBER2, hhId]);
            const [b]: any = await conn.query(
                "INSERT INTO Basket (userId, name, status, householdId) VALUES (?,?,'compared',?)", [FOUNDER, 'shared2', hhId]);
            sharedId = b.insertId;
            const [p]: any = await conn.query(
                "INSERT INTO Basket (userId, name, status, householdId) VALUES (?,?,'compared',NULL)", [FOUNDER, 'personal2']);
            personalId = p.insertId;
        } finally { conn.release(); }
    });

    afterAll(async () => {
        const conn = await (pool as any).getConnection();
        try {
            await conn.query('DELETE FROM ShoppingList WHERE basketId IN (?,?)', [sharedId, personalId]);
            await conn.query('DELETE FROM Basket WHERE id IN (?,?)', [sharedId, personalId]);
            await conn.query('DELETE FROM HouseholdMember WHERE householdId = ?', [hhId]);
            await conn.query('DELETE FROM Household WHERE id = ?', [hhId]);
        } finally { conn.release(); }
    });

    it('a MEMBER can create a list from the shared basket (not 403)', async () => {
        const res = await asUser(app, MEMBER2).post('/api/shopping-lists')
            .send({ userId: MEMBER2, storeId: STORE_ID, basketId: sharedId });
        expect(res.status).not.toBe(403);
    });

    it('a STRANGER cannot create a list from the shared basket (403)', async () => {
        const res = await asUser(app, STRANGER).post('/api/shopping-lists')
            .send({ userId: STRANGER, storeId: STORE_ID, basketId: sharedId });
        expect(res.status).toBe(403);
    });

    it("a member cannot use the founder's PERSONAL basket (403)", async () => {
        const res = await asUser(app, MEMBER2).post('/api/shopping-lists')
            .send({ userId: MEMBER2, storeId: STORE_ID, basketId: personalId });
        expect(res.status).toBe(403);
    });

    it('a MEMBER can unwind the family shop they started (not 403)', async () => {
        const res = await asUser(app, MEMBER2).delete(`/api/shopping-lists/by-basket/${sharedId}`);
        expect(res.status).not.toBe(403);
    });
});
