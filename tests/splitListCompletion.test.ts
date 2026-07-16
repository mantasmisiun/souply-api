import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';

/**
 * SPLIT-SAFE basket completion (souply 2.0 Phase-0 pre-work): a 2/3-store split
 * basket must become 'completed' only when EVERY store's list is completed.
 * The old behavior marked the whole basket terminal the moment the FIRST
 * store's list completed — a wrong terminal state that the trip backfill
 * would have inherited.
 */

const USER = 'splitc-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAIN_ID = 9961;
const STORE_A = 99611;
const STORE_B = 99612;

let basketId: number;
let listA: number;
let listB: number;

beforeAll(async () => {
    await primeTokens(USER);
    const conn = await (pool as any).getConnection();
    try {
        await conn.query('DELETE FROM ShoppingListMember WHERE userId = ?', [USER]);
        await conn.query('DELETE FROM ShoppingList WHERE userId = ?', [USER]);
        await conn.query('DELETE FROM Basket WHERE userId = ?', [USER]);
        await conn.query('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
        await conn.query('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'SplitComp Chain']);
        for (const [id, name] of [[STORE_A, 'SplitComp A'], [STORE_B, 'SplitComp B']] as const) {
            await conn.query('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [id, CHAIN_ID, name, 'Test St. 2']);
        }
    } finally { conn.release(); }

    const b = await asUser(app, USER).post('/api/baskets').send({});
    expect([200, 201]).toContain(b.status);
    basketId = b.body.id;

    const la = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_A, basketId });
    expect([200, 201]).toContain(la.status);
    listA = la.body.id ?? la.body.listId;

    const lb = await asUser(app, USER).post('/api/shopping-lists').send({ storeId: STORE_B, basketId });
    expect([200, 201]).toContain(lb.status);
    listB = lb.body.id ?? lb.body.listId;
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query('DELETE FROM ShoppingList WHERE userId = ?', [USER]);
        await conn.query('DELETE FROM Basket WHERE userId = ?', [USER]);
    } finally { conn.release(); }
});

const basketStatus = async (): Promise<string> => {
    const [rows]: any = await pool.query('SELECT status FROM Basket WHERE id = ?', [basketId]);
    return rows[0]?.status;
};

describe('split basket completion', () => {
    it('completing the FIRST of two lists does NOT complete the basket', async () => {
        const r = await asUser(app, USER)
            .patch(`/api/shopping-lists/${listA}/status`)
            .send({ status: 'completed' });
        expect(r.status).toBe(200);
        expect(await basketStatus()).not.toBe('completed');
    });

    it('completing the LAST list completes the basket', async () => {
        const r = await asUser(app, USER)
            .patch(`/api/shopping-lists/${listB}/status`)
            .send({ status: 'completed' });
        expect(r.status).toBe(200);
        expect(await basketStatus()).toBe('completed');
    });

    it('reopening one list flips the basket back to inProgress', async () => {
        const r = await asUser(app, USER)
            .patch(`/api/shopping-lists/${listA}/status`)
            .send({ status: 'active' });
        expect(r.status).toBe(200);
        expect(await basketStatus()).toBe('inProgress');

        // ...and re-completing it terminates the basket again.
        const r2 = await asUser(app, USER)
            .patch(`/api/shopping-lists/${listA}/status`)
            .send({ status: 'completed' });
        expect(r2.status).toBe(200);
        expect(await basketStatus()).toBe('completed');
    });
});
