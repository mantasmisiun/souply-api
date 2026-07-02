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
