/**
 * Integration tests for the admin receipt-split endpoints.
 *
 * Tests cover:
 *   GET  /api/admin/uncategorised/:productId/source-receipt
 *     — 404 when no receipt-sourced Price for the product
 *     — 200 with correct receipt info + lineIdx when source exists
 *
 *   POST /api/admin/uncategorised/:productId/split
 *     — 400 for invalid body (missing required fields)
 *     — 200 happy path:
 *         · bottom Product / SP / Price updated to supplied values
 *         · new (top) Product created via resolver
 *         · Receipt parsedData replaced from 1 line to 2 lines
 *         · AdminAuditLog has an uncategorised_split entry
 *         · AdminCardLease for the product is released
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(30000);

const ADMIN_ID = 'split-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAIN_ID = 9801;
const STORE_ID = 98001;
const USER_ID = 'split-user-bbbb-bbbb-bbbb-bbbb';
const NEPRISKIRTA_CATEGORY_ID = 688;

let productId: number;
let storeProductId: number;
let receiptId: number;
let priceId: number;

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM Price WHERE storeId = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM Receipt WHERE storeId = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreProduct WHERE chainId = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Product WHERE name LIKE 'SplitTest%'`);
        await conn.query(`DELETE FROM Store WHERE id = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM User WHERE id IN (?, ?)`, [ADMIN_ID, USER_ID]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
}

beforeAll(async () => {
    await cleanup();

    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 1)`, [ADMIN_ID]);
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 0)`, [USER_ID]);
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'SplitTestChain')`, [CHAIN_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'SplitStore', 'SplitAddr')`, [STORE_ID, CHAIN_ID]);

    // Ensure the Nepriskirta bucket exists. The resolver requires isHidden=1.
    await pool.query(
        `INSERT IGNORE INTO Category (id, name, isHidden) VALUES (?, 'Nepriskirta', 1)`,
        [NEPRISKIRTA_CATEGORY_ID],
    );

    // Seed: Product + SP in the Nepriskirta bucket (i.e. uncategorised).
    const [prodRes]: any = await pool.query(
        `INSERT INTO Product (name, categoryId) VALUES ('SplitTestMerged', ?)`,
        [NEPRISKIRTA_CATEGORY_ID],
    );
    productId = Number(prodRes.insertId);

    const [spRes]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName) VALUES (?, ?, 'SplitTestMerged SP')`,
        [productId, CHAIN_ID],
    );
    storeProductId = Number(spRes.insertId);

    // Receipt with parsedData containing our product's storeProductId.
    const parsedData = {
        products: [
            {
                storeProductId,
                name: 'SplitTestMerged',
                price: 3.00,
                promoPrice: null,
                amount: 500,
                unit: 'g',
                region: { yTop: 100, yBottom: 130, xLeft: 0, xRight: 400 },
            },
        ],
    };
    const [recRes]: any = await pool.query(
        `INSERT INTO Receipt
            (userId, storeId, filePath, fileType, parsedData, processingStatus)
         VALUES (?, ?, 'http://example.local/split.jpg', 'image/jpeg', ?, 'completed')`,
        [USER_ID, STORE_ID, JSON.stringify(parsedData)],
    );
    receiptId = Number(recRes.insertId);

    // Receipt-sourced Price row (receiptId IS NOT NULL is the key predicate).
    const [priceRes]: any = await pool.query(
        `INSERT INTO Price
            (storeProductId, storeId, receiptId, price, isFallback, date, priceVerified)
         VALUES (?, ?, ?, 3.00, 0, NOW(), 0)`,
        [storeProductId, STORE_ID, receiptId],
    );
    priceId = Number(priceRes.insertId);
});

afterAll(async () => {
    await cleanup();
});

describe('GET /api/admin/uncategorised/:productId/source-receipt', () => {
    it('returns 404 for a product with no receipt-sourced Price', async () => {
        // Seed a product with only a scraper-style (receiptId=NULL) Price.
        const [p]: any = await pool.query(
            `INSERT INTO Product (name, categoryId) VALUES ('SplitTestNoReceipt', ?)`,
            [NEPRISKIRTA_CATEGORY_ID],
        );
        const noReceiptProductId = Number(p.insertId);
        const [sp]: any = await pool.query(
            `INSERT INTO StoreProduct (productId, chainId, storeProductName) VALUES (?, ?, 'NoReceiptSP')`,
            [noReceiptProductId, CHAIN_ID],
        );
        await pool.query(
            `INSERT INTO Price (storeProductId, storeId, receiptId, price, isFallback, date, priceVerified)
             VALUES (?, ?, NULL, 1.00, 1, NOW(), 0)`,
            [Number(sp.insertId), STORE_ID],
        );

        const res = await request(app)
            .get(`/api/admin/uncategorised/${noReceiptProductId}/source-receipt`)
            .set('X-Admin-Id', ADMIN_ID);
        expect(res.status).toBe(404);

        // Clean up the extra rows.
        await pool.query(`DELETE FROM Price WHERE storeProductId = ?`, [Number(sp.insertId)]);
        await pool.query(`DELETE FROM StoreProduct WHERE id = ?`, [Number(sp.insertId)]);
        await pool.query(`DELETE FROM Product WHERE id = ?`, [noReceiptProductId]);
    });

    it('returns source receipt info with correct lineIdx', async () => {
        const res = await request(app)
            .get(`/api/admin/uncategorised/${productId}/source-receipt`)
            .set('X-Admin-Id', ADMIN_ID);

        expect(res.status).toBe(200);
        expect(Number(res.body.priceId)).toBe(priceId);
        expect(Number(res.body.receiptId)).toBe(receiptId);
        expect(Number(res.body.lineIdx)).toBe(0); // first and only product in parsedData
        expect(Number(res.body.storeProductId)).toBe(storeProductId);
        expect(Number(res.body.price)).toBeCloseTo(3.00);
    });
});

describe('POST /api/admin/uncategorised/:productId/split', () => {
    beforeEach(async () => {
        // Fresh lease for only the specific test product. Direct insert
        // avoids claim-batch picking up other Nepriskirta products (e.g.
        // seeds from sibling test files) and leasing them, which would
        // cause cross-test interference when suites run in parallel.
        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        await pool.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ?`, [ADMIN_ID]);
        await pool.query(
            `INSERT INTO AdminCardLease (spId, leasedTo, queueKind, leasedAt, expiresAt)
             VALUES (?, ?, 'uncategorised', NOW(), DATE_ADD(NOW(), INTERVAL 2 HOUR))`,
            [productId, ADMIN_ID],
        );
    });

    afterEach(async () => {
        // Restore the bottom product to its original state so subsequent
        // tests start clean.
        await pool.query(
            `UPDATE Product SET name = 'SplitTestMerged' WHERE id = ?`,
            [productId],
        );
        await pool.query(
            `UPDATE StoreProduct SET storeProductName = 'SplitTestMerged SP' WHERE id = ?`,
            [storeProductId],
        );
        await pool.query(
            `UPDATE Price SET price = 3.00, promoPrice = NULL WHERE id = ?`,
            [priceId],
        );
        // Restore parsedData to single-item state.
        const parsedData = {
            products: [
                {
                    storeProductId,
                    name: 'SplitTestMerged',
                    price: 3.00,
                    promoPrice: null,
                    amount: 500,
                    unit: 'g',
                    region: { yTop: 100, yBottom: 130, xLeft: 0, xRight: 400 },
                },
            ],
        };
        await pool.query(
            `UPDATE Receipt SET parsedData = ? WHERE id = ?`,
            [JSON.stringify(parsedData), receiptId],
        );
        // Remove any extra Products/SPs created by the resolver (top item).
        await pool.query(`DELETE FROM Price WHERE storeId = ? AND id != ?`, [STORE_ID, priceId]);
        await pool.query(
            `DELETE FROM StoreProduct WHERE chainId = ? AND id != ?`,
            [CHAIN_ID, storeProductId],
        );
        await pool.query(`DELETE FROM Product WHERE name LIKE 'SplitTestTop%'`);
    });

    it('returns 400 when top.name is missing', async () => {
        const res = await request(app)
            .post(`/api/admin/uncategorised/${productId}/split`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({
                priceId,
                top: { name: '', price: 1.50, promoPrice: null, amount: null, unit: null },
                bottom: { name: 'SplitTestBottom', price: 1.50, promoPrice: null, amount: null, unit: null },
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/top item/i);
    });

    it('returns 400 when priceId is missing', async () => {
        const res = await request(app)
            .post(`/api/admin/uncategorised/${productId}/split`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({
                top: { name: 'SplitTestTop', price: 1.50, promoPrice: null, amount: null, unit: null },
                bottom: { name: 'SplitTestBottom', price: 1.50, promoPrice: null, amount: null, unit: null },
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/priceId/i);
    });

    it('updates existing product/SP/Price and creates new product, patches parsedData', async () => {
        const res = await request(app)
            .post(`/api/admin/uncategorised/${productId}/split`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({
                priceId,
                top: {
                    name: 'SplitTestTop Obuoliai',
                    price: 1.20,
                    promoPrice: 0.99,
                    amount: 1000,
                    unit: 'g',
                },
                bottom: {
                    name: 'SplitTestBottom Bananai',
                    price: 1.80,
                    promoPrice: null,
                    amount: 500,
                    unit: 'g',
                },
            });

        expect(res.status).toBe(200);
        expect(res.body.newProductId).toBeDefined();
        const newProductId = Number(res.body.newProductId);

        // Bottom (existing) product should be updated.
        const [[updatedProduct]]: any = await pool.query(
            `SELECT name FROM Product WHERE id = ?`, [productId],
        );
        expect(updatedProduct.name).toBe('SplitTestBottom Bananai');

        const [[updatedSP]]: any = await pool.query(
            `SELECT storeProductName, amount, unit FROM StoreProduct WHERE id = ?`,
            [storeProductId],
        );
        expect(updatedSP.storeProductName).toBe('SplitTestBottom Bananai');
        expect(Number(updatedSP.amount)).toBe(500);
        expect(updatedSP.unit).toBe('g');

        const [[updatedPrice]]: any = await pool.query(
            `SELECT price, promoPrice FROM Price WHERE id = ?`, [priceId],
        );
        expect(Number(updatedPrice.price)).toBeCloseTo(1.80);
        expect(updatedPrice.promoPrice).toBeNull();

        // Top (new) product should exist.
        const [[newProduct]]: any = await pool.query(
            `SELECT name FROM Product WHERE id = ?`, [newProductId],
        );
        expect(newProduct).toBeDefined();

        // New Price row should exist for the top product referencing the same receipt.
        const [newPrices]: any = await pool.query(
            `SELECT p.price, p.promoPrice, p.receiptId
             FROM Price p
             JOIN StoreProduct sp ON sp.id = p.storeProductId
             WHERE sp.productId = ? AND p.receiptId = ?`,
            [newProductId, receiptId],
        );
        expect(newPrices.length).toBe(1);
        expect(Number(newPrices[0].price)).toBeCloseTo(1.20);
        expect(Number(newPrices[0].promoPrice)).toBeCloseTo(0.99);

        // parsedData should now contain two product entries.
        const [[receipt]]: any = await pool.query(
            `SELECT parsedData FROM Receipt WHERE id = ?`, [receiptId],
        );
        const pd = typeof receipt.parsedData === 'string'
            ? JSON.parse(receipt.parsedData)
            : receipt.parsedData;
        expect(pd.products.length).toBe(2);
        expect(pd.products[0].name).toBe('SplitTestTop Obuoliai');
        expect(pd.products[1].name).toBe('SplitTestBottom Bananai');
    });

    it('completes the lease for the product after a successful split', async () => {
        await request(app)
            .post(`/api/admin/uncategorised/${productId}/split`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({
                priceId,
                top: { name: 'SplitTestTop A', price: 1.00, promoPrice: null, amount: null, unit: null },
                bottom: { name: 'SplitTestBottom A', price: 2.00, promoPrice: null, amount: null, unit: null },
            });

        const [leases]: any = await pool.query(
            `SELECT id FROM AdminCardLease
             WHERE leasedTo = ? AND queueKind = 'uncategorised' AND spId = ?
               AND completedAt IS NULL AND abandonedAt IS NULL AND expiresAt > NOW()`,
            [ADMIN_ID, productId],
        );
        expect(leases.length).toBe(0);
    });

    it('writes an uncategorised_split audit log entry', async () => {
        await request(app)
            .post(`/api/admin/uncategorised/${productId}/split`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({
                priceId,
                top: { name: 'SplitTestTop B', price: 1.00, promoPrice: null, amount: null, unit: null },
                bottom: { name: 'SplitTestBottom B', price: 2.00, promoPrice: null, amount: null, unit: null },
            });

        const [[audit]]: any = await pool.query(
            `SELECT action, targetId FROM AdminAuditLog
             WHERE adminUserId = ? AND action = 'uncategorised_split'
             ORDER BY id DESC LIMIT 1`,
            [ADMIN_ID],
        );
        expect(audit).toBeDefined();
        expect(Number(audit.targetId)).toBe(productId);
    });
});
