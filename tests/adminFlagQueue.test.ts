/**
 * Integration tests for the admin Flags tab.
 *
 * The Flags tab is the unified inbox for ReceiptLineIssue rows. One
 * card per `(receiptId, receiptLineIdx)` even when multiple users
 * flagged the same line — the OR-merge of their flag fields is the
 * card payload.
 *
 * Seed shape:
 *   Receipt R1 with parsedData.products[0] → spOne, products[1] → spTwo.
 *   Two users flag (R1, 0) with overlapping but not identical flag sets.
 *   One user flags (R1, 1).
 *
 * Verifies: multi-user dedup, OR-merge of flagged fields, confirm
 * applies SP edits + resolves matching issue rows, dismiss marks
 * dismissed, skip excludes via 90-day recently-resolved filter.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(20000);

const ADMIN_ID  = 'flg-aaaa-aaaa-aaaa-aaaaaaaaaaaaaaaa';
const USER_A    = 'flg-uaaa-aaaa-aaaa-aaaaaaaaaaaaaaaa';
const USER_B    = 'flg-ubbb-bbbb-bbbb-bbbbbbbbbbbbbbbb';
const CHAIN_ID  = 9601;
const STORE_ID  = 96001;
const CAT_ID    = 9601;

let spOne: number;
let spTwo: number;
let receiptId: number;

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE userId IN (?, ?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Price WHERE storeId = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM Receipt WHERE storeId = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreProduct WHERE chainId = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Product WHERE categoryId = ?`, [CAT_ID]);
        await conn.query(`DELETE FROM Store WHERE id = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Category WHERE id = ?`, [CAT_ID]);
        await conn.query(`DELETE FROM User WHERE id IN (?, ?, ?)`, [ADMIN_ID, USER_A, USER_B]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
}

async function seed() {
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 1)`, [ADMIN_ID]);
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 0)`, [USER_A]);
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 0)`, [USER_B]);
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'FlgTestChain')`, [CHAIN_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'FlgStore', 'FlgAddr')`, [STORE_ID, CHAIN_ID]);
    await pool.query(`INSERT INTO Category (id, name) VALUES (?, 'FlgCat')`, [CAT_ID]);

    const [pA]: any = await pool.query(
        `INSERT INTO Product (categoryId, name) VALUES (?, 'FlgProductA')`, [CAT_ID],
    );
    const [pB]: any = await pool.query(
        `INSERT INTO Product (categoryId, name) VALUES (?, 'FlgProductB')`, [CAT_ID],
    );

    const [r1]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, amount, unit, isWeighable)
         VALUES (?, ?, 'Sūris Flag 200g', 200, 'g', 0)`,
        [Number(pA.insertId), CHAIN_ID],
    );
    spOne = Number(r1.insertId);

    const [r2]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, amount, unit, isWeighable)
         VALUES (?, ?, 'Pienas Flag 1L', 1, 'l', 0)`,
        [Number(pB.insertId), CHAIN_ID],
    );
    spTwo = Number(r2.insertId);

    // Receipt with parsedData pointing line 0 → spOne, line 1 → spTwo.
    const parsedData = {
        products: [
            { storeProductId: spOne, name: 'Sūris', price: 2.5,
              region: { yTop: 100, yBottom: 130, xLeft: 0, xRight: 400 } },
            { storeProductId: spTwo, name: 'Pienas', price: 1.2,
              region: { yTop: 200, yBottom: 230, xLeft: 0, xRight: 400 } },
        ],
    };
    const [rec]: any = await pool.query(
        `INSERT INTO Receipt
            (userId, storeId, filePath, fileType, parsedData, processingStatus)
         VALUES (?, ?, 'http://example.local/none.jpg', 'image/jpeg', CAST(? AS JSON), 'completed')`,
        [USER_A, STORE_ID, JSON.stringify(parsedData)],
    );
    receiptId = Number(rec.insertId);

    // Real (non-fallback) Price rows for both SPs, attached to the
    // receipt so the controller can find them and the priceSuspect
    // path has something to flip.
    await pool.query(
        `INSERT INTO Price
           (storeProductId, storeId, receiptId, price, isFallback, date, priceVerified)
         VALUES (?, ?, ?, 2.50, 0, NOW(), 1)`,
        [spOne, STORE_ID, receiptId],
    );
    await pool.query(
        `INSERT INTO Price
           (storeProductId, storeId, receiptId, price, isFallback, date, priceVerified)
         VALUES (?, ?, ?, 1.20, 0, NOW(), 1)`,
        [spTwo, STORE_ID, receiptId],
    );
}

async function plantIssue(lineIdx: number, userId: string, flags: object) {
    await pool.query(
        `INSERT INTO ReceiptLineIssue (receiptId, receiptLineIdx, userId, flags, status)
         VALUES (?, ?, ?, CAST(? AS JSON), 'pending')`,
        [receiptId, lineIdx, userId, JSON.stringify(flags)],
    );
}

beforeAll(async () => {
    await cleanup();
    await seed();
});

afterAll(async () => {
    await cleanup();
});

describe('admin flag queue', () => {
    beforeEach(async () => {
        // Clear leases + flag rows + audit between cases so each test
        // gets a clean inbox. SPs / receipt stay so the parsedData
        // mapping survives.
        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        await pool.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ?`, [ADMIN_ID]);
        await pool.query(`DELETE FROM ReceiptLineIssue WHERE userId IN (?, ?)`, [USER_A, USER_B]);
        // Reset SP values + price verified so confirm tests start fresh.
        await pool.query(
            `UPDATE StoreProduct SET storeProductName = 'Sūris Flag 200g', amount = 200, unit = 'g' WHERE id = ?`,
            [spOne],
        );
        await pool.query(`UPDATE Price SET priceVerified = 1 WHERE receiptId = ?`, [receiptId]);
    });

    it('multi-user flags on one line surface as a single card with userCount=2', async () => {
        await plantIssue(0, USER_A, { name: true,  price: false, amount: false, discount: false, image: false });
        await plantIssue(0, USER_B, { name: false, price: false, amount: true,  discount: false, image: false });

        const res = await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        expect(res.status).toBe(200);

        // The card for (receiptId, 0) should be there exactly once
        // with both flagged fields OR-merged.
        const cards = res.body.rows.filter((r: any) =>
            r.receiptId === receiptId && r.lineIdx === 0
        );
        expect(cards).toHaveLength(1);
        expect(cards[0].userCount).toBe(2);
        expect(cards[0].flagged.name).toBe(true);
        expect(cards[0].flagged.amount).toBe(true);
        expect(cards[0].flagged.price).toBe(false);
        expect(cards[0].spId).toBe(spOne);
    });

    it('resolved or dismissed rows do not surface', async () => {
        // line 0: a resolved row. line 1: a still-pending row.
        await pool.query(
            `INSERT INTO ReceiptLineIssue
                (receiptId, receiptLineIdx, userId, flags, status, resolvedBy, resolvedAt)
             VALUES (?, 0, ?, CAST(? AS JSON), 'resolved', ?, NOW())`,
            [receiptId, USER_A, JSON.stringify({ name: true, price: false, amount: false, discount: false, image: false }), ADMIN_ID],
        );
        await plantIssue(1, USER_B, { name: false, price: true, amount: false, discount: false, image: false });

        const res = await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        const keys = res.body.rows.map((r: any) => r.flagKey);
        expect(keys).not.toContain(`${receiptId}-0`);
        expect(keys).toContain(`${receiptId}-1`);
    });

    it('confirm with SP edits applies them and resolves all matching issue rows', async () => {
        await plantIssue(0, USER_A, { name: true, price: false, amount: false, discount: false, image: false });
        await plantIssue(0, USER_B, { name: true, price: false, amount: false, discount: false, image: false });

        // Claim so we have a lease — confirm verifies via completeLease.
        await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/flags/${receiptId}-0/confirm`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({ sp: { storeProductName: 'Sūris RIMI Premium 200g' } });
        expect(res.status).toBe(200);
        expect(res.body.applied.storeProductName).toBe('Sūris RIMI Premium 200g');

        const [spRows]: any = await pool.query(
            `SELECT storeProductName FROM StoreProduct WHERE id = ?`, [spOne],
        );
        expect(spRows[0].storeProductName).toBe('Sūris RIMI Premium 200g');

        // Both users' rows should be marked resolved in the same call.
        const [issues]: any = await pool.query(
            `SELECT userId, status FROM ReceiptLineIssue
              WHERE receiptId = ? AND receiptLineIdx = 0`,
            [receiptId],
        );
        expect(issues).toHaveLength(2);
        for (const i of issues) {
            expect(i.status).toBe('resolved');
        }

        // Audit row with flag_resolve action against the encoded key.
        const [audit]: any = await pool.query(
            `SELECT action, targetId FROM AdminAuditLog
              WHERE adminUserId = ? AND action = 'flag_resolve'
              ORDER BY id DESC LIMIT 1`,
            [ADMIN_ID],
        );
        expect(audit[0]).toBeDefined();
        expect(Number(audit[0].targetId)).toBe(receiptId * 1000 + 0);
    });

    it('receiptPrice edits update Price.price and verify the row', async () => {
        // Seed the receipt's price row as unverified so we can confirm
        // Patvirtinti flips it. Pre-edit price is 2.50 (from setup).
        await pool.query(
            `UPDATE Price SET priceVerified = 0 WHERE receiptId = ? AND storeProductId = ?`,
            [receiptId, spOne],
        );
        await plantIssue(0, USER_A, { name: false, price: true, amount: false, discount: false, image: false });
        await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/flags/${receiptId}-0/confirm`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({ receiptPrice: { price: 2.99 } });
        expect(res.status).toBe(200);

        const [pr]: any = await pool.query(
            `SELECT price, priceVerified FROM Price WHERE receiptId = ? AND storeProductId = ?`,
            [receiptId, spOne],
        );
        expect(parseFloat(String(pr[0].price))).toBeCloseTo(2.99, 4);
        // Confirm always stamps the row as verified — admin reviewed it.
        expect(Number(pr[0].priceVerified)).toBe(1);
    });

    it('receiptPrice.promoPrice=null removes a phantom discount', async () => {
        // Seed a promo on the receipt's price row so we have something
        // to remove.
        await pool.query(
            `UPDATE Price SET promoPrice = 1.99 WHERE receiptId = ? AND storeProductId = ?`,
            [receiptId, spOne],
        );
        await plantIssue(0, USER_A, { name: false, price: false, amount: false, discount: true, image: false });
        await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/flags/${receiptId}-0/confirm`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({ receiptPrice: { promoPrice: null } });
        expect(res.status).toBe(200);

        const [pr]: any = await pool.query(
            `SELECT promoPrice FROM Price WHERE receiptId = ? AND storeProductId = ?`,
            [receiptId, spOne],
        );
        expect(pr[0].promoPrice).toBeNull();
    });

    it('dismiss marks all matching issue rows as dismissed', async () => {
        await plantIssue(0, USER_A, { name: true, price: false, amount: false, discount: false, image: false });
        await plantIssue(0, USER_B, { name: true, price: false, amount: false, discount: false, image: false });
        await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/flags/${receiptId}-0/dismiss`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({});
        expect(res.status).toBe(200);

        const [issues]: any = await pool.query(
            `SELECT status FROM ReceiptLineIssue
              WHERE receiptId = ? AND receiptLineIdx = 0`,
            [receiptId],
        );
        for (const i of issues) {
            expect(i.status).toBe('dismissed');
        }
    });

    it('skip leaves issues pending but the 90-day filter hides the card', async () => {
        await plantIssue(0, USER_A, { name: true, price: false, amount: false, discount: false, image: false });
        await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        await request(app)
            .post(`/api/admin/flags/${receiptId}-0/skip`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({});

        // Issue still pending …
        const [issues]: any = await pool.query(
            `SELECT status FROM ReceiptLineIssue
              WHERE receiptId = ? AND receiptLineIdx = 0`,
            [receiptId],
        );
        expect(issues[0].status).toBe('pending');

        // … but the card is now filtered out by the recently-resolved
        // window. Need a fresh claim — clear stale leases first.
        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        const next = await request(app)
            .post('/api/admin/flags/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        const keys = next.body.rows.map((r: any) => r.flagKey);
        expect(keys).not.toContain(`${receiptId}-0`);
    });
});
