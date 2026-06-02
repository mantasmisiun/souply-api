/**
 * Integration tests for the admin receipt-inspection endpoints.
 *
 * Covers all seven PATCH/POST mutation endpoints plus the two GET
 * read endpoints. Auth checks verify 401 (missing header) and 403
 * (not superadmin) gate both read and write paths.
 *
 * Routes under test (all require X-Admin-Id with role='superadmin'):
 *   GET    /api/admin/receipts
 *   GET    /api/admin/receipts/:id
 *   PATCH  /api/admin/receipts/:id/date
 *   PATCH  /api/admin/receipts/:id/products/:index/name
 *   POST   /api/admin/receipts/:id/products/:index/confirm-match
 *   POST   /api/admin/receipts/:id/products/:index/deny-match
 *   PATCH  /api/admin/receipts/:id/products/:index/unit
 *   PATCH  /api/admin/receipts/:id/products/:index/amount
 *   PATCH  /api/admin/receipts/:id/products/:index/quantity
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(30000);

/**
 * MariaDB's JSON_EXTRACT returns scalars as JSON text ('null', 'true',
 * '123', '"foo"') rather than native SQL values, so a cleared field reads
 * back as the string 'null'. Normalise to native JS for assertions.
 */
function jsonScalar(v: any): any {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
}

// ── Fixtures ─────────────────────────────────────────────────────────

const SUPER_ADMIN_ID   = 'rcpt-test-super-aaaa-aaaaaaaaaaaa';
const PLAIN_ADMIN_ID   = 'rcpt-test-plain-bbbb-bbbbbbbbbbbb';
const USER_ID          = 'rcpt-test-user-cccc-cccccccccccc';
const CHAIN_ID         = 97001;
const STORE_ID         = 97101;
const CATEGORY_ID      = 688; // Nepriskirta — guaranteed to exist (see globalSetup)

let receiptId: number;
let storeProductId: number;
let otherSpId: number; // a second StoreProduct for confirm-match tests

// Initial parsedData — two product lines so index-based tests cover
// both "matched" (has storeProductId) and "unmatched" states.
const makeInitialParsedData = (spId: number) => ({
    header: { chainName: 'TestChain' },
    footer: { total: 5.00, date: '2024-01-15' },
    products: [
        {
            name: 'Pienas 3.5%',
            price: 1.29,
            quantity: 1,
            unit: 'l',
            storeProductId: spId,
            matchedName: 'Pienas',
            matchConfidence: 0.9,
            matchConfirmed: true,
            pricePerUnit: 1.29,
        },
        {
            name: 'Duona',
            price: 1.99,
            quantity: 1,
            unit: 'vnt',
            storeProductId: null,
            matchedName: null,
            matchConfidence: null,
            matchConfirmed: false,
            pricePerUnit: 1.99,
        },
    ],
});

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query('SET foreign_key_checks = 0');
        await conn.query('DELETE FROM AdminAuditLog WHERE adminUserId IN (?, ?)', [SUPER_ADMIN_ID, PLAIN_ADMIN_ID]);
        await conn.query('DELETE FROM Price WHERE storeId = ?', [STORE_ID]);
        await conn.query('DELETE FROM Receipt WHERE storeId = ?', [STORE_ID]);
        await conn.query('DELETE FROM StoreProduct WHERE chainId = ?', [CHAIN_ID]);
        await conn.query('DELETE FROM Product WHERE name LIKE \'RcptTest%\'');
        await conn.query('DELETE FROM Store WHERE id = ?', [STORE_ID]);
        await conn.query('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
        await conn.query('DELETE FROM User WHERE id IN (?, ?, ?)', [SUPER_ADMIN_ID, PLAIN_ADMIN_ID, USER_ID]);
        await conn.query('SET foreign_key_checks = 1');
    } finally {
        conn.release();
    }
}

