import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

const testUserId = '11111111-1111-1111-1111-111111111111';

jest.setTimeout(20000);

beforeAll(async () => {
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (1, 'Test Chain') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Store (id, chainId, name) VALUES (1, 1, 'Test Store') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Category (id, name) VALUES (1, 'Test Category') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO Product (id, categoryId, name) VALUES (1, 1, 'Test Product') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (10, 1, 1, 'Test Store Product') ON DUPLICATE KEY UPDATE id=id`);
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 0) ON DUPLICATE KEY UPDATE id=id`, [testUserId]);
});

afterAll(async () => {
    await pool.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId = ?)`, [testUserId]);
    await pool.query(`DELETE FROM Receipt WHERE userId = ?`, [testUserId]);
    await pool.query(`DELETE FROM User WHERE id = ?`, [testUserId]);
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

        const res = await request(app)
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
        expect(receipt.receiptNo).toBe('TEST-001');

        // 3. Price row was created correctly
        const [prices] = await pool.query(
            `SELECT * FROM Price WHERE receiptId = ?`,
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