/**
 * Integration tests for the admin amounts-cleanup tab.
 *
 * Seeds three SPs to exercise the parser-gated picker:
 *   A) name `Sūris 200g`,  stored amount=200, unit=g     → match (skip)
 *   B) name `Pienas 1L`,   stored amount=500, unit=ml    → mismatch (queue)
 *   C) name `Daržovės`,    stored amount=null, unit=null → unparseable (skip)
 *
 * Verifies the picker surfaces only B, that confirm writes the values
 * back, and that the lease lifecycle matches the image tab.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(20000);

const ADMIN_ID  = 'amt-aaaa-aaaa-aaaa-aaaaaaaaaaaaaaaa';
const CHAIN_ID  = 9501;
const STORE_ID  = 95001;
const CAT_ID    = 9501;

let spMatch: number;
let spMismatch: number;
let spUnparseable: number;

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ?`, [ADMIN_ID]);
        await conn.query(`DELETE FROM StoreProduct WHERE chainId = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Product WHERE categoryId = ?`, [CAT_ID]);
        await conn.query(`DELETE FROM Store WHERE id = ?`, [STORE_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN_ID]);
        await conn.query(`DELETE FROM Category WHERE id = ?`, [CAT_ID]);
        await conn.query(`DELETE FROM User WHERE id = ?`, [ADMIN_ID]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
}

beforeAll(async () => {
    await cleanup();
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 1)`, [ADMIN_ID]);
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'AmtTestChain')`, [CHAIN_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'AmtStore', 'AmtAddr')`, [STORE_ID, CHAIN_ID]);
    await pool.query(`INSERT INTO Category (id, name) VALUES (?, 'AmtCat')`, [CAT_ID]);

    const [pA]: any = await pool.query(
        `INSERT INTO Product (categoryId, name) VALUES (?, 'AmtMatchProduct')`, [CAT_ID],
    );
    const pAId = Number(pA.insertId);
    const [pB]: any = await pool.query(
        `INSERT INTO Product (categoryId, name) VALUES (?, 'AmtMismatchProduct')`, [CAT_ID],
    );
    const pBId = Number(pB.insertId);
    const [pC]: any = await pool.query(
        `INSERT INTO Product (categoryId, name) VALUES (?, 'AmtUnparseableProduct')`, [CAT_ID],
    );
    const pCId = Number(pC.insertId);

    // A — parser hit "200 g" matches stored 200 g
    const [aRes]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, amount, unit, isWeighable)
         VALUES (?, ?, 'Sūris RIMI 200g', 200, 'g', 0)`,
        [pAId, CHAIN_ID],
    );
    spMatch = Number(aRes.insertId);

    // B — parser hit "1 l" disagrees with stored 500 ml
    const [bRes]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, amount, unit, isWeighable)
         VALUES (?, ?, 'Pienas Dobilas 1L', 500, 'ml', 0)`,
        [pBId, CHAIN_ID],
    );
    spMismatch = Number(bRes.insertId);

    // C — name has no <num><unit> pattern, parser returns null
    const [cRes]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, amount, unit, isWeighable)
         VALUES (?, ?, 'Daržovės', NULL, NULL, 0)`,
        [pCId, CHAIN_ID],
    );
    spUnparseable = Number(cRes.insertId);
});

afterAll(async () => {
    await cleanup();
});

describe('admin amounts queue', () => {
    beforeEach(async () => {
        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);
    });

    it('claim-batch returns only mismatches (parser-hit + disagrees with DB)', async () => {
        const res = await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        expect(res.status).toBe(200);
        expect(res.body.resumed).toBe(false);

        const spIds = res.body.rows.map((r: any) => r.spId);
        expect(spIds).toContain(spMismatch);
        expect(spIds).not.toContain(spMatch);
        expect(spIds).not.toContain(spUnparseable);

        const row = res.body.rows.find((r: any) => r.spId === spMismatch);
        expect(row.suggestion).toEqual({
            amount: 1,
            unit: 'l',
            matched: '1L',
            isWeighable: false,
        });
        expect(row.storedAmount).toBeCloseTo(500, 4);
        expect(row.storedUnit).toBe('ml');
    });

    it('confirm writes amount/unit/isWeighable, logs audit, completes lease', async () => {
        // Claim batch first to set up an active lease for spMismatch.
        await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        const res = await request(app)
            .post(`/api/admin/amounts/${spMismatch}/confirm`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({ amount: 1, unit: 'l', isWeighable: false });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ spId: spMismatch, amount: 1, unit: 'l', isWeighable: false });

        const [sp]: any = await pool.query(
            `SELECT amount, unit, isWeighable FROM StoreProduct WHERE id = ?`, [spMismatch],
        );
        expect(parseFloat(String(sp[0].amount))).toBeCloseTo(1, 4);
        expect(sp[0].unit).toBe('l');
        expect(Number(sp[0].isWeighable)).toBe(0);

        const [audit]: any = await pool.query(
            `SELECT action, valueBefore, valueAfter FROM AdminAuditLog
              WHERE adminUserId = ? AND action = 'amount_set' AND targetId = ?
              ORDER BY id DESC LIMIT 1`,
            [ADMIN_ID, spMismatch],
        );
        expect(audit[0]).toBeDefined();
        const before = typeof audit[0].valueBefore === 'string'
            ? JSON.parse(audit[0].valueBefore) : audit[0].valueBefore;
        const after = typeof audit[0].valueAfter === 'string'
            ? JSON.parse(audit[0].valueAfter) : audit[0].valueAfter;
        expect(before.unit).toBe('ml');
        expect(after.unit).toBe('l');

        // Active-completion check: there should be a lease row for
        // this admin+sp with completedAt set. Multiple historical
        // lease rows can exist; we care about the latest.
        const [leases]: any = await pool.query(
            `SELECT completedAt FROM AdminCardLease
              WHERE leasedTo = ? AND queueKind = 'amount' AND spId = ?
                AND completedAt IS NOT NULL
              ORDER BY id DESC LIMIT 1`,
            [ADMIN_ID, spMismatch],
        );
        expect(leases.length).toBeGreaterThan(0);
        expect(leases[0].completedAt).not.toBeNull();
    });

    it('skip completes the lease but writes no SP change', async () => {
        await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });

        // Snapshot the SP before skipping so we can prove nothing changed.
        const [spBefore]: any = await pool.query(
            `SELECT amount, unit FROM StoreProduct WHERE id = ?`, [spMismatch],
        );

        const res = await request(app)
            .post(`/api/admin/amounts/${spMismatch}/skip`)
            .set('X-Admin-Id', ADMIN_ID);
        expect(res.status).toBe(200);

        const [spAfter]: any = await pool.query(
            `SELECT amount, unit FROM StoreProduct WHERE id = ?`, [spMismatch],
        );
        expect(parseFloat(String(spAfter[0].amount))).toBeCloseTo(
            parseFloat(String(spBefore[0].amount)), 4,
        );
        expect(spAfter[0].unit).toBe(spBefore[0].unit);
    });

    it('resume returns existing batch instead of stacking another', async () => {
        const first = await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        const firstSpIds = first.body.rows.map((r: any) => r.spId).sort();

        const second = await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        expect(second.body.resumed).toBe(true);
        const secondSpIds = second.body.rows.map((r: any) => r.spId).sort();
        expect(secondSpIds).toEqual(firstSpIds);
    });

    // Lease release behaviour is exercised by the image-queue suite —
    // the shared `releaseAdminBatch` helper backs both queue kinds.
    // Re-testing here against the populated DB is brittle (the picker
    // can fill 10 cards from other real mismatches before reaching
    // our synthetic test row).

    it('recently-resolved SP is excluded from the picker for 90 days', async () => {
        // Step 1: claim + confirm spMismatch. After this, AdminAuditLog
        // has an `amount_set` row tagged at NOW() for this SP.
        await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        await request(app)
            .post(`/api/admin/amounts/${spMismatch}/confirm`)
            .set('X-Admin-Id', ADMIN_ID)
            // Deliberately submit a value that DISAGREES with the
            // parser's suggestion (parser says {1, l}). If the filter
            // works the SP shouldn't surface again on next claim
            // even though the parser would still flag this as a
            // mismatch.
            .send({ amount: 0.7, unit: 'l', isWeighable: false });

        // Step 2: re-claim. The SP must not appear because it was
        // resolved within the 90-day window.
        const next = await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        const spIds = next.body.rows.map((r: any) => r.spId);
        expect(spIds).not.toContain(spMismatch);

        // Step 3: reset SP to mismatch state for the next test run
        // (afterAll cleanup handles full teardown but a clean state
        // helps subsequent it() blocks within this run).
        await pool.query(
            `UPDATE StoreProduct SET amount = 500, unit = 'ml' WHERE id = ?`,
            [spMismatch],
        );
    });

    it('reverted action puts the SP back into the queue immediately', async () => {
        // Clean state for this test.
        await pool.query(`DELETE FROM AdminAuditLog WHERE adminUserId = ? AND targetId = ?`, [ADMIN_ID, spMismatch]);
        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo = ?`, [ADMIN_ID]);

        // Plant a recent amount_set with reversedAt set — should NOT
        // gate the SP (because the action was reverted).
        await pool.query(
            `INSERT INTO AdminAuditLog
                (adminUserId, action, targetType, targetId,
                 valueBefore, valueAfter, reversedAt, createdAt)
             VALUES (?, 'amount_set', 'StoreProduct', ?, NULL, NULL, NOW(), NOW())`,
            [ADMIN_ID, spMismatch],
        );

        const res = await request(app)
            .post('/api/admin/amounts/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 25 });
        const spIds = res.body.rows.map((r: any) => r.spId);
        expect(spIds).toContain(spMismatch);
    });
});
