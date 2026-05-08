/**
 * Performance test: swipe-queue endpoint must respond in < 2 000 ms even while
 * fallback price propagation is running in the background.
 *
 * Root cause of the original bug:
 *   - A 20-product Maxima receipt with priceVerified items triggered 20 parallel
 *     propagateFallbackPrices() calls, each spawning up to 239 individual INSERTs
 *     (~4 800 concurrent DB queries). This exhausted the connection pool and
 *     blocked the swipe-queue query for 10–30 s.
 *   - The fix collapses all propagation into 3 queries via propagateAllFallbackPrices.
 *
 * This test seeds realistic data (real Maxima chain = 240 stores, 10 SP pairs),
 * POSTs a receipt that triggers propagation, then immediately GETs the swipe queue
 * and asserts the round-trip is well within the 8 s client timeout.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(60_000); // allow up to 60 s for propagation to settle

const USER_PERF = 'perftest-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MAXIMA_CHAIN_ID = 1; // real Maxima chain in the test DB (240 stores)

// Seed IDs — use high values unlikely to collide with real data.
const PERF_CAT = 9920;
const PERF_PROD_BASE = 9920; // products 9920..9929
const PERF_SP_BASE   = 9920; // StoreProducts 9920..9929 (linked to Maxima chain)
const PERF_SP_ALT_BASE = 9930; // alt candidates 9930..9939
const PERF_PROD_ALT_BASE = 9930;

const ITEM_COUNT = 10; // simulate 10 matched products (realistic receipt)

beforeAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        // Clean up any previous run
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId = ?`, [USER_PERF]);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_PERF]);
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_PERF]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_PERF]);
        await conn.query(`DELETE FROM Basket WHERE userId = ?`, [USER_PERF]);
        await conn.query(`DELETE FROM Receipt WHERE userId = ?`, [USER_PERF]);
        await conn.query(`DELETE FROM User WHERE id = ?`, [USER_PERF]);

        // Wipe our seed SPs and Products
        const spIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_SP_BASE + i);
        const altSpIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_SP_ALT_BASE + i);
        const prodIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_PROD_BASE + i);
        const altProdIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_PROD_ALT_BASE + i);
        await conn.query(`DELETE FROM Price WHERE storeProductId IN (?)`, [[...spIds, ...altSpIds]]);
        await conn.query(`DELETE FROM StoreProduct WHERE id IN (?)`, [[...spIds, ...altSpIds]]);
        await conn.query(`DELETE FROM Product WHERE id IN (?)`, [[...prodIds, ...altProdIds]]);

        await conn.query(`SET foreign_key_checks = 1`);

        // Verify Maxima chain exists with stores
        const [chainRows]: any = await conn.query(
            `SELECT COUNT(*) as cnt FROM Store WHERE chainId = ?`,
            [MAXIMA_CHAIN_ID],
        );
        if (chainRows[0].cnt < 10) {
            throw new Error(`Maxima chain (id=${MAXIMA_CHAIN_ID}) must have stores in the test DB. Found: ${chainRows[0].cnt}`);
        }

        // Get a real Maxima store to use as receipt source
        const [storeRows]: any = await conn.query(
            `SELECT id FROM Store WHERE chainId = ? LIMIT 1`,
            [MAXIMA_CHAIN_ID],
        );
        (global as any).__PERF_STORE_ID__ = storeRows[0].id;

        // Seed reference data
        await conn.query(`INSERT INTO Category (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id`, [PERF_CAT, 'Perf Test Cat']);
        for (let i = 0; i < ITEM_COUNT; i++) {
            await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`,
                [PERF_PROD_BASE + i, PERF_CAT, `Perf Product ${i}`]);
            await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`,
                [PERF_PROD_ALT_BASE + i, PERF_CAT, `Perf Alt Product ${i}`]);
            await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
                [PERF_SP_BASE + i, PERF_PROD_BASE + i, MAXIMA_CHAIN_ID, `Perf SP ${i}`]);
            await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
                [PERF_SP_ALT_BASE + i, PERF_PROD_ALT_BASE + i, MAXIMA_CHAIN_ID, `Perf Alt SP ${i}`]);
        }

        await conn.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0`, [USER_PERF]);
    } finally {
        conn.release();
    }
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId = ?`, [USER_PERF]);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_PERF]);
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_PERF]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [USER_PERF]);
        await conn.query(`DELETE FROM Basket WHERE userId = ?`, [USER_PERF]);
        await conn.query(`DELETE FROM Receipt WHERE userId = ?`, [USER_PERF]);
        await conn.query(`DELETE FROM User WHERE id = ?`, [USER_PERF]);

        const spIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_SP_BASE + i);
        const altSpIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_SP_ALT_BASE + i);
        const prodIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_PROD_BASE + i);
        const altProdIds = Array.from({ length: ITEM_COUNT }, (_, i) => PERF_PROD_ALT_BASE + i);
        await conn.query(`DELETE FROM Price WHERE storeProductId IN (?)`, [[...spIds, ...altSpIds]]);
        await conn.query(`DELETE FROM StoreProduct WHERE id IN (?)`, [[...spIds, ...altSpIds]]);
        await conn.query(`DELETE FROM Product WHERE id IN (?)`, [[...prodIds, ...altProdIds]]);
        await conn.query(`DELETE FROM Category WHERE id = ?`, [PERF_CAT]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
    await pool.end();
});

function makeProducts(storeId: number) {
    return Array.from({ length: ITEM_COUNT }, (_, i) => ({
        name: `Perf Product ${i}`,
        storeProductId: PERF_SP_BASE + i,
        matchConfirmed: true,
        priceVerified: true, // triggers fallback propagation for all items
        price: 1.50 + i * 0.10,
        promoPrice: null,
        quantity: 1,
        unit: 'vnt',
        altMatches: [
            { storeProductId: PERF_SP_ALT_BASE + i, matchScore: 0.72, autoMatched: false },
        ],
    }));
}

describe('Swipe queue — performance with real Maxima chain (240 stores)', () => {
    let receiptId: number;

    it('POST /api/receipts with 10 priceVerified items completes fast (< 3 s)', async () => {
        const storeId = (global as any).__PERF_STORE_ID__;
        const t0 = Date.now();
        const res = await request(app).post('/api/receipts').send({
            userId: USER_PERF,
            filePath: 'perf-test.jpg',
            fileType: 'image/jpeg',
            parsedData: {
                header: { storeId, chainId: MAXIMA_CHAIN_ID },
                footer: { receiptNo: `PERF-${Date.now()}`, date: '2025-05-01' },
                products: makeProducts(storeId),
            },
        });
        const elapsed = Date.now() - t0;
        console.log(`POST /api/receipts took ${elapsed} ms`);
        expect(res.status).toBe(201);
        receiptId = res.body.id;
        expect(elapsed).toBeLessThan(3_000);
    });

    it('GET swipe-queue responds in < 2 000 ms immediately after receipt save (while propagation may still run)', async () => {
        // This is the critical assertion: the swipe queue must not be blocked
        // by background fallback propagation. Previously failed at 10–20 s.
        const t0 = Date.now();
        const res = await request(app)
            .get(`/api/receipts/${receiptId}/swipe-queue`)
            .query({ userId: USER_PERF });
        const elapsed = Date.now() - t0;
        console.log(`GET swipe-queue took ${elapsed} ms`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.items)).toBe(true);
        expect(elapsed).toBeLessThan(2_000);
    });

    it('swipe-queue items contain the expected alt candidates', async () => {
        const res = await request(app)
            .get(`/api/receipts/${receiptId}/swipe-queue`)
            .query({ userId: USER_PERF });
        expect(res.status).toBe(200);
        // All 10 lines should have at least one candidate
        expect(res.body.items.length).toBeGreaterThan(0);
        // Each item has the alt SP as a candidate
        const allCandidateSpIds = res.body.items.flatMap((item: any) =>
            item.candidates.map((c: any) => c.storeProductId),
        );
        for (let i = 0; i < ITEM_COUNT; i++) {
            expect(allCandidateSpIds).toContain(PERF_SP_ALT_BASE + i);
        }
    });

    it('GET /api/receipts/:id responds in < 2 000 ms (existing-receipt mode)', async () => {
        const t0 = Date.now();
        const res = await request(app).get(`/api/receipts/${receiptId}`);
        const elapsed = Date.now() - t0;
        console.log(`GET /api/receipts/${receiptId} took ${elapsed} ms`);
        expect(res.status).toBe(200);
        expect(elapsed).toBeLessThan(2_000);
    });
});
