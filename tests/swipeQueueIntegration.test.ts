/**
 * Integration tests for the receipt swipe queue API endpoint.
 *
 * Covers the full path that caused the production crash:
 *   POST /api/receipts   → save receipt with candidates
 *   GET  /api/receipts/:id/swipe-queue → returns items / empty
 *   POST /api/swipe-votes             → record vote
 *   GET  /api/receipts/:id/swipe-queue → voted pair now filtered out
 *   GET  /api/receipts/:id            → receipt readable in existing mode
 *
 * The crash happened because:
 *   1. The swipe screen hung 20 s waiting for a slow DB then timed out.
 *   2. On navigation to receipt-process (existing mode), loadExistingReceipt
 *      had no catch block, so the AbortError from fetchWithTimeout became
 *      an unhandled promise rejection → crash.
 *
 * These tests assert the server-side shape and filtering so we can trust
 * the client-side error handling fix (catch block + 8 s timeout) is the
 * only remaining variable.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(20000);

const USER_SQ = 'sqtest-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Seed IDs (use high IDs unlikely to collide with real data in test DB)
const CHAIN_ID  = 9901;
const STORE_ID  = 9901;
const CAT_ID    = 9901;
const PROD_A    = 9901; // the product on the line (storeProductId = SP_A)
const PROD_B    = 9902; // a cross-chain alternative (storeProductId = SP_B)
const SP_A      = 9901; // StoreProduct that represents PROD_A in the chain
const SP_B      = 9902; // StoreProduct that represents PROD_B (cross-pair candidate)

beforeAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        // Wipe any leftovers from previous crashed runs
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_SQ]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_SQ]);
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_SQ]);
        await conn.query(`DELETE FROM Basket WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM Receipt WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM User WHERE id = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM StoreProduct WHERE id IN (?,?)`, [SP_A, SP_B]);
        await conn.query(`DELETE FROM Product WHERE id IN (?,?)`, [PROD_A, PROD_B]);
        await conn.query(`DELETE FROM Store WHERE id = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Category WHERE id = ?`, [CAT_ID]);
        await conn.query(`SET foreign_key_checks = 1`);

        // Seed reference data
        await conn.query(`INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id`, [CHAIN_ID, 'SQ Test Chain']);
        await conn.query(`INSERT INTO Store (id, chainId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`, [STORE_ID, CHAIN_ID, 'SQ Test Store']);
        await conn.query(`INSERT INTO Category (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id`, [CAT_ID, 'SQ Test Cat']);
        await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`, [PROD_A, CAT_ID, 'SQ Product A']);
        await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`, [PROD_B, CAT_ID, 'SQ Product B']);
        await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [SP_A, PROD_A, CHAIN_ID, 'SP A']);
        await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [SP_B, PROD_B, CHAIN_ID, 'SP B']);
        await conn.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0`, [USER_SQ]);
    } finally {
        conn.release();
    }
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_SQ]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_SQ]);
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_SQ]);
        await conn.query(`DELETE FROM Basket WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM Receipt WHERE userId = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM User WHERE id = ?`, [USER_SQ]);
        await conn.query(`DELETE FROM StoreProduct WHERE id IN (?,?)`, [SP_A, SP_B]);
        await conn.query(`DELETE FROM Product WHERE id IN (?,?)`, [PROD_A, PROD_B]);
        await conn.query(`DELETE FROM Store WHERE id = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Category WHERE id = ?`, [CAT_ID]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
    await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReceiptPayload(opts: { priceVerified?: boolean; altMatches?: any[] } = {}) {
    return {
        userId: USER_SQ,
        filePath: 'sq-test.jpg',
        fileType: 'image/jpeg',
        parsedData: {
            header: { storeId: STORE_ID, chainId: CHAIN_ID },
            footer: { receiptNo: `SQ-${Date.now()}`, date: '2025-01-01' },
            products: [
                {
                    name: 'SP A product',
                    storeProductId: SP_A,
                    matchConfirmed: true,
                    priceVerified: opts.priceVerified ?? false,
                    price: 2.50,
                    promoPrice: null,
                    quantity: 1,
                    unit: 'vnt',
                    altMatches: opts.altMatches ?? [
                        { storeProductId: SP_B, matchScore: 0.72, autoMatched: false },
                    ],
                },
            ],
        },
    };
}

// ---------------------------------------------------------------------------
// GET /api/receipts/:id/swipe-queue — 404 on unknown receipt
// ---------------------------------------------------------------------------

describe('GET /api/receipts/:id/swipe-queue — validation', () => {
    it('returns 400 for non-numeric receipt id', async () => {
        const res = await request(app).get('/api/receipts/abc/swipe-queue');
        expect(res.status).toBe(400);
    });

    it('returns 404 for a receipt that does not exist', async () => {
        const res = await request(app).get('/api/receipts/999999999/swipe-queue');
        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// Full new-receipt → swipe queue → vote → re-fetch flow
// ---------------------------------------------------------------------------

describe('Receipt swipe queue — end-to-end flow', () => {
    let receiptId: number;

    it('POST /api/receipts saves receipt and returns id', async () => {
        const res = await request(app).post('/api/receipts').send(makeReceiptPayload());
        expect(res.status).toBe(201);
        receiptId = res.body.id;
        expect(typeof receiptId).toBe('number');
    });

    it('GET /api/receipts/:id returns the saved receipt (simulates existing-mode open)', async () => {
        const res = await request(app).get(`/api/receipts/${receiptId}`);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(receiptId);
        expect(res.body.parsedData).toBeTruthy();
        // parsedData must contain the three keys that loadExistingReceipt checks
        const parsed = typeof res.body.parsedData === 'string'
            ? JSON.parse(res.body.parsedData)
            : res.body.parsedData;
        expect(parsed.header).toBeTruthy();
        expect(parsed.footer).toBeTruthy();
        expect(Array.isArray(parsed.products)).toBe(true);
    });

    it('GET swipe-queue returns at least one item with the cross-pair candidate', async () => {
        const res = await request(app)
            .get(`/api/receipts/${receiptId}/swipe-queue`)
            .query({ userId: USER_SQ });
        expect(res.status).toBe(200);
        expect(res.body.receiptId).toBe(receiptId);
        expect(Array.isArray(res.body.items)).toBe(true);
        // The candidate SP_B should appear in queue because the pair (SP_A, SP_B) is unvoted
        const hasSpB = res.body.items.some((item: any) =>
            item.candidates?.some((c: any) => c.storeProductId === SP_B)
        );
        expect(hasSpB).toBe(true);
    });

    it('GET swipe-queue without userId still returns items (no filtering applied)', async () => {
        const res = await request(app).get(`/api/receipts/${receiptId}/swipe-queue`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('POST /api/swipe-votes records the cross-pair vote', async () => {
        const res = await request(app).post('/api/swipe-votes').send({
            userId: USER_SQ,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: SP_B,
            vote: 'different',
            dwellMs: 1500,
        });
        expect(res.status).toBe(200);
    });

    it('GET swipe-queue after vote returns empty items (pair now filtered)', async () => {
        const res = await request(app)
            .get(`/api/receipts/${receiptId}/swipe-queue`)
            .query({ userId: USER_SQ });
        expect(res.status).toBe(200);
        // The voted pair should no longer appear
        const hasSpB = res.body.items.some((item: any) =>
            item.candidates?.some((c: any) => c.storeProductId === SP_B)
        );
        expect(hasSpB).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Self-pair (priceVerified=true) — swipe card must not appear
// ---------------------------------------------------------------------------

describe('Receipt swipe queue — self-pair already verified', () => {
    let receiptId: number;

    it('creates a receipt where the line product price is already verified', async () => {
        const res = await request(app)
            .post('/api/receipts')
            .send(makeReceiptPayload({ priceVerified: true, altMatches: [] }));
        expect(res.status).toBe(201);
        receiptId = res.body.id;
    });

    it('swipe-queue returns empty items — no unverified self-pair', async () => {
        const res = await request(app)
            .get(`/api/receipts/${receiptId}/swipe-queue`)
            .query({ userId: USER_SQ });
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Receipt with no altMatches — queue must be empty
// ---------------------------------------------------------------------------

describe('Receipt swipe queue — no alt candidates', () => {
    let receiptId: number;

    it('creates a receipt with no alt matches and priceVerified=true', async () => {
        const res = await request(app)
            .post('/api/receipts')
            .send(makeReceiptPayload({ priceVerified: true, altMatches: [] }));
        expect(res.status).toBe(201);
        receiptId = res.body.id;
    });

    it('swipe-queue returns empty items', async () => {
        const res = await request(app)
            .get(`/api/receipts/${receiptId}/swipe-queue`)
            .query({ userId: USER_SQ });
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(0);
    });

    it('GET /api/receipts/:id still returns well-formed parsedData', async () => {
        const res = await request(app).get(`/api/receipts/${receiptId}`);
        expect(res.status).toBe(200);
        const parsed = typeof res.body.parsedData === 'string'
            ? JSON.parse(res.body.parsedData)
            : res.body.parsedData;
        expect(parsed.header).toBeTruthy();
        expect(parsed.footer).toBeTruthy();
        expect(Array.isArray(parsed.products)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// mandatorySwipesRequired shape on POST /api/receipts response
// ---------------------------------------------------------------------------

describe('POST /api/receipts — mandatorySwipesRequired in response', () => {
    it('returns mandatorySwipesRequired as a number in the response body', async () => {
        const res = await request(app)
            .post('/api/receipts')
            .send(makeReceiptPayload());
        expect(res.status).toBe(201);
        expect(typeof res.body.mandatorySwipesRequired).toBe('number');
        expect(res.body.mandatorySwipesRequired).toBeGreaterThanOrEqual(0);
    });
});
