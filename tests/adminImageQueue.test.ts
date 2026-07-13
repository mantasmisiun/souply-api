/**
 * Integration tests for the admin image-cleanup tab.
 *
 * Seeds a tiny graph: chain A + chain B, two Products P1 + P2, P1 has
 * one SP per chain (A has image, B doesn't), P2 has only chain-B SP
 * with no image. Tests cover:
 *   - Queue surfaces both missing-image SPs and orders them by
 *     recentPurchaseCount.
 *   - Adopt-candidate writes the image + ImagePropagationLog + audit row.
 *   - Pending upload approval flips the row + writes the same logs.
 *   - Revert restores the previous imageUrl + flags both audit and
 *     propagation rows as reversed.
 *   - User-flagged ReceiptLineIssue rows jump to the top of the queue.
 *
 * Cleans up after itself so reruns are idempotent.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';

jest.setTimeout(20000);

const ADMIN_ID = 'admimg-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID  = 'admimg-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHAIN_A_ID = 911;
const CHAIN_B_ID = 912;
const STORE_A_ID = 9111;
const STORE_B_ID = 9112;
const CAT_ID = 689;

const SAMPLE_IMAGE_A = 'http://test/img-a.jpg';

let p1Id: number;
let p2Id: number;
let sp_p1_a: number;
let sp_p1_b: number;
let sp_p2_b: number;
let receiptId: number;

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM AdminCardLease WHERE leasedTo IN (?, ?)`, [ADMIN_ID, USER_ID]);
        await conn.query(`DELETE FROM AdminAuditLog WHERE adminUserId IN (?, ?)`, [ADMIN_ID, USER_ID]);
        await conn.query(`DELETE FROM ImagePropagationLog WHERE actor IN (?, ?, 'auto') AND spId IN (SELECT id FROM StoreProduct WHERE chainId IN (?, ?))`, [ADMIN_ID, USER_ID, CHAIN_A_ID, CHAIN_B_ID]);
        await conn.query(`DELETE FROM PendingImageUpload WHERE uploadedBy IN (?, ?)`, [ADMIN_ID, USER_ID]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE userId IN (?, ?)`, [ADMIN_ID, USER_ID]);
        await conn.query(`DELETE FROM Price WHERE storeProductId IN (SELECT id FROM StoreProduct WHERE chainId IN (?, ?))`, [CHAIN_A_ID, CHAIN_B_ID]);
        await conn.query(`DELETE FROM Receipt WHERE userId IN (?, ?)`, [ADMIN_ID, USER_ID]);
        await conn.query(`DELETE FROM StoreProduct WHERE chainId IN (?, ?)`, [CHAIN_A_ID, CHAIN_B_ID]);
        await conn.query(`DELETE FROM Product WHERE categoryId = ?`, [CAT_ID]);
        await conn.query(`DELETE FROM Store WHERE id IN (?, ?)`, [STORE_A_ID, STORE_B_ID]);
        await conn.query(`DELETE FROM StoreChain WHERE id IN (?, ?)`, [CHAIN_A_ID, CHAIN_B_ID]);
        await conn.query(`DELETE FROM Category WHERE id = ?`, [CAT_ID]);
        await conn.query(`DELETE FROM User WHERE id IN (?, ?, ?)`, [ADMIN_ID, ADMIN_B, USER_ID]);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
}

const ADMIN_B = 'admimg-cccc-cccc-cccc-cccccccccccc';

beforeAll(async () => {
    await cleanup();

    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 1)`, [ADMIN_ID]);
    await pool.query(`INSERT INTO User (id, isAdmin) VALUES (?, 1)`, [ADMIN_B]);
    await pool.query(`INSERT INTO User (id) VALUES (?)`, [USER_ID]);

    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'TestChainA') ON DUPLICATE KEY UPDATE id=id`, [CHAIN_A_ID]);
    await pool.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'TestChainB') ON DUPLICATE KEY UPDATE id=id`, [CHAIN_B_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'A', 'AddrA') ON DUPLICATE KEY UPDATE id=id`, [STORE_A_ID, CHAIN_A_ID]);
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?, ?, 'B', 'AddrB') ON DUPLICATE KEY UPDATE id=id`, [STORE_B_ID, CHAIN_B_ID]);
    await pool.query(`INSERT INTO Category (id, name) VALUES (?, 'TestCat')`, [CAT_ID]);

    const [p1Res]: any = await pool.query(
        `INSERT INTO Product (categoryId, name) VALUES (?, 'TestProduct1')`, [CAT_ID],
    );
    p1Id = Number(p1Res.insertId);
    const [p2Res]: any = await pool.query(
        `INSERT INTO Product (categoryId, name) VALUES (?, 'TestProduct2')`, [CAT_ID],
    );
    p2Id = Number(p2Res.insertId);

    const [r1]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, imageUrl) VALUES (?, ?, 'P1 A', ?)`,
        [p1Id, CHAIN_A_ID, SAMPLE_IMAGE_A],
    );
    sp_p1_a = Number(r1.insertId);

    const [r2]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, imageUrl) VALUES (?, ?, 'P1 B', NULL)`,
        [p1Id, CHAIN_B_ID],
    );
    sp_p1_b = Number(r2.insertId);

    const [r3]: any = await pool.query(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, imageUrl) VALUES (?, ?, 'P2 B', NULL)`,
        [p2Id, CHAIN_B_ID],
    );
    sp_p2_b = Number(r3.insertId);

    // Seed a receipt + Price rows so recentPurchaseCount has signal.
    const [rcpt]: any = await pool.query(
        `INSERT INTO Receipt (userId, storeId, filePath, fileType, processingStatus, receiptNos, receiptDate, parsedData)
         VALUES (?, ?, '/dev/null', 'image/jpeg', 'completed', JSON_ARRAY('AIQ-1'), NOW(), JSON_OBJECT('footer', JSON_OBJECT('total', 1.0)))`,
        [USER_ID, STORE_B_ID],
    );
    receiptId = Number(rcpt.insertId);
    // Stagger timestamps — Price has a unique constraint on
    // (storeProductId, storeId, date) so back-to-back inserts collide.
    // Hardcoding distinct DATETIMEs avoids same-second NOW() collisions.
    // All within the 30-day window so recentPurchaseCount picks them up.
    const baseDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    for (let i = 0; i < 3; i++) {
        const d = new Date(baseDate.getTime() + i * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');
        await pool.query(
            `INSERT INTO Price (storeProductId, storeId, receiptId, price, date)
             VALUES (?, ?, ?, 1.0, ?)`,
            [sp_p1_b, STORE_B_ID, receiptId, d],
        );
    }
    const p2Date = new Date(baseDate.getTime() + 10 * 60 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
        `INSERT INTO Price (storeProductId, storeId, receiptId, price, date)
         VALUES (?, ?, ?, 2.0, ?)`,
        [sp_p2_b, STORE_B_ID, receiptId, p2Date],
    );
});

afterAll(async () => {
    await cleanup();
});

describe('admin image queue', () => {
    beforeEach(async () => {
        // Each test starts with no active leases for either admin so the
        // claim/release behaviour is predictable.
        await pool.query(`DELETE FROM AdminCardLease WHERE leasedTo IN (?, ?)`, [ADMIN_ID, ADMIN_B]);
    });

    it('claim-batch returns SPs missing image, ordered by purchase count, with cross-chain candidate', async () => {
        const res = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 10 });
        expect(res.status).toBe(200);
        expect(res.body.resumed).toBe(false);

        const p1bRow = res.body.rows.find((r: any) => r.spId === sp_p1_b);
        const p2bRow = res.body.rows.find((r: any) => r.spId === sp_p2_b);
        expect(p1bRow).toBeTruthy();
        expect(p2bRow).toBeTruthy();
        expect(p1bRow.flaggedByUser).toBe(false);
        expect(p1bRow.recentPurchaseCount).toBe(3);
        expect(p2bRow.recentPurchaseCount).toBe(1);

        const xChainCand = p1bRow.candidates.find((c: any) => c.sourceType === 'cross_chain_sibling');
        expect(xChainCand).toBeTruthy();
        expect(xChainCand.imageUrl).toBe(SAMPLE_IMAGE_A);
        expect(xChainCand.sourceSpId).toBe(sp_p1_a);
        expect(p2bRow.candidates.length).toBe(0);
    });

    it('two admins claiming back-to-back get disjoint batches', async () => {
        const resA = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 1 });
        const resB = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_B)
            .send({ size: 1 });
        expect(resA.body.rows.length).toBe(1);
        expect(resB.body.rows.length).toBe(1);
        expect(resA.body.rows[0].spId).not.toBe(resB.body.rows[0].spId);
    });

    it('claim-batch resumes existing batch instead of stacking another', async () => {
        const first = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 1 });
        const claimedSpId = first.body.rows[0].spId;

        const second = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 1 });
        expect(second.body.resumed).toBe(true);
        expect(second.body.rows[0].spId).toBe(claimedSpId);
    });

    it('release-batch returns leases so other admins can claim them', async () => {
        const resA = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 1 });
        const claimedSpId = resA.body.rows[0].spId;

        // Admin B can't see that SP while A holds the lease.
        const beforeRelease = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_B)
            .send({ size: 1 });
        expect(beforeRelease.body.rows[0]?.spId).not.toBe(claimedSpId);

        // Release A's batch then drop B's batch so a fresh claim is honest.
        await request(app)
            .post('/api/admin/images/release-batch')
            .set('X-Admin-Id', ADMIN_ID);
        await request(app)
            .post('/api/admin/images/release-batch')
            .set('X-Admin-Id', ADMIN_B);

        const afterRelease = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_B)
            .send({ size: 50 });
        // SP should be back in the eligible pool now.
        const found = afterRelease.body.rows.some((r: any) => r.spId === claimedSpId);
        expect(found).toBe(true);
    });

    it('adopt-candidate writes the image, propagation log, and audit row', async () => {
        const res = await request(app)
            .post(`/api/admin/images/${sp_p1_b}/adopt-candidate`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({
                imageUrl: SAMPLE_IMAGE_A,
                sourceType: 'cross_chain_sibling',
                sourceSpId: sp_p1_a,
            });
        expect(res.status).toBe(200);
        expect(res.body.imageUrl).toBe(SAMPLE_IMAGE_A);

        const [sp]: any = await pool.query(`SELECT imageUrl FROM StoreProduct WHERE id = ?`, [sp_p1_b]);
        expect(sp[0].imageUrl).toBe(SAMPLE_IMAGE_A);

        const [prop]: any = await pool.query(
            `SELECT sourceType, actor, fromImageUrl, toImageUrl FROM ImagePropagationLog WHERE spId = ? ORDER BY id DESC LIMIT 1`,
            [sp_p1_b],
        );
        expect(prop[0].sourceType).toBe('admin_adopt_candidate');
        expect(prop[0].actor).toBe(ADMIN_ID);
        expect(prop[0].fromImageUrl).toBeNull();
        expect(prop[0].toImageUrl).toBe(SAMPLE_IMAGE_A);

        const [audit]: any = await pool.query(
            `SELECT action, valueBefore, valueAfter FROM AdminAuditLog WHERE adminUserId = ? ORDER BY id DESC LIMIT 1`,
            [ADMIN_ID],
        );
        expect(audit[0].action).toBe('image_adopt_candidate');
        // mysql2 returns JSON columns as already-parsed objects.
        const before = typeof audit[0].valueBefore === 'string'
            ? JSON.parse(audit[0].valueBefore) : audit[0].valueBefore;
        const after = typeof audit[0].valueAfter === 'string'
            ? JSON.parse(audit[0].valueAfter) : audit[0].valueAfter;
        expect(before.imageUrl).toBeNull();
        expect(after.imageUrl).toBe(SAMPLE_IMAGE_A);
    });

    it('approving a pending upload flips the row + writes propagation', async () => {
        const [pu]: any = await pool.query(
            `INSERT INTO PendingImageUpload (spId, uploadedBy, filePath) VALUES (?, ?, 'http://test/pu.jpg')`,
            [sp_p2_b, USER_ID],
        );
        const pendingUploadId = Number(pu.insertId);

        const res = await request(app)
            .post(`/api/admin/images/${sp_p2_b}/adopt-candidate`)
            .set('X-Admin-Id', ADMIN_ID)
            .send({
                imageUrl: 'http://test/pu.jpg',
                sourceType: 'pending_upload',
                pendingUploadId,
            });
        expect(res.status).toBe(200);

        const [pendingAfter]: any = await pool.query(
            `SELECT status, resolvedBy FROM PendingImageUpload WHERE id = ?`,
            [pendingUploadId],
        );
        expect(pendingAfter[0].status).toBe('approved');
        expect(pendingAfter[0].resolvedBy).toBe(ADMIN_ID);

        const [prop]: any = await pool.query(
            `SELECT sourceType FROM ImagePropagationLog WHERE spId = ? ORDER BY id DESC LIMIT 1`,
            [sp_p2_b],
        );
        expect(prop[0].sourceType).toBe('user_upload_approved');
    });

    it('revert restores the previous image and marks audit + propagation reversed', async () => {
        // Adopt sets imageUrl. Then revert via the audit row.
        const [audit]: any = await pool.query(
            `SELECT id FROM AdminAuditLog
              WHERE adminUserId = ? AND action = 'image_adopt_candidate' AND targetId = ?
              ORDER BY id DESC LIMIT 1`,
            [ADMIN_ID, sp_p1_b],
        );
        const auditId = Number(audit[0].id);

        const res = await request(app)
            .post(`/api/admin/images/revert/${auditId}`)
            .set('X-Admin-Id', ADMIN_ID);
        expect(res.status).toBe(200);
        expect(res.body.imageUrl).toBeNull();

        const [sp]: any = await pool.query(`SELECT imageUrl FROM StoreProduct WHERE id = ?`, [sp_p1_b]);
        expect(sp[0].imageUrl).toBeNull();

        const [auditAfter]: any = await pool.query(`SELECT reversedAt FROM AdminAuditLog WHERE id = ?`, [auditId]);
        expect(auditAfter[0].reversedAt).not.toBeNull();

        const [propAfter]: any = await pool.query(
            `SELECT reversedAt FROM ImagePropagationLog WHERE spId = ? AND toImageUrl = ?`,
            [sp_p1_b, SAMPLE_IMAGE_A],
        );
        expect(propAfter[0].reversedAt).not.toBeNull();
    });

    it('user-flagged image issues are excluded — Flags tab owns them', async () => {
        // The Flags tab is the sole owner of user complaints across
        // image, amount, name, price, discount. The image tab is
        // strictly heuristic — missing-imageUrl only.
        //
        // sp_p1_b currently has imageUrl=null (revert test cleared
        // it) so it would normally surface here. After adding an
        // image flag for it, the picker must skip it.
        await pool.query(
            `INSERT INTO ReceiptLineIssue (receiptId, receiptLineIdx, userId, flags)
             VALUES (?, 0, ?, JSON_OBJECT('image', TRUE, 'name', FALSE, 'price', FALSE, 'amount', FALSE, 'discount', FALSE))`,
            [receiptId, USER_ID],
        );

        const res = await request(app)
            .post('/api/admin/images/claim-batch')
            .set('X-Admin-Id', ADMIN_ID)
            .send({ size: 50 });

        const spIds = res.body.rows.map((r: any) => r.spId);
        expect(spIds).not.toContain(sp_p1_b);
    });

    it('rate limit blocks once 200 actions/hr exceeded', async () => {
        // Manually backfill 200 audit rows for this admin in the last hour.
        const values: any[] = [];
        const placeholders: string[] = [];
        for (let i = 0; i < 200; i++) {
            placeholders.push("(?, 'image_skip', 'StoreProduct', ?, NOW())");
            values.push(ADMIN_ID, sp_p1_a);
        }
        await pool.query(
            `INSERT INTO AdminAuditLog (adminUserId, action, targetType, targetId, createdAt)
             VALUES ${placeholders.join(',')}`,
            values,
        );

        const res = await request(app)
            .post(`/api/admin/images/${sp_p1_a}/skip`)
            .set('X-Admin-Id', ADMIN_ID);
        expect(res.status).toBe(429);
    });
});
