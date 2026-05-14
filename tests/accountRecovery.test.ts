/**
 * Integration tests for the 3-receipt account recovery flow.
 *
 * Requires the live test DB (Basket-DB-Test) — same setup as
 * tests/integration.test.ts. Seeds a "recovered" user with 3 receipts
 * across 2 chains, then exercises:
 *   - happy path (success, merge, fresh-user delete, points sum)
 *   - no-match (bogus inputs)
 *   - insufficient-chains (3 receipts all from one chain)
 *   - rate-limit (4th attempt locked)
 *
 * Each test cleans up its own state in afterAll to keep reruns idempotent.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(20000);

const RECOVERED_USER = 'rectest-rec0-0000-0000-000000000000';
const FRESH_USER     = 'rectest-fresh-000-0000-000000000000';
const FP             = 'recovery-test-fingerprint';

const CHAIN_A_ID = 901;
const CHAIN_B_ID = 902;
const STORE_A_ID = 9001;
const STORE_B_ID = 9002;

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM AccountRecoveryAttempt WHERE deviceFingerprint = ?`, [FP]);
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
        await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
        await conn.query(`DELETE FROM UserProductScore WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
        await conn.query(`DELETE FROM Basket WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
        await conn.query(`DELETE FROM ShoppingList WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
        await conn.query(`DELETE FROM Receipt WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
        await conn.query(`DELETE FROM User WHERE id IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
        await conn.query(`DELETE FROM Store WHERE id IN (?, ?)`, [STORE_A_ID, STORE_B_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id IN (?, ?)`, [CHAIN_A_ID, CHAIN_B_ID]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
}

async function seedChainsAndStores() {
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'Test Chain A') ON DUPLICATE KEY UPDATE id=id`, [CHAIN_A_ID]);
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'Test Chain B') ON DUPLICATE KEY UPDATE id=id`, [CHAIN_B_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'A1', 'Addr A') ON DUPLICATE KEY UPDATE id=id`, [STORE_A_ID, CHAIN_A_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'B1', 'Addr B') ON DUPLICATE KEY UPDATE id=id`, [STORE_B_ID, CHAIN_B_ID]);
}

interface SeedReceipt {
    userId: string;
    storeId: number;
    receiptNo: string;
    date: string;       // YYYY-MM-DD
    total: number;
}

async function seedReceipt(r: SeedReceipt): Promise<number> {
    const parsedData = JSON.stringify({
        footer: { receiptNo: r.receiptNo, date: r.date, total: r.total },
        products: [],
    });
    const [res]: any = await pool.query(
        `INSERT INTO Receipt
            (userId, storeId, filePath, fileType, processingStatus, receiptNo, receiptDate, parsedData)
         VALUES (?, ?, '/dev/null', 'image/jpeg', 'completed', ?, ?, ?)`,
        [r.userId, r.storeId, r.receiptNo, r.date, parsedData],
    );
    return Number(res.insertId);
}

beforeAll(async () => {
    await cleanup();
    await seedChainsAndStores();
    await pool.query(`INSERT INTO User (id, points) VALUES (?, ?)`, [RECOVERED_USER, 100]);
});

afterAll(async () => {
    await cleanup();
    // Don't end the pool — other tests in the same run share it.
});

describe('POST /api/users/recover', () => {
    beforeEach(async () => {
        // Reset between tests so the rate-limit counter starts fresh and
        // the fresh user / its receipts / its merge artefacts are clean.
        const conn = await (pool as any).getConnection();
        try {
            await conn.query(`SET foreign_key_checks = 0`);
            await conn.query(`DELETE FROM AccountRecoveryAttempt WHERE deviceFingerprint = ?`, [FP]);
            await conn.query(`DELETE FROM Receipt WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
            await conn.query(`DELETE FROM Basket WHERE userId IN (?, ?)`, [RECOVERED_USER, FRESH_USER]);
            await conn.query(`DELETE FROM User WHERE id = ?`, [FRESH_USER]);
            await conn.query(`SET foreign_key_checks = 1`);
            // Re-create the recovered user fresh (points re-stamped).
            await conn.query(`INSERT INTO User (id, points) VALUES (?, 100) ON DUPLICATE KEY UPDATE points = 100`, [RECOVERED_USER]);
            await conn.query(`INSERT INTO User (id, points) VALUES (?, 25)`, [FRESH_USER]);
        } finally {
            conn.release();
        }
    });

    it('happy path — 3 receipts, 2 chains, fresh user merged in, points summed', async () => {
        // Seed 3 receipts for recovered user across both chains.
        await seedReceipt({ userId: RECOVERED_USER, storeId: STORE_A_ID, receiptNo: 'R-A-1', date: '2026-01-10', total: 12.34 });
        await seedReceipt({ userId: RECOVERED_USER, storeId: STORE_B_ID, receiptNo: 'R-B-1', date: '2026-01-11', total: 5.67 });
        await seedReceipt({ userId: RECOVERED_USER, storeId: STORE_A_ID, receiptNo: 'R-A-2', date: '2026-01-12', total: 8.90 });

        // Fresh user has some activity (a Basket, no Receipts — using fresh-user
        // receipts here would risk colliding with the unique Receipt key).
        await pool.query(
            `INSERT INTO Basket (userId, status, name) VALUES (?, 'draft', 'fresh-basket')`,
            [FRESH_USER],
        );

        const res = await request(app)
            .post('/api/users/recover')
            .send({
                deviceFingerprint: FP,
                freshUserId: FRESH_USER,
                receipts: [
                    { receiptNo: 'R-A-1', date: '2026-01-10', total: 12.34 },
                    { receiptNo: 'R-B-1', date: '2026-01-11', total: 5.67 },
                    { receiptNo: 'R-A-2', date: '2026-01-12', total: 8.90 },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'success', recoveredUserId: RECOVERED_USER });

        // Fresh user row gone.
        const [users]: any = await pool.query(`SELECT id FROM User WHERE id = ?`, [FRESH_USER]);
        expect(users.length).toBe(0);

        // Fresh basket re-pointed to recovered user.
        const [baskets]: any = await pool.query(`SELECT userId FROM Basket WHERE userId = ?`, [RECOVERED_USER]);
        expect(baskets.length).toBe(1);

        // Points summed: 100 (recovered) + 25 (fresh) = 125.
        const [points]: any = await pool.query(`SELECT points FROM User WHERE id = ?`, [RECOVERED_USER]);
        expect(points[0].points).toBe(125);

        // Attempt row finalised as success.
        const [attempts]: any = await pool.query(
            `SELECT succeeded, failureReason, matchedUserId FROM AccountRecoveryAttempt WHERE deviceFingerprint = ?`,
            [FP],
        );
        expect(attempts.length).toBe(1);
        expect(attempts[0].succeeded).toBe(1);
        expect(attempts[0].matchedUserId).toBe(RECOVERED_USER);
        expect(attempts[0].failureReason).toBeNull();
    });

    it('rejects with status=failed when receipts do not match any stored row', async () => {
        const res = await request(app)
            .post('/api/users/recover')
            .send({
                deviceFingerprint: FP,
                freshUserId: FRESH_USER,
                receipts: [
                    { receiptNo: 'NOPE-1', date: '2026-01-01', total: 1.0 },
                    { receiptNo: 'NOPE-2', date: '2026-01-02', total: 2.0 },
                    { receiptNo: 'NOPE-3', date: '2026-01-03', total: 3.0 },
                ],
            });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'failed' });

        const [attempts]: any = await pool.query(
            `SELECT failureReason FROM AccountRecoveryAttempt WHERE deviceFingerprint = ?`,
            [FP],
        );
        expect(attempts[0].failureReason).toBe('no-match');
    });

    it('rejects with status=failed when all 3 receipts are from a single chain', async () => {
        await seedReceipt({ userId: RECOVERED_USER, storeId: STORE_A_ID, receiptNo: 'S-A-1', date: '2026-02-01', total: 1.11 });
        await seedReceipt({ userId: RECOVERED_USER, storeId: STORE_A_ID, receiptNo: 'S-A-2', date: '2026-02-02', total: 2.22 });
        await seedReceipt({ userId: RECOVERED_USER, storeId: STORE_A_ID, receiptNo: 'S-A-3', date: '2026-02-03', total: 3.33 });

        const res = await request(app)
            .post('/api/users/recover')
            .send({
                deviceFingerprint: FP,
                freshUserId: FRESH_USER,
                receipts: [
                    { receiptNo: 'S-A-1', date: '2026-02-01', total: 1.11 },
                    { receiptNo: 'S-A-2', date: '2026-02-02', total: 2.22 },
                    { receiptNo: 'S-A-3', date: '2026-02-03', total: 3.33 },
                ],
            });
        expect(res.body).toEqual({ status: 'failed' });

        const [attempts]: any = await pool.query(
            `SELECT failureReason FROM AccountRecoveryAttempt WHERE deviceFingerprint = ?`,
            [FP],
        );
        expect(attempts[0].failureReason).toBe('insufficient-chains');
    });

    it('locks the device after 3 failed attempts in the same 24h window', async () => {
        const badBody = {
            deviceFingerprint: FP,
            freshUserId: FRESH_USER,
            receipts: [
                { receiptNo: 'X-1', date: '2026-03-01', total: 1 },
                { receiptNo: 'X-2', date: '2026-03-02', total: 2 },
                { receiptNo: 'X-3', date: '2026-03-03', total: 3 },
            ],
        };

        for (let i = 0; i < 3; i++) {
            const res = await request(app).post('/api/users/recover').send(badBody);
            expect(res.body.status).toBe('failed');
        }

        const lockedRes = await request(app).post('/api/users/recover').send(badBody);
        expect(lockedRes.body).toEqual({ status: 'locked' });

        const [attempts]: any = await pool.query(
            `SELECT failureReason FROM AccountRecoveryAttempt WHERE deviceFingerprint = ? ORDER BY id`,
            [FP],
        );
        expect(attempts.map((r: any) => r.failureReason)).toEqual([
            'no-match', 'no-match', 'no-match', 'locked',
        ]);
    });

    it('rejects bad request bodies with 400', async () => {
        const res = await request(app).post('/api/users/recover').send({});
        expect(res.status).toBe(400);
    });
});