async function resetParsedData() {
    await pool.query(
        'UPDATE Receipt SET parsedData = ?, adminEditedAt = NULL WHERE id = ?',
        [JSON.stringify(makeInitialParsedData(storeProductId)), receiptId],
    );
    await pool.query(
        'UPDATE Price SET price = 1.29, date = ? WHERE receiptId = ?',
        ['2024-01-15', receiptId],
    );
    await pool.query(
        'UPDATE Receipt SET receiptDate = ? WHERE id = ?',
        ['2024-01-15', receiptId],
    );
}

beforeAll(async () => {
    await cleanup();

    await pool.query('INSERT INTO User (id, isAdmin, adminRole) VALUES (?, 1, ?)', [SUPER_ADMIN_ID, 'superadmin']);
    await pool.query('INSERT INTO User (id, isAdmin, adminRole) VALUES (?, 1, ?)', [PLAIN_ADMIN_ID, 'admin']); // not superadmin
    await pool.query('INSERT INTO User (id, isAdmin) VALUES (?, 0)', [USER_ID]);

    await pool.query('INSERT INTO StoreChain (id, name) VALUES (?, ?)', [CHAIN_ID, 'RcptTestChain']);
    await pool.query('INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, ?, ?)', [STORE_ID, CHAIN_ID, 'RcptTestStore', 'RcptTestAddr']);

    const [prodRes]: any = await pool.query(
        'INSERT INTO Product (name, categoryId) VALUES (?, ?)',
        ['RcptTestPienas', CATEGORY_ID],
    );
    const productId = Number(prodRes.insertId);

    const [spRes]: any = await pool.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName, unit, amount) VALUES (?, ?, ?, ?, ?)',
        [productId, CHAIN_ID, 'Pienas 3.5%', 'l', 1000],
    );
    storeProductId = Number(spRes.insertId);

    // Second SP for confirm-match to pick.
    const [prod2Res]: any = await pool.query(
        'INSERT INTO Product (name, categoryId) VALUES (?, ?)',
        ['RcptTestDuona', CATEGORY_ID],
    );
    const [sp2Res]: any = await pool.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName, unit, amount) VALUES (?, ?, ?, ?, ?)',
        [Number(prod2Res.insertId), CHAIN_ID, 'Duona', 'vnt', 500],
    );
    otherSpId = Number(sp2Res.insertId);

    const [recRes]: any = await pool.query(
        `INSERT INTO Receipt
             (userId, storeId, filePath, fileType, parsedData, processingStatus, receiptDate)
         VALUES (?, ?, ?, 'image/jpeg', ?, 'completed', ?)`,
        [USER_ID, STORE_ID, 'http://x/r.jpg', JSON.stringify(makeInitialParsedData(storeProductId)), '2024-01-15'],
    );
    receiptId = Number(recRes.insertId);

    await pool.query(
        'INSERT INTO Price (storeProductId, storeId, receiptId, price, isFallback, date, priceVerified) VALUES (?, ?, ?, 1.29, 0, ?, 0)',
        [storeProductId, STORE_ID, receiptId, '2024-01-15'],
    );
});

afterAll(async () => {
    await cleanup();
});

afterEach(async () => {
    await resetParsedData();
});

// ── Auth ─────────────────────────────────────────────────────────────

describe('auth guards', () => {
    it('GET /receipts → 401 without X-Admin-Id', async () => {
        const res = await request(app).get('/api/admin/receipts');
        expect(res.status).toBe(401);
    });

    it('GET /receipts → 403 for plain admin (not superadmin)', async () => {
        const res = await request(app)
            .get('/api/admin/receipts')
            .set('X-Admin-Id', PLAIN_ADMIN_ID);
        expect(res.status).toBe(403);
    });

    it('PATCH /date → 403 for plain admin', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/date`)
            .set('X-Admin-Id', PLAIN_ADMIN_ID)
            .send({ date: '2024-02-01' });
        expect(res.status).toBe(403);
    });
});

// ── GET /api/admin/receipts ──────────────────────────────────────────

describe('GET /api/admin/receipts', () => {
    it('returns list with pagination meta', async () => {
        const res = await request(app)
            .get('/api/admin/receipts?page=0&limit=10&filter=all')
            .set('X-Admin-Id', SUPER_ADMIN_ID);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.receipts)).toBe(true);
        expect(typeof res.body.total).toBe('number');
        expect(res.body.page).toBe(0);

        const seeded = res.body.receipts.find((r: any) => Number(r.id) === receiptId);
        expect(seeded).toBeDefined();
        expect(seeded.lineCount).toBe(2);
        expect(seeded.flagged).toBe(false);
    });

    it('filter=fixed only returns receipts with adminEditedAt set', async () => {
        // Nothing is admin-edited yet.
        const before = await request(app)
            .get('/api/admin/receipts?filter=fixed')
            .set('X-Admin-Id', SUPER_ADMIN_ID);
        expect(before.status).toBe(200);
        const wasFixed = before.body.receipts.some((r: any) => Number(r.id) === receiptId);
        expect(wasFixed).toBe(false);

        // Touch adminEditedAt.
        await pool.query('UPDATE Receipt SET adminEditedAt = NOW() WHERE id = ?', [receiptId]);

        const after = await request(app)
            .get('/api/admin/receipts?filter=fixed')
            .set('X-Admin-Id', SUPER_ADMIN_ID);
        const isFixed = after.body.receipts.some((r: any) => Number(r.id) === receiptId);
        expect(isFixed).toBe(true);
    });
});

// ── GET /api/admin/receipts/:id ──────────────────────────────────────

describe('GET /api/admin/receipts/:id', () => {
    it('returns full receipt detail with parsedData', async () => {
        const res = await request(app)
            .get(`/api/admin/receipts/${receiptId}`)
            .set('X-Admin-Id', SUPER_ADMIN_ID);

        expect(res.status).toBe(200);
        expect(String(res.body.id)).toBe(String(receiptId));
        expect(res.body.date).toBe('2024-01-15');
        expect(res.body.parsedData.products).toHaveLength(2);
        expect(res.body.parsedData.footer.total).toBe(5.00);
    });

    it('returns 404 for non-existent receipt', async () => {
        const res = await request(app)
            .get('/api/admin/receipts/99999999')
            .set('X-Admin-Id', SUPER_ADMIN_ID);
        expect(res.status).toBe(404);
    });
});

// ── PATCH date ───────────────────────────────────────────────────────

describe('PATCH /api/admin/receipts/:id/date', () => {
    it('updates receiptDate, parsedData footer date, and Price rows', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/date`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ date: '2024-03-10' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const [[row]]: any = await pool.query(
            'SELECT DATE_FORMAT(receiptDate, \'%Y-%m-%d\') AS d FROM Receipt WHERE id = ?',
            [receiptId],
        );
        expect(row.d).toBe('2024-03-10');

        const [[pd]]: any = await pool.query(
            'SELECT JSON_UNQUOTE(JSON_EXTRACT(parsedData, \'$.footer.date\')) AS d FROM Receipt WHERE id = ?',
            [receiptId],
        );
        expect(pd.d).toBe('2024-03-10');

        const [[price]]: any = await pool.query(
            'SELECT DATE_FORMAT(date, \'%Y-%m-%d\') AS d FROM Price WHERE receiptId = ?',
            [receiptId],
        );
        expect(price.d).toBe('2024-03-10');
    });

    it('returns 400 for invalid date format', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/date`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ date: '10/03/2024' });
        expect(res.status).toBe(400);
    });

    it('sets adminEditedAt', async () => {
        await request(app)
            .patch(`/api/admin/receipts/${receiptId}/date`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ date: '2024-04-01' });

        const [[row]]: any = await pool.query(
            'SELECT adminEditedAt FROM Receipt WHERE id = ?',
            [receiptId],
        );
        expect(row.adminEditedAt).not.toBeNull();
    });
});

// ── PATCH product name ───────────────────────────────────────────────

describe('PATCH /api/admin/receipts/:id/products/:index/name', () => {
    it('updates name and clears stale match fields', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/name`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ name: 'Pienas 2%' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const [[row]]: any = await pool.query(
            `SELECT
                JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.products[0].name'))              AS name,
                JSON_EXTRACT(parsedData, '$.products[0].storeProductId')                  AS spId,
                JSON_EXTRACT(parsedData, '$.products[0].matchedName')                     AS matchedName,
                JSON_EXTRACT(parsedData, '$.products[0].matchConfirmed')                  AS confirmed
             FROM Receipt WHERE id = ?`,
            [receiptId],
        );
        expect(row.name).toBe('Pienas 2%');
        expect(jsonScalar(row.spId)).toBeNull();
        expect(jsonScalar(row.matchedName)).toBeNull();
        // matchConfirmed should be false/NULL after clearing
        const confirmed = jsonScalar(row.confirmed);
        expect(confirmed == null || confirmed == 0 || confirmed === false).toBe(true);
    });

    it('returns candidates array (may be empty for novel names)', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/name`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ name: 'Pienas 3.5%' });

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.candidates)).toBe(true);
        // Our seeded SP has storeProductName = 'Pienas 3.5%' — exact match should surface first.
        if (res.body.candidates.length > 0) {
            expect(res.body.candidates[0].confidence).toBe(1.0);
            expect(res.body.candidates[0].storeProductId).toBe(storeProductId);
        }
    });

    it('returns 400 for empty name', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/name`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ name: '   ' });
        expect(res.status).toBe(400);
    });
});

