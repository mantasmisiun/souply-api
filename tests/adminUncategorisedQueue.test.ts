/**
 * Integration tests for the admin Uncategorised (Nepriskirti) tab.
 *
 * Seeds a small catalog with mixed category states:
 *   pA — categoryId = NULL                → qualifies for queue
 *   pB — categoryId = <test category>     → does NOT qualify
 *   pC — categoryId = NULL, with Price refs → can't be deleted
 *
 * Verifies: picker surfaces only pA + pC, confirm assigns category,
 * delete on clean Product succeeds, delete on Product with Price refs
 * returns 409 with blocker counts, skip excludes via 90-day filter.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(20000);

const ADMIN_ID = 'unc-aaaa-aaaa-aaaa-aaaaaaaaaaaaaaaa';
const CHAIN_ID = 9701;
const STORE_ID = 97001;
const CAT_ID = 9701;       // "real" L3 category — pB sits here, doesn't qualify
const CAT_TARGET_ID = 9702; // category the admin will assign in confirm test
// The Nepriskirta fallback id from production config. Must seed this
// Category row before inserting Products into it; the picker filters
// solely on this id (Product.categoryId is NOT NULL in the schema).
const NEPRISKIRTA_CATEGORY_ID = 688;

let pA: number;  // uncategorised, no refs
let pB: number;  // already categorised — should NOT appear
let pC: number;  // uncategorised, has Price refs — delete-blocked
let spC: number;

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM Price WHERE storeId = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreProduct WHERE chainId = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Product WHERE name LIKE 'UncTest%'`);
        await conn.query(`DELETE FROM Store WHERE id = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Category WHERE id IN (?, ?)`, [CAT_ID, CAT_TARGET_ID]);
        await conn.query(`DELETE FROM User WHERE id = ?`, [ADMIN_ID]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
}

beforeAll(async () => {
    await cleanup();
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 1)`, [ADMIN_ID]);
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'UncTestChain')`, [CHAIN_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'UncStore', 'UncAddr')`, [STORE_ID, CHAIN_ID]);
    await pool.query(`INSERT INTO Category (id, name) VALUES (?, 'UncTestCategory')`, [CAT_ID]);
    await pool.query(`INSERT INTO Category (id, name) VALUES (?, 'UncTargetCategory')`, [CAT_TARGET_ID]);
    // Seed the Nepriskirta bucket if it doesn't already exist in the
    // test DB. INSERT IGNORE is fine because the migration may have
    // already populated id=688.
    await pool.query(`INSERT IGNORE INTO Category (id, name) VALUES (?, 'Nepriskirta')`, [NEPRISKIRTA_CATEGORY_ID]);

    const [a]: any = await pool.query(
        `INSERT INTO Product (name, categoryId) VALUES ('UncTestA', ?)`, [NEPRISKIRTA_CATEGORY_ID],
    );
    pA = Number(a.insertId);
    const [b]: any = await pool.query(
        `INSERT INTO Product (name, categoryId) VALUES ('UncTestB', ?)`, [CAT_ID],
    );
    pB = Number(b.insertId);
    const [c]: any = await pool.query(
        `INSERT INTO Product (name, categoryId) VALUES ('UncTestC', ?)`, [NEPRISKIRTA_CATEGORY_ID],
    );
    pC = Number(c.insertId);

    const [spcRes]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName)
         VALUES (?, ?, 'UncTestC SP')`,
        [pC, CHAIN_ID],
    );
    spC = Number(spcRes.insertId);
    // Insert a Price row so `checkProductDeleteBlockers` blocks the
    // delete attempt on pC. The blocker counts ALL Prices regardless
    // of receiptId, so a NULL-receiptId (scrape-style) row is enough.
    await pool.query(
        `INSERT INTO Price
            (storeProductId, storeId, receiptId, price, isFallback, date, priceVerified)
         VALUES (?, ?, NULL, 1.99, 0, NOW(), 1)`,
        [spC, STORE_ID],
    );
});

afterAll(async () => {
    await cleanup();
});

describe('admin uncategorised queue', () => {
    beforeEach(async () => {
        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        await pool.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ?`, [ADMIN_ID]);
    });

    it('claim-batch surfaces only Products in the Nepriskirta bucket', async () => {
        const res = await request(app)
            .post('/api/admin/uncategorised/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        expect(res.status).toBe(200);
        const ids = res.body.rows.map((r: any) => r.productId);
        expect(ids).toContain(pA);
        expect(ids).toContain(pC);
        expect(ids).not.toContain(pB);
    });

    it('confirm assigns category + logs uncategorised_set audit', async () => {
        await request(app)
            .post('/api/admin/uncategorised/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/uncategorised/${pA}/confirm`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({ categoryId: CAT_TARGET_ID });
        expect(res.status).toBe(200);

        const [[row]]: any = await pool.query(
            `SELECT categoryId FROM Product WHERE id = ?`, [pA],
        );
        expect(Number(row.categoryId)).toBe(CAT_TARGET_ID);

        const [[audit]]: any = await pool.query(
            `SELECT action FROM AdminAuditLog
              WHERE adminUserId = ? AND action = 'uncategorised_set' AND targetId = ?
              ORDER BY id DESC LIMIT 1`,
            [ADMIN_ID, pA],
        );
        expect(audit).toBeDefined();

        // Reset for subsequent test runs.
        await pool.query(`UPDATE Product SET categoryId = ? WHERE id = ?`, [NEPRISKIRTA_CATEGORY_ID, pA]);
    });

    it('delete on Product with Price refs is blocked with 409 + blocker counts', async () => {
        await request(app)
            .post('/api/admin/uncategorised/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/uncategorised/${pC}/delete`)
            .set('X-Admin-Id', ADMIN_ID);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('blocked');
        expect(res.body.blockers.prices).toBeGreaterThan(0);

        // Product must still exist after the blocked attempt.
        const [[row]]: any = await pool.query(
            `SELECT id FROM Product WHERE id = ?`, [pC],
        );
        expect(row).toBeDefined();
    });

    it('delete on clean Product succeeds + cascades to SPs', async () => {
        // Seed a fresh product with no refs.
        const [tmpRes]: any = await pool.query(
            `INSERT INTO Product (name, categoryId) VALUES ('UncTestDeletable', ?)`, [NEPRISKIRTA_CATEGORY_ID],
        );
        const tmpProductId = Number(tmpRes.insertId);
        const [tmpSpRes]: any = await pool.query(
            `INSERT INTO StoreProduct (productId, chainId, storeProductName)
             VALUES (?, ?, 'TmpDeletable SP')`,
            [tmpProductId, CHAIN_ID],
        );
        const tmpSpId = Number(tmpSpRes.insertId);

        await request(app)
            .post('/api/admin/uncategorised/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/uncategorised/${tmpProductId}/delete`)
            .set('X-Admin-Id', ADMIN_ID);
        expect(res.status).toBe(200);
        expect(res.body.deleted).toBe(true);

        const [productRows]: any = await pool.query(
            `SELECT id FROM Product WHERE id = ?`, [tmpProductId],
        );
        expect(productRows.length).toBe(0);
        const [spRows]: any = await pool.query(
            `SELECT id FROM StoreProduct WHERE id = ?`, [tmpSpId],
        );
        expect(spRows.length).toBe(0);
    });

    it('skip excludes the Product from re-claim via 90-day filter', async () => {
        await request(app)
            .post('/api/admin/uncategorised/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        await request(app)
            .post(`/api/admin/uncategorised/${pA}/skip`)
            .set('X-Admin-Id', ADMIN_ID);

        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        const next = await request(app)
            .post('/api/admin/uncategorised/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        const ids = next.body.rows.map((r: any) => r.productId);
        expect(ids).not.toContain(pA);
    });
});
