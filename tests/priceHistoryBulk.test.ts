import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

/**
 * Perf audit #13 (server half) — GET /api/prices/store-products/history:
 * one request replaces the product-detail screen's serial per-SP loop.
 *
 * Contract under test:
 *   - `{ histories: { [spId]: rows[] } }`, one key per REQUESTED id
 *   - each rows[] is byte-identical to the single endpoint's response for
 *     that SP (same dedup + same prefer-non-fallback rule, applied PER SP)
 *   - unauthenticated, like the single endpoint (no token sent here)
 *   - 400 on missing/invalid spIds and above the 50-id cap
 */

const CHAIN_ID = 9977;
const STORE_ID = 99771;
const STORE_B = 99772;
const CAT_ID = 99770;
const PRODUCT_ID = 997700;
const SP_REAL = 997701;      // has verified receipt prices + one fallback → non-fallback only
const SP_FALLBACK = 997702;  // scraped/fallback prices only → those are served
const SP_EMPTY = 997703;     // exists but has no Price rows → []

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    await q('DELETE FROM Price WHERE storeProductId IN (?,?,?)', [SP_REAL, SP_FALLBACK, SP_EMPTY]);
    await q('DELETE FROM StoreProduct WHERE id IN (?,?,?)', [SP_REAL, SP_FALLBACK, SP_EMPTY]);
    await q('DELETE FROM Product WHERE id = ?', [PRODUCT_ID]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'BulkHist Chain']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_ID, CHAIN_ID, 'BulkHist Store', 'Test St. 7']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_B, CHAIN_ID, 'BulkHist Store B', 'Test St. 8']);
    await q('INSERT INTO Category (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CAT_ID, 'BulkHist Cat']);
    await q('INSERT INTO Product (id, categoryId, name) VALUES (?,?,?)', [PRODUCT_ID, CAT_ID, 'BulkHist Product']);
    for (const [sp, name] of [[SP_REAL, 'Real SP'], [SP_FALLBACK, 'Fallback SP'], [SP_EMPTY, 'Empty SP']] as const) {
        await q('INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?)', [sp, PRODUCT_ID, CHAIN_ID, name]);
    }
    const price = (sp: number, price: number, date: string, isFallback: number, promo: number | null = null, storeId = STORE_ID) =>
        q(`INSERT INTO Price (storeProductId, storeId, price, promoPrice, date, isFallback, priceVerified)
           VALUES (?,?,?,?,?,?,?)`, [sp, storeId, price, promo, date, isFallback, isFallback ? 0 : 1]);
    await price(SP_REAL, 1.49, '2026-01-10 10:00:00', 0);
    await price(SP_REAL, 1.59, '2026-02-10 10:00:00', 0, 1.29);
    await price(SP_REAL, 1.39, '2026-03-10 10:00:00', 1);            // fallback → dropped for SP_REAL
    await price(SP_REAL, 1.49, '2026-01-10 10:00:00', 0, null, STORE_B); // scrape-fanout twin → deduped to ONE point
    await price(SP_FALLBACK, 2.99, '2026-01-15 10:00:00', 1);
    await price(SP_FALLBACK, 2.79, '2026-02-15 10:00:00', 1);
});

afterAll(async () => {
    await q('DELETE FROM Price WHERE storeProductId IN (?,?,?)', [SP_REAL, SP_FALLBACK, SP_EMPTY]);
    await q('DELETE FROM StoreProduct WHERE id IN (?,?,?)', [SP_REAL, SP_FALLBACK, SP_EMPTY]);
    await q('DELETE FROM Product WHERE id = ?', [PRODUCT_ID]);
    await q('DELETE FROM Category WHERE id = ?', [CAT_ID]);
    await q('DELETE FROM Store WHERE id IN (?,?)', [STORE_ID, STORE_B]);
    await q('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
    await (pool as any).end();
});

const bulk = (spIds: string) => request(app).get(`/api/prices/store-products/history?spIds=${spIds}`);
const single = (spId: number) => request(app).get(`/api/prices/store-product/${spId}/history`);

describe('GET /prices/store-products/history (bulk)', () => {
    it('returns one key per requested id, each equal to the single endpoint', async () => {
        const r = await bulk(`${SP_REAL},${SP_FALLBACK},${SP_EMPTY}`);
        expect(r.status).toBe(200);
        expect(Object.keys(r.body.histories).sort()).toEqual(
            [SP_REAL, SP_FALLBACK, SP_EMPTY].map(String).sort());
        for (const sp of [SP_REAL, SP_FALLBACK, SP_EMPTY]) {
            const s = await single(sp);
            expect(s.status).toBe(200);
            expect(r.body.histories[String(sp)]).toEqual(s.body);
        }
    });

    it('prefers non-fallback rows PER SP (a real-price SP must not mask a fallback-only one)', async () => {
        const r = await bulk(`${SP_REAL},${SP_FALLBACK}`);
        const real = r.body.histories[String(SP_REAL)];
        const fb = r.body.histories[String(SP_FALLBACK)];
        expect(real).toHaveLength(2);                       // dupe deduped, fallback row dropped
        expect(real.every((x: any) => x.isFallback !== 1)).toBe(true);
        expect(fb).toHaveLength(2);                         // fallback-only SP keeps its rows
        expect(fb.every((x: any) => x.isFallback === 1)).toBe(true);
    });

    it('an SP with no prices comes back as an empty array, not a missing key', async () => {
        const r = await bulk(String(SP_EMPTY));
        expect(r.body.histories[String(SP_EMPTY)]).toEqual([]);
    });

    it('dedupes repeated ids in the request', async () => {
        const r = await bulk(`${SP_REAL},${SP_REAL},${SP_REAL}`);
        expect(r.status).toBe(200);
        expect(Object.keys(r.body.histories)).toEqual([String(SP_REAL)]);
    });

    it('400s on missing, empty, or non-integer spIds', async () => {
        expect((await request(app).get('/api/prices/store-products/history')).status).toBe(400);
        expect((await bulk('')).status).toBe(400);
        expect((await bulk('1,abc')).status).toBe(400);
        expect((await bulk('1,-2')).status).toBe(400);
    });

    it('400s above the 50-id cap with a clear message', async () => {
        const ids = Array.from({ length: 51 }, (_, i) => i + 1).join(',');
        const r = await bulk(ids);
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/max 50/);
    });
});