// ── POST confirm-match ───────────────────────────────────────────────

describe('POST /api/admin/receipts/:id/products/:index/confirm-match', () => {
    it('sets storeProductId, matchedName, matchConfirmed=true', async () => {
        const res = await request(app)
            .post(`/api/admin/receipts/${receiptId}/products/1/confirm-match`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ storeProductId: otherSpId });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const [[row]]: any = await pool.query(
            `SELECT
                JSON_EXTRACT(parsedData, '$.products[1].storeProductId')             AS spId,
                JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.products[1].matchedName'))  AS matchedName,
                JSON_EXTRACT(parsedData, '$.products[1].matchConfirmed')             AS confirmed
             FROM Receipt WHERE id = ?`,
            [receiptId],
        );
        expect(Number(jsonScalar(row.spId))).toBe(otherSpId);
        expect(row.matchedName).toBeTruthy();
        const confirmed = jsonScalar(row.confirmed);
        expect(confirmed === true || confirmed == 1).toBe(true);
    });

    it('returns 404 for unknown storeProductId', async () => {
        const res = await request(app)
            .post(`/api/admin/receipts/${receiptId}/products/1/confirm-match`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ storeProductId: 99999999 });
        expect(res.status).toBe(404);
    });

    it('returns 400 when storeProductId is not an integer', async () => {
        const res = await request(app)
            .post(`/api/admin/receipts/${receiptId}/products/1/confirm-match`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ storeProductId: 'abc' });
        expect(res.status).toBe(400);
    });
});

// ── POST deny-match ──────────────────────────────────────────────────

describe('POST /api/admin/receipts/:id/products/:index/deny-match', () => {
    it('clears storeProductId, matchedName, matchConfidence, matchConfirmed', async () => {
        const res = await request(app)
            .post(`/api/admin/receipts/${receiptId}/products/0/deny-match`)
            .set('X-Admin-Id', SUPER_ADMIN_ID);

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const [[row]]: any = await pool.query(
            `SELECT
                JSON_EXTRACT(parsedData, '$.products[0].storeProductId')    AS spId,
                JSON_EXTRACT(parsedData, '$.products[0].matchedName')       AS matchedName,
                JSON_EXTRACT(parsedData, '$.products[0].matchConfidence')   AS confidence,
                JSON_EXTRACT(parsedData, '$.products[0].matchConfirmed')    AS confirmed
             FROM Receipt WHERE id = ?`,
            [receiptId],
        );
        expect(jsonScalar(row.spId)).toBeNull();
        expect(jsonScalar(row.matchedName)).toBeNull();
        expect(jsonScalar(row.confidence)).toBeNull();
        const confirmed = jsonScalar(row.confirmed);
        expect(confirmed == null || confirmed == 0 || confirmed === false).toBe(true);
    });

    it('sets adminEditedAt', async () => {
        await request(app)
            .post(`/api/admin/receipts/${receiptId}/products/0/deny-match`)
            .set('X-Admin-Id', SUPER_ADMIN_ID);

        const [[row]]: any = await pool.query('SELECT adminEditedAt FROM Receipt WHERE id = ?', [receiptId]);
        expect(row.adminEditedAt).not.toBeNull();
    });
});

