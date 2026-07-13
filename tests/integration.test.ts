/**
 * Integration tests — require a live test DB (Basket-DB-Test).
 * Run the GRANT first if tests fail with "Access denied":
 *   CREATE USER IF NOT EXISTS 'dbuser_test'@'<this-machine-ip>' IDENTIFIED BY '<password>';
 *   GRANT ALL PRIVILEGES ON `Basket-DB-Test`.* TO 'dbuser_test'@'<this-machine-ip>';
 *   FLUSH PRIVILEGES;
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { replaceReceiptItems, getReceiptItemLines, syncReceiptItemMatchState } from '../src/models/receiptItemModel.js';
import { getReceiptById } from '../src/models/receiptModel.js';
import { castReceiptLineVote } from '../src/services/receiptLineVoteService.js';

jest.setTimeout(20000);

const USER_A = 'inttest-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'inttest-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeAll(async () => {
        await primeTokens(USER_A, USER_B);
    // Pre-cleanup: remove any leftovers from previous crashed/failed runs.
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId IN (?,?)`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
        await conn.query(`DELETE FROM ReceiptItem WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
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
    // Store.address is NOT NULL in the schema — every seed needs it
    // even if the test logic doesn't read it.
    await pool.query(`INSERT INTO Store (id, chainId, name, address) VALUES (1,1,'Test Store','Test St. 1') ON DUPLICATE KEY UPDATE id=id`);
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
        await conn.query(`DELETE FROM ReceiptItem WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [USER_A, USER_B]);
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
        const res = await asUser(app, USER_A).post('/api/baskets').send({ userId: USER_A });
        expect(res.status).toBe(201);
        expect(res.body.existing).toBe(false);
        expect(typeof res.body.id).toBe('number');
    });

    it('returns the same basket on a second create (idempotent)', async () => {
        const first  = await asUser(app, USER_A).post('/api/baskets').send({ userId: USER_A });
        const second = await asUser(app, USER_A).post('/api/baskets').send({ userId: USER_A });
        expect(first.body.id).toBe(second.body.id);
        expect(second.body.existing).toBe(true);
        expect(second.status).toBe(200);
    });

    it('ignores a body userId — identity comes from the token (empty body still creates)', async () => {
        const res = await asUser(app, USER_A).post('/api/baskets').send({});
        expect([200, 201]).toContain(res.status); // created/idempotent for the token subject, not rejected
    });

    it('rejects basket creation with no session token (401)', async () => {
        const res = await request(app).post('/api/baskets').send({ userId: USER_A });
        expect(res.status).toBe(401);
    });

    it("a body userId cannot forge ownership — basket is created for the TOKEN subject, not the body", async () => {
        // USER_B's token but a body claiming USER_A → basket must belong to USER_B.
        const res = await asUser(app, USER_B).post('/api/baskets').send({ userId: USER_A });
        expect([200, 201]).toContain(res.status);
        const [rows]: any = await pool.query('SELECT userId FROM Basket WHERE id = ?', [res.body.id]);
        expect(rows[0].userId).toBe(USER_B);
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
        const res = await asUser(app, USER_A).post('/api/receipts').send(payload(USER_A));
        expect(res.status).toBe(201);
        receiptId = res.body.id;
        expect(typeof receiptId).toBe('number');
    });

    it('sets processingStatus=completed and stores receiptNo', async () => {
        const [rows]: any = await pool.query(`SELECT * FROM Receipt WHERE id = ?`, [receiptId]);
        expect(rows[0].processingStatus).toBe('completed');
        // canonical id is the generated column derived from receiptNos[0]
        expect(rows[0].receiptNoCanonical).toBe('INT-001');
        expect(JSON.parse(rows[0].receiptNos)).toEqual(['INT-001']);
    });

    it('awards 1 point per item on the receipt', async () => {
        // Points award is intentionally fire-and-forget after the receipt
        // transaction commits (see receiptSaveService — moved out of the
        // critical TX to avoid User-row lock contention). Poll for up to
        // 1 s so the test isn't racy against the background UPDATE.
        let points = 0;
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
            const [rows]: any = await pool.query(
                `SELECT points FROM User WHERE id = ?`,
                [USER_A],
            );
            points = Number(rows[0]?.points ?? 0);
            if (points === 1) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        expect(points).toBe(1); // 1 product line = 1 point
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
        const res = await asUser(app, USER_B).post('/api/receipts').send({
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
        const res = await asUser(app, USER_B).post('/api/swipe-votes').send({
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
        await asUser(app, USER_B).post('/api/swipe-votes/undo').send({
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

// ---------------------------------------------------------------------------
// ReceiptItem — real-DB round-trip (proves DECIMAL/JSON persistence + coercion,
// beyond the pure-mapping unit suite). See shared/RECEIPT_ITEM_MIGRATION.md.
// ---------------------------------------------------------------------------

describe('ReceiptItem — persist + reassemble round-trip', () => {
    let receiptId: number;

    beforeAll(async () => {
        const [res]: any = await pool.query(
            `INSERT INTO Receipt (userId, storeId, filePath, processingStatus) VALUES (?, 1, 'ri-test', 'completed')`,
            [USER_A],
        );
        receiptId = res.insertId;
    });
    afterAll(async () => {
        await pool.query(`DELETE FROM ReceiptItem WHERE receiptId = ?`, [receiptId]);
        await pool.query(`DELETE FROM Receipt WHERE id = ?`, [receiptId]);
    });

    it('writes rows and reassembles the same line values (no data loss)', async () => {
        const lines = [
            { // matched
                name: 'TEST PIENAS', price: 1.29, promoPrice: null, quantity: 2, unit: 'vnt',
                amount: 1, sizeUnit: 'l', isWeighable: false, brandName: 'IKI',
                storeProductId: 10, matchedName: 'Test SP', matchConfidence: 0.97,
                matchConfirmed: true, priceVerified: true,
                itemConfidence: { band: 'S1', score: 0.95 },
                altMatches: [{ storeProductId: 10, productId: 1, storeProductName: 'Test SP', confidence: 0.97 }],
                region: { yTop: 10, yBottom: 40, xLeft: 0, xRight: 500 },
                rawLines: ['TEST PIENAS', '1,29'],
                wordsDump: ['TEST', 'PIENAS'], // unknown key → extra
            },
            { // unmatched (matchedSpId NULL)
                name: 'NEATPAŽINTA', price: 3.49, quantity: 1, unit: 'vnt',
                storeProductId: null, matchConfirmed: false, priceVerified: false,
                itemConfidence: { band: 'S3', score: 0.1 }, altMatches: [],
            },
            { // promo + weighable
                name: 'BANANAI', price: 1.79, promoPrice: 1.29, quantity: 0.236, unit: 'kg',
                isWeighable: true, pricePerUnit: 5.47, storeProductId: 11, matchConfirmed: true,
                itemConfidence: { band: 'S1', score: 0.9 },
            },
        ];

        const idMap = await replaceReceiptItems(receiptId, lines, undefined);
        expect(idMap.size).toBe(3);

        const back = await getReceiptItemLines(receiptId);
        expect(back.length).toBe(3);

        // No data loss: every key on each original line round-trips through the real DB.
        const norm = (x: any) => JSON.parse(JSON.stringify(x));
        for (let i = 0; i < lines.length; i++) {
            for (const k of Object.keys(lines[i])) {
                if ((lines[i] as any)[k] === undefined) continue;
                expect(norm(back[i][k])).toEqual(norm((lines[i] as any)[k]));
            }
        }
        // storeProductId <-> matchedSpId; unknown key restored from `extra`.
        expect(back[0].storeProductId).toBe(10);
        expect(back[1].storeProductId).toBeNull();
        expect(back[0].wordsDump).toEqual(['TEST', 'PIENAS']);
        // DECIMAL persisted + coerced back to a number.
        expect(back[2].promoPrice).toBe(1.29);
        expect(back[2].pricePerUnit).toBe(5.47);

        // idempotent re-write replaces, not appends.
        await replaceReceiptItems(receiptId, lines, undefined);
        const [cnt]: any = await pool.query(`SELECT COUNT(*) AS n FROM ReceiptItem WHERE receiptId = ?`, [receiptId]);
        expect(Number(cnt[0].n)).toBe(3);
    });

    it('syncReceiptItemMatchState patches only match-state columns (single-row update)', async () => {
        await replaceReceiptItems(receiptId, [{
            name: 'SYNC', price: 2, storeProductId: 10, matchConfirmed: false, priceVerified: false,
            itemConfidence: { band: 'S2', score: 0.6 }, altMatches: [{ storeProductId: 10, confidence: 0.6 }],
        }], undefined);

        // Mutate the line as an 'identical' vote would, then sync the row.
        const mutated = {
            name: 'SYNC', price: 2, storeProductId: 10, matchConfirmed: true, priceVerified: true,
            variantUncertain: false, itemConfidence: { band: 'S1', score: 0.95 },
        };
        const affected = await syncReceiptItemMatchState(receiptId, 0, mutated, undefined);
        expect(affected).toBe(1);

        const back = await getReceiptItemLines(receiptId);
        expect(back[0].matchConfirmed).toBe(true);
        expect(back[0].priceVerified).toBe(true);
        expect(back[0].itemConfidence).toEqual({ band: 'S1', score: 0.95 });
        // Immutable OCR + altMatches were NOT touched by the match-state patch.
        expect(back[0].name).toBe('SYNC');
        expect(back[0].altMatches).toEqual([{ storeProductId: 10, confidence: 0.6 }]);
    });

    it('getReceiptById sources products[] from ReceiptItem rows, not the blob (P2 Step B)', async () => {
        // Put DELIBERATELY DIFFERENT products in the blob vs the rows — the read must return ROWS.
        await pool.query(`UPDATE Receipt SET parsedData = ? WHERE id = ?`, [
            JSON.stringify({ header: { chainId: 1 }, products: [{ name: 'STALE BLOB', price: 99 }], footer: { total: 5 } }),
            receiptId,
        ]);
        await replaceReceiptItems(receiptId, [{
            name: 'FROM ROWS', price: 1.5, storeProductId: 10, matchConfirmed: true,
            itemConfidence: { band: 'S1', score: 0.9 },
        }], undefined);

        const receipt: any = await getReceiptById(receiptId);
        const parsed = typeof receipt.parsedData === 'string' ? JSON.parse(receipt.parsedData) : receipt.parsedData;
        expect(parsed.products.length).toBe(1);
        expect(parsed.products[0].name).toBe('FROM ROWS');       // rows won
        expect(parsed.products[0].storeProductId).toBe(10);
        expect(parsed.header.chainId).toBe(1);                    // header/footer kept from blob
        expect(parsed.footer.total).toBe(5);
    });

    it('castReceiptLineVote(identical) confirms the row via single-row UPDATE, blob stays products-free (P2 Step C)', async () => {
        // Header on the blob (chainId), products[] live in ReceiptItem.
        await pool.query(`UPDATE Receipt SET parsedData = ? WHERE id = ?`, [
            JSON.stringify({ header: { chainId: 1 }, products: [], footer: {} }), receiptId,
        ]);
        await replaceReceiptItems(receiptId, [{
            name: 'VOTE', price: 2, storeProductId: 10, matchConfidence: 0.9,
            matchConfirmed: false, priceVerified: false, itemConfidence: { band: 'S2', score: 0.7 },
        }], undefined);

        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            const line = await castReceiptLineVote(receiptId, 0, 'identical', conn); // no userId → alias skipped
            await conn.commit();
            expect(line.matchConfirmed).toBe(true);
        } finally { conn.release(); }

        const back = await getReceiptItemLines(receiptId);
        expect(back[0].matchConfirmed).toBe(true);
        expect(back[0].priceVerified).toBe(true);
        expect(back[0].itemConfidence.band).toBe('S1');       // user-confirmed → S1
        // The blob was NOT rewritten with products — it stays header/footer only.
        const [[r]]: any = await pool.query(`SELECT parsedData FROM Receipt WHERE id = ?`, [receiptId]);
        const pd = typeof r.parsedData === 'string' ? JSON.parse(r.parsedData) : r.parsedData;
        expect(pd.products).toEqual([]);
    });

    it('castReceiptLineVote(different) demotes the row to OCR via single-row UPDATE (P2 Step C)', async () => {
        await pool.query(`UPDATE Receipt SET parsedData = ? WHERE id = ?`, [
            JSON.stringify({ header: { chainId: 1 }, products: [], footer: {} }), receiptId,
        ]);
        await replaceReceiptItems(receiptId, [{
            name: 'DEMOTE', price: 2, storeProductId: 10, matchConfirmed: true,
            altMatches: [], itemConfidence: { band: 'S1', score: 0.9 },
        }], undefined);

        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            await castReceiptLineVote(receiptId, 0, 'different', conn); // no runner-up → OCR clear
            await conn.commit();
        } finally { conn.release(); }

        const back = await getReceiptItemLines(receiptId);
        expect(back[0].storeProductId).toBeNull();      // demoted to OCR (no SP)
        expect(back[0].matchConfirmed).toBe(false);
        expect(back[0].itemConfidence?.vetoes?.some((v: any) => v.reason === 'userRejected')).toBe(true);
    });
});
