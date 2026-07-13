import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser, tokenFor } from './helpers/authedRequest.js';
import { issueSessionToken } from '../src/services/authService.js';

/**
 * Object-level authorization on the receipt API (the audit's beta-blocker IDOR class).
 * A receipt is created by USER_A; USER_B (and an anonymous caller) must be refused.
 */

const USER_A = 'authtest-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'authtest-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHAIN_ID = 9971;
const STORE_ID = 9971;

let receiptId: number;

beforeAll(async () => {
    await primeTokens(USER_A, USER_B);
    const conn = await (pool as any).getConnection();
    try {
        await conn.query('DELETE FROM Receipt WHERE userId IN (?,?)', [USER_A, USER_B]);
        await conn.query('DELETE FROM Store WHERE id = ?', [STORE_ID]);
        await conn.query('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
        await conn.query('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'Auth Test Chain']);
        await conn.query('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_ID, CHAIN_ID, 'Auth Test Store', 'Test St. 1']);
        await conn.query('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER_A]);
        await conn.query('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER_B]);
    } finally {
        conn.release();
    }

    // USER_A creates a receipt (owner comes from the token, not the body).
    const res = await asUser(app, USER_A).post('/api/receipts').send({
        userId: 'ignored-body-value',
        filePath: 'auth-test.jpg',
        fileType: 'image/jpeg',
        parsedData: {
            header: { storeId: STORE_ID, chainId: CHAIN_ID },
            footer: { receiptNo: `AUTH-${Date.now()}`, date: '2025-01-01' },
            products: [{ name: 'X', storeProductId: null, matchConfirmed: false, price: 1.5, promoPrice: null, quantity: 1, unit: 'vnt', altMatches: [] }],
        },
    });
    expect(res.status).toBe(201);
    receiptId = res.body.id;
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query('DELETE FROM ReceiptItem WHERE receiptId = ?', [receiptId]);
        await conn.query('DELETE FROM Price WHERE receiptId = ?', [receiptId]);
        await conn.query('DELETE FROM Receipt WHERE userId IN (?,?)', [USER_A, USER_B]);
        await conn.query('DELETE FROM Store WHERE id = ?', [STORE_ID]);
        await conn.query('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
        await conn.query('DELETE FROM User WHERE id IN (?,?)', [USER_A, USER_B]);
    } finally {
        conn.release();
    }
});

describe('receipt API — authentication', () => {
    it('POST /api/users returns an anonymous session token', async () => {
        const uuid = '00000000-0000-4000-8000-00000000a17e';
        const res = await request(app).post('/api/users').send({ id: uuid });
        expect([200, 201]).toContain(res.status);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.token.length).toBeGreaterThan(20);
        await pool.query('DELETE FROM User WHERE id = ?', [uuid]);
    });

    it('rejects a receipt read with no token (401)', async () => {
        const res = await request(app).get(`/api/receipts/${receiptId}`);
        expect(res.status).toBe(401);
    });

    it('rejects a receipt read with a malformed token (401)', async () => {
        const res = await request(app).get(`/api/receipts/${receiptId}`).set('Authorization', 'Bearer not-a-jwt');
        expect(res.status).toBe(401);
    });

    it('the owner CAN read their receipt (200)', async () => {
        const res = await asUser(app, USER_A).get(`/api/receipts/${receiptId}`);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(receiptId);
    });
});

describe('receipt API — object-level authorization (IDOR closed)', () => {
    it("a different user cannot READ another user's receipt (403)", async () => {
        const res = await asUser(app, USER_B).get(`/api/receipts/${receiptId}`);
        expect(res.status).toBe(403);
    });

    it("a different user cannot read another user's IMAGE (403)", async () => {
        const res = await asUser(app, USER_B).get(`/api/receipts/${receiptId}/image`);
        expect(res.status).toBe(403);
    });

    it("a different user cannot TAMPER via PUT autosave (403)", async () => {
        const res = await asUser(app, USER_B).put(`/api/receipts/${receiptId}`).send({
            parsedData: { header: {}, footer: {}, products: [] },
        });
        expect(res.status).toBe(403);
    });

    it("a different user cannot repoint the image via PATCH file-path (403)", async () => {
        const res = await asUser(app, USER_B).patch(`/api/receipts/${receiptId}/file-path`).send({ filePath: 'evil.jpg' });
        expect(res.status).toBe(403);
    });

    it("a non-existent receipt id returns 404 (not a 403 owner-probe oracle)", async () => {
        const res = await asUser(app, USER_A).get('/api/receipts/999999123');
        expect(res.status).toBe(404);
    });

    it("cannot list another user's receipts via /users/:userId/receipts (403)", async () => {
        const res = await request(app)
            .get(`/api/users/${USER_A}/receipts`)
            .set('Authorization', `Bearer ${tokenFor(USER_B)}`);
        expect(res.status).toBe(403);
    });

    it("the owner CAN list their own receipts (200)", async () => {
        const res = await request(app)
            .get(`/api/users/${USER_A}/receipts`)
            .set('Authorization', `Bearer ${tokenFor(USER_A)}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('a valid token but for an unrelated fresh user is still refused (403), proving token≠bypass', async () => {
        const strangerToken = await issueSessionToken('authtest-cccc-cccc-cccc-cccccccccccc');
        const res = await request(app).get(`/api/receipts/${receiptId}`).set('Authorization', `Bearer ${strangerToken}`);
        expect(res.status).toBe(403);
    });
});