// ── PATCH unit ───────────────────────────────────────────────────────

describe('PATCH /api/admin/receipts/:id/products/:index/unit', () => {
    it('updates parsedData unit and StoreProduct.unit when matched', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/unit`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ unit: 'ml' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const [[pdRow]]: any = await pool.query(
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.products[0].unit')) AS u FROM Receipt WHERE id = ?`,
            [receiptId],
        );
        expect(pdRow.u).toBe('ml');

        const [[spRow]]: any = await pool.query('SELECT unit FROM StoreProduct WHERE id = ?', [storeProductId]);
        expect(spRow.unit).toBe('ml');
    });

    it('returns 400 for invalid unit', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/unit`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ unit: 'oz' });
        expect(res.status).toBe(400);
    });
});

// ── PATCH amount ─────────────────────────────────────────────────────

describe('PATCH /api/admin/receipts/:id/products/:index/amount', () => {
    it('updates StoreProduct.amount when line has a matched SP', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/amount`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ amount: 750 });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const [[spRow]]: any = await pool.query('SELECT amount FROM StoreProduct WHERE id = ?', [storeProductId]);
        expect(Number(spRow.amount)).toBe(750);
    });

    it('returns 400 when line has no matched SP', async () => {
        // Product at index 1 has no storeProductId.
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/1/amount`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ amount: 500 });
        expect(res.status).toBe(400);
    });

    it('returns 400 for non-positive amount', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/amount`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ amount: -5 });
        expect(res.status).toBe(400);
    });
});

// ── PATCH quantity ───────────────────────────────────────────────────

describe('PATCH /api/admin/receipts/:id/products/:index/quantity', () => {
    it('updates quantity, recomputes pricePerUnit, cascades to Price row', async () => {
        // Product at index 0: price=1.29, quantity=1 → set quantity=2 → pricePerUnit=0.645
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/quantity`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ quantity: 2 });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.newPricePerUnit).toBeCloseTo(0.645, 3);

        const [[pdRow]]: any = await pool.query(
            `SELECT
                JSON_EXTRACT(parsedData, '$.products[0].quantity')      AS qty,
                JSON_EXTRACT(parsedData, '$.products[0].pricePerUnit')  AS ppu
             FROM Receipt WHERE id = ?`,
            [receiptId],
        );
        expect(Number(pdRow.qty)).toBe(2);
        expect(Number(pdRow.ppu)).toBeCloseTo(0.645, 3);

        // Price row for the matched SP should also be updated.
        // Price is DECIMAL(10,2) so 0.645 is stored as 0.65.
        const [[priceRow]]: any = await pool.query(
            'SELECT price FROM Price WHERE receiptId = ? AND storeProductId = ?',
            [receiptId, storeProductId],
        );
        expect(Number(priceRow.price)).toBeCloseTo(0.65, 1);
    });

    it('returns 400 for quantity < 1', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/quantity`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ quantity: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 for non-integer quantity', async () => {
        const res = await request(app)
            .patch(`/api/admin/receipts/${receiptId}/products/0/quantity`)
            .set('X-Admin-Id', SUPER_ADMIN_ID)
            .send({ quantity: 1.5 });
        expect(res.status).toBe(400);
    });
});
