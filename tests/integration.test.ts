/**
 * Integration tests — require a live test DB (Basket-DB-Test).
 * Run the GRANT first if tests fail with "Access denied":
 *   CREATE USER IF NOT EXISTS 'dbuser_test'@'<this-machine-ip>' IDENTIFIED BY '<password>';
 *   GRANT ALL PRIVILEGES ON `Basket-DB-Test`.* TO 'dbuser_test'@'<this-machine-ip>';
 *   FLUSH PRIVILEGES;
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(20000);

const USER_A = 'inttest-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'inttest-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeAll(async () => {
    // Pre-cleanup: remove any leftovers from previous crashed/failed runs.
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Basket WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Receipt WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM User WHERE id IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }

    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (1,'Test Chain') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Store (id, chainId, name) VALUES (1,1,'Test Store') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Category (id, name) VALUES (1,'Test Cat') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Product (id, categoryId, name) VALUES (1,1,'Test Product') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Product (id, categoryId, name) VALUES (2,1,'Test Product 2') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (10,1,1,'Test SP') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (11,2,1,'Test SP 2') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0`, [USER_A]);
    await pool.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0`, [USER_B]);
});

afterAll(async () => {
    // Run all cleanup on a single connection to avoid MVCC cross-connection
    // visibility issues (each pool.query() may get a fresh connection with its
    // own snapshot under MariaDB REPEATABLE READ).
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Basket WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Receipt WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM User WHERE id IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
    await pool.end();
});

// ---------------------------------------------------------------------------
// Basket creation — idempotency
// ---------------------------------------------------------------------------

describe('POST /api/baskets — idempotency', () => {
    afterEach(async () => {
        await pool.query(`DELETE FROM Basket WHERE userId = ?`, [USER_A]);
    });

    it('creates a basket and returns 201 with existing:false', async () => {
        const res = await request(app).post('/api/baskets').send({ userId: USER_A });
        expect(res.status).toBe(201);
        expect(res.body.existing).toBe(false);
        expect(typeof res.body.id).toBe('number');
    });

    it('returns the same basket on a second create (idempotent)', async () => {
        const first  = await request(app).post('/api/baskets').send({ userId: USER_A });
        const second = await request(app).post('/api/baskets').send({ userId: USER_A });
        expect(first.body.id).toBe(second.body.id);
        expect(second.body.existing).toBe(true);
        expect(second.status).toBe(200);
    });

    it('returns 400 when userId is missing', async () => {
        const res = await request(app).post('/api/baskets').send({});
        expect(res.status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// Receipt save — points awarded and savedAmount stored
// ---------------------------------------------------------------------------

describe('POST /api/receipts — points and savings', () => {
    let receiptId: number;

    const payload = (userId: string) => ({
        userId,
        filePath: 'inttest.jpg',
        fileType: 'image/jpeg',
        parsedData: {
            header: { storeId: 1, chainId: 1 },
            footer: { receiptNo: 'INT-001', date: '2024-06-01' },
            products: [
                {
                    name: 'Test SP',
                    storeProductId: 10,
                    matchConfirmed: true,
                    priceVerified: true,
                    price: 1.50,
                    promoPrice: null,
                    quantity: 2,
                    unit: 'vnt',
                },
            ],
        },
    });

    it('creates a completed receipt', async () => {
        const res = await request(app).post('/api/receipts').send(payload(USER_A));
        expect(res.status).toBe(201);
        receiptId = res.body.id;
        expect(typeof receiptId).toBe('number');
    });

    it('sets processingStatus=completed and stores receiptNo', async () => {
        const [rows]: any = await pool.query(`SELECT * FROM Receipt WHERE id = ?`, [receiptId]);
        expect(rows[0].processingStatus).toBe('completed');
        expect(rows[0].receiptNo).toBe('INT-001');
    });

    it('awards 1 point per item on the receipt', async () => {
        const [rows]: any = await pool.query(`SELECT points FROM User WHERE id = ?`, [USER_A]);
        expect(rows[0].points).toBe(1); // 1 product line = 1 point
    });

    it('stores a non-null savedAmount on the Receipt row', async () => {
        const [rows]: any = await pool.query(`SELECT savedAmount FROM Receipt WHERE id = ?`, [receiptId]);
        expect(rows[0].savedAmount).not.toBeNull();
        expect(typeof parseFloat(rows[0].savedAmount)).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// Swipe vote — recording and undo
// ---------------------------------------------------------------------------

describe('POST /api/swipe-votes — vote and undo', () => {
    let receiptId: number;

    beforeAll(async () => {
        // Receipt with SP 10 as the matched product. Swipe card will pair SP 10
        // against SP 11 (cross-product) so the vote lands in StoreProductMatchVote.
        const res = await request(app).post('/api/receipts').send({
            userId: USER_B,
            filePath: 'swipe-inttest.jpg',
            fileType: 'image/jpeg',
            parsedData: {
                header: { storeId: 1, chainId: 1 },
                footer: { receiptNo: 'INT-SWIPE', date: '2024-06-01' },
                products: [
                    {
                        name: 'Test SP',
                        storeProductId: 10,
                        matchConfirmed: true,
                        priceVerified: false,
                        price: 2.00,
                        promoPrice: null,
                        quantity: 1,
                        unit: 'vnt',
                    },
                ],
            },
        });
        receiptId = res.body.id;
    });

    it('records a swipe vote', async () => {
        const res = await request(app).post('/api/swipe-votes').send({
            userId: USER_B,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: 11, // cross-product: SP 11 vs line's SP 10
            vote: 'identical',
            dwellMs: 1200,
        });
        expect(res.status).toBe(200);
    });

    it('vote appears in StoreProductMatchVote', async () => {
        // Pair is always stored with spIdA < spIdB, so (10, 11).
        const [rows]: any = await pool.query(
            `SELECT * FROM StoreProductMatchVote WHERE userId = ? AND spIdA = 10 AND spIdB = 11`,
            [USER_B]
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].vote).toBe('identical');
    });

    it('undo removes the vote', async () => {
        await request(app).post('/api/swipe-votes/undo').send({
            userId: USER_B,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: 11,
        });
        const [rows]: any = await pool.query(
            `SELECT * FROM StoreProductMatchVote WHERE userId = ? AND spIdA = 10 AND spIdB = 11`,
            [USER_B]
        );
        expect(rows.length).toBe(0);
    });
});
