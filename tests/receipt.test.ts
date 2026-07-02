import { jest } from '@jest/globals';
import request from 'supertest';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import app from '../src/index.js';
import pool from '../src/config/db.js';

const testUserId = '11111111-1111-1111-1111-111111111111';

jest.setTimeout(20000);

beforeAll(async () => {
        await primeTokens(testUserId);
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (1, 'Test Chain') ON DUPLICATE KEY UPDATE id=id`);
    // Store.address is NOT NULL in the schema.
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (1, 1, 'Test Store', 'Test St. 1') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Category (id, name) VALUES (1, 'Test Category') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Product (id, categoryId, name) VALUES (1, 1, 'Test Product') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (10, 1, 1, 'Test Store Product') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 0) ON DUPLICATE KEY UPDATE id=id`, [testUserId]);
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [testUserId]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [testUserId]);
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [testUserId]);
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId = ?`, [testUserId]);
        await conn.query(`DELETE FROM Receipt WHERE userId = ?`, [testUserId]);
        await conn.query(`DELETE FROM User WHERE id = ?`, [testUserId]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
    await pool.end();
});

describe('POST /api/receipts', () => {
    it('should create a receipt and persist correct DB entries', async () => {
        const mockPayload = {
            userId: testUserId,
            filePath: 'test.jpg',
            fileType: 'image/jpeg',
            parsedData: {
                header: { storeId: 1, chainId: 1 },
                footer: { receiptNo: 'TEST-001', date: '2024-01-01' },
                products: [
                    {
                        storeProductId: 10,
                        matchConfirmed: true,
                        priceVerified: true,
                        price: 1.29,
                        promoPrice: null,
                        quantity: 1,
                        unit: 'pcs',
                    },
                ],
            },
        };

        const res = await asUser(app, testUserId)
            .post('/api/receipts')
            .send(mockPayload);

        // 1. API response
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('id');
        expect(res.body.saved).toBe(1);
        expect(res.body.skippedNoMatch).toBe(0);

        const receiptId = res.body.id;

        // 2. Receipt row exists and is correct
        const [receipts] = await pool.query(
            `SELECT * FROM Receipt WHERE id = ?`,
            [receiptId]
        ) as any;
        expect(receipts).toHaveLength(1);
        const receipt = receipts[0];
        expect(receipt.userId).toBe(testUserId);
        expect(receipt.storeId).toBe(1);
        expect(receipt.processingStatus).toBe('completed');
        // The canonical id is now a generated column derived from receiptNos[0].
        expect(JSON.parse(receipt.receiptNos)).toEqual(['TEST-001']);
        expect(receipt.receiptNoCanonical).toBe('TEST-001');

        // 3. Price row was created correctly.
        // Filter isFallback=0: the fire-and-forget propagation also creates
        // fallback rows for other stores in the chain linked to the same receiptId.
        const [prices] = await pool.query(
            `SELECT * FROM Price WHERE receiptId = ? AND isFallback = 0`,
            [receiptId]
        ) as any;
        expect(prices).toHaveLength(1);
        const price = prices[0];
        expect(price.storeProductId).toBe(10);
        expect(price.storeId).toBe(1);
        expect(parseFloat(price.price)).toBe(1.29);
        expect(price.priceVerified).toBe(1);
        expect(price.isFallback).toBe(0);
    });
});

describe('PATCH /api/receipts/:id/regions — receiptNos column stays in lockstep with a re-parse', () => {
    // Seed a receipt stored with only ONE identifier (an earlier parser revision), as receipt-143 was.
    async function seedSingleId(date: string): Promise<number> {
        const parsed = {
            header: { storeId: 1, chainId: 1 },
            footer: { receiptNo: '168/645/104148', receiptNos: ['168/645/104148'], date, total: 5.0 },
            products: [],
        };
        const [ins]: any = await pool.query(
            `INSERT INTO Receipt (userId, storeId, filePath, fileType, processingStatus, receiptNos, receiptDate, parsedData)
             VALUES (?, 1, '/dev/null', 'image/jpeg', 'completed', ?, ?, ?)`,
            [testUserId, JSON.stringify(['168/645/104148']), date, JSON.stringify(parsed)],
        );
        return Number(ins.insertId);
    }

    it('a re-parse that finds MORE ids (the fresh receiptNos array) converges the column to the full set', async () => {
        const rid = await seedSingleId('2026-06-29');
        // receipt-143: new parser reads all three ids; the client sends the fresh array to /regions.
        const res = await asUser(app, testUserId)
            .patch(`/api/receipts/${rid}/regions`)
            .send({ headerLineRegions: [], footerLineRegions: [], productRegions: [], receiptNos: ['168/645/104148', '104148', '3157'] });
        expect(res.status).toBe(200);

        const [rows]: any = await pool.query(`SELECT receiptNoCanonical AS receiptNo, receiptNos FROM Receipt WHERE id = ?`, [rid]);
        const col = JSON.parse(rows[0].receiptNos);
        expect(rows[0].receiptNo).toBe('168/645/104148'); // canonical (generated from receiptNos[0]) stays stable
        expect(col[0]).toBe('168/645/104148');             // …and still receiptNos[0]
        expect(col).toEqual(expect.arrayContaining(['168/645/104148', '104148', '3157'])); // full set now captured
    });

    it('also folds a single corrected receiptNo string (older client) into the column', async () => {
        const rid = await seedSingleId('2026-06-28');
        const res = await asUser(app, testUserId)
            .patch(`/api/receipts/${rid}/regions`)
            .send({ headerLineRegions: [], footerLineRegions: [], productRegions: [], receiptNo: '9/100/55555' });
        expect(res.status).toBe(200);
        const [rows]: any = await pool.query(`SELECT receiptNos FROM Receipt WHERE id = ?`, [rid]);
        expect(JSON.parse(rows[0].receiptNos)).toContain('9/100/55555');
    });

    it('a re-parse whose new canonical would COLLIDE keeps identity (no 500) — persists parse only', async () => {
        // Receipt A owns canonical 'COLLIDE-1' at store 1 on a date.
        await pool.query(
            `INSERT INTO Receipt (userId, storeId, filePath, fileType, processingStatus, receiptNos, receiptDate, parsedData)
             VALUES (?, 1, '/dev/null', 'image/jpeg', 'completed', ?, '2026-06-27', ?)`,
            [testUserId, JSON.stringify(['COLLIDE-1']), JSON.stringify({ footer: { receiptNos: ['COLLIDE-1'] } })],
        );
        // Receipt B has NO canonical yet (receiptNos NULL), same store + date.
        const [insB]: any = await pool.query(
            `INSERT INTO Receipt (userId, storeId, filePath, fileType, processingStatus, receiptNos, receiptDate, parsedData)
             VALUES (?, 1, '/dev/null', 'image/jpeg', 'completed', NULL, '2026-06-27', ?)`,
            [testUserId, JSON.stringify({ header: {}, footer: { date: '2026-06-27' }, products: [] })],
        );
        const ridB = Number(insB.insertId);

        // A re-parse of B claims 'COLLIDE-1' → would collide with A on (canonical, store, date).
        const res = await asUser(app, testUserId)
            .patch(`/api/receipts/${ridB}/regions`)
            .send({ headerLineRegions: [], footerLineRegions: [], productRegions: [], receiptNos: ['COLLIDE-1'] });
        expect(res.status).toBe(200);                                  // no surprise 500
        const [rows]: any = await pool.query(`SELECT receiptNos, receiptNoCanonical FROM Receipt WHERE id = ?`, [ridB]);
        expect(rows[0].receiptNos).toBeNull();                          // identity unchanged (kept its no-id)
        expect(rows[0].receiptNoCanonical).toBeNull();
    });
});