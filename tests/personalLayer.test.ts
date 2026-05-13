/**
 * Integration tests for the personal swipe layer.
 *
 * Covers:
 *  - userEquivalenceModel: union-find normalization, getUserProductMergeMap,
 *    getPersonalComponentForProduct, getReverificationPairKeysForReceipt,
 *    clearReverification
 *  - storeProductMergeService: promoteMergeByProductIds, demoteMergeByProductIds,
 *    needsReverification flag propagation on demote
 *  - swipeVoteService: burst path skips personal layer, self-pair 'different'
 *    flags AdminReviewFlag, re-verification flag cleared on re-vote
 *
 * All tests use high IDs (97xxx range) to avoid colliding with real data.
 * Each describe block inserts its own seed data and wipes it in afterAll.
 */
import { jest } from '@jest/globals';
import pool from '../src/config/db.js';
import {
    upsertEquivalence,
    getUserProductMergeMap,
    getPersonalComponentForProduct,
    getReverificationPairKeysForReceipt,
    clearReverification,
} from '../src/models/userEquivalenceModel.js';
import {
    promoteMergeByProductIds,
    demoteMergeByProductIds,
} from '../src/services/storeProductMergeService.js';
import { castSwipeVote } from '../src/services/swipeVoteService.js';

jest.setTimeout(20000);

// ---------------------------------------------------------------------------
// Shared seed IDs
// ---------------------------------------------------------------------------

const U1 = 'pltest-1111-1111-1111-111111111111';
const U2 = 'pltest-2222-2222-2222-222222222222';

const CHAIN_ID = 97001;
const CAT_ID   = 97001;
const STORE_ID = 97001;

// Products and SPs for equivalence / merge tests
const PROD_A = 97001; // name: "A"  (shortest)
const PROD_B = 97002; // name: "BB"
const PROD_C = 97003; // name: "CCC"
const SP_A   = 97001; // in CHAIN_ID, belongs to PROD_A
const SP_B   = 97002; // in CHAIN_ID, belongs to PROD_B
const SP_C   = 97003; // in CHAIN_ID, belongs to PROD_C

// Extra products/SPs for the self-pair and re-verification tests
const PROD_D = 97004;
const SP_D   = 97004;

// ---------------------------------------------------------------------------
// Global seed / teardown
// ---------------------------------------------------------------------------

async function wipeAll(conn: any) {
    await conn.query(`SET foreign_key_checks = 0`);
    await conn.query(`DELETE FROM AdminReviewFlag WHERE spId IN (?,?,?,?)`, [SP_A, SP_B, SP_C, SP_D]);
    await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId IN (?,?)`, [U1, U2]);
    await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId IN (?,?)`, [U1, U2]);
    await conn.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [U1, U2]);
    await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [U1, U2]);
    await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [U1, U2]);
    await conn.query(`DELETE FROM Basket WHERE userId IN (?,?)`, [U1, U2]);
    await conn.query(`DELETE FROM Receipt WHERE userId IN (?,?)`, [U1, U2]);
    await conn.query(`DELETE FROM User WHERE id IN (?,?)`, [U1, U2]);
    await conn.query(`DELETE FROM StoreProduct WHERE id IN (?,?,?,?)`, [SP_A, SP_B, SP_C, SP_D]);
    await conn.query(`UPDATE Product SET mergedIntoId = NULL WHERE id IN (?,?,?,?)`, [PROD_A, PROD_B, PROD_C, PROD_D]);
    await conn.query(`DELETE FROM Product WHERE id IN (?,?,?,?)`, [PROD_A, PROD_B, PROD_C, PROD_D]);
    await conn.query(`DELETE FROM Store WHERE id = ?`, [STORE_ID]);
    await conn.query(`DELETE FROM StoreChain WHERE id = ?`, [CHAIN_ID]);
    await conn.query(`DELETE FROM Category WHERE id = ?`, [CAT_ID]);
    await conn.query(`SET foreign_key_checks = 1`);
}

beforeAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await wipeAll(conn);
        await conn.query(`INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id`, [CHAIN_ID, 'PL Test Chain']);
        // Store.address is NOT NULL in the schema.
        await conn.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [STORE_ID, CHAIN_ID, 'PL Test Store', 'Test St. 1']);
        await conn.query(`INSERT INTO Category (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id`, [CAT_ID, 'PL Test Cat']);
        // PROD_A has the shortest name "A" — it should always be elected root
        await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`, [PROD_A, CAT_ID, 'A']);
        await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`, [PROD_B, CAT_ID, 'BB']);
        await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`, [PROD_C, CAT_ID, 'CCC']);
        await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id`, [PROD_D, CAT_ID, 'DDDD']);
        await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [SP_A, PROD_A, CHAIN_ID, 'SP A']);
        await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [SP_B, PROD_B, CHAIN_ID, 'SP B']);
        await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [SP_C, PROD_C, CHAIN_ID, 'SP C']);
        await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [SP_D, PROD_D, CHAIN_ID, 'SP D']);
        await conn.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0`, [U1]);
        await conn.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0`, [U2]);
    } finally {
        conn.release();
    }
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await wipeAll(conn);
    } finally {
        conn.release();
    }
    await pool.end();
});

// Clean up equivalence rows between tests so each describe starts fresh.
afterEach(async () => {
    await pool.query(`DELETE FROM UserStoreProductEquivalence WHERE userId IN (?,?)`, [U1, U2]);
    await pool.query(`DELETE FROM StoreProductMatchVote WHERE userId IN (?,?)`, [U1, U2]);
    await pool.query(`DELETE FROM AdminReviewFlag WHERE spId IN (?,?,?,?)`, [SP_A, SP_B, SP_C, SP_D]);
    await pool.query(`UPDATE Product SET mergedIntoId = NULL WHERE id IN (?,?,?,?)`, [PROD_A, PROD_B, PROD_C, PROD_D]);
    await pool.query(`UPDATE StoreProductMatchVote SET dwellMs = NULL WHERE userId IN (?,?)`, [U1, U2]);
    // Also wipe receipts in case a test created them
    await pool.query(`DELETE FROM Price WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [U1, U2]);
    await pool.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [U1, U2]);
    await pool.query(`DELETE FROM ReceiptLineIssue WHERE receiptId IN (SELECT id FROM Receipt WHERE userId IN (?,?))`, [U1, U2]);
    await pool.query(`DELETE FROM Basket WHERE userId IN (?,?)`, [U1, U2]);
    await pool.query(`DELETE FROM Receipt WHERE userId IN (?,?)`, [U1, U2]);
});

// ===========================================================================
// 1. upsertEquivalence — basic 'different' verdict
// ===========================================================================

describe('upsertEquivalence — different verdict', () => {
    it('stores a different entry with canonical ordering', async () => {
        await upsertEquivalence(U1, SP_B, SP_A, 'different'); // intentionally reversed order

        const [rows]: any = await pool.query(
            `SELECT verdict FROM UserStoreProductEquivalence WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, Math.min(SP_A, SP_B), Math.max(SP_A, SP_B)],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].verdict).toBe('different');
    });

    it('idempotent — calling twice does not create a duplicate', async () => {
        await upsertEquivalence(U1, SP_A, SP_B, 'different');
        await upsertEquivalence(U1, SP_A, SP_B, 'different');

        const [rows]: any = await pool.query(
            `SELECT id FROM UserStoreProductEquivalence WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, Math.min(SP_A, SP_B), Math.max(SP_A, SP_B)],
        );
        expect(rows).toHaveLength(1);
    });
});

// ===========================================================================
// 2. upsertEquivalence — 'same' union-find: two-product merge
// ===========================================================================

describe('upsertEquivalence — same verdict, two products', () => {
    it('inserts a single entry pointing to the shorter-named root (PROD_A)', async () => {
        // SP_A → PROD_A (name="A"), SP_B → PROD_B (name="BB")
        // Root should be PROD_A because "A".length < "BB".length
        await upsertEquivalence(U1, SP_A, SP_B, 'same');

        const [rows]: any = await pool.query(
            `SELECT spIdA, spIdB, verdict FROM UserStoreProductEquivalence WHERE userId = ?`,
            [U1],
        );
        // Exactly one entry: the loser member → root
        expect(rows).toHaveLength(1);
        // The root SP is SP_A; the loser SP is SP_B.
        // Canonical order: smaller id first.
        const a = Math.min(SP_A, SP_B);
        const b = Math.max(SP_A, SP_B);
        expect(rows[0].spIdA).toBe(a);
        expect(rows[0].spIdB).toBe(b);
        expect(rows[0].verdict).toBe('same');
    });

    it('getUserProductMergeMap hides PROD_B, keeps PROD_A', async () => {
        await upsertEquivalence(U1, SP_A, SP_B, 'same');

        const map = await getUserProductMergeMap(U1, [PROD_A, PROD_B]);
        expect(map.get(PROD_B)).toBe(PROD_A);
        expect(map.has(PROD_A)).toBe(false);
    });
});

// ===========================================================================
// 3. upsertEquivalence — transitivity: A=B, B=C → A=B=C under shortest root
// ===========================================================================

describe('upsertEquivalence — transitivity (A=B then B=C)', () => {
    it('normalises all three to point at PROD_A (shortest name)', async () => {
        // Step 1: mark A ≡ B
        await upsertEquivalence(U1, SP_A, SP_B, 'same');
        // Step 2: mark B ≡ C — union-find should pull C into A's component
        await upsertEquivalence(U1, SP_B, SP_C, 'same');

        const [rows]: any = await pool.query(
            `SELECT spIdA, spIdB FROM UserStoreProductEquivalence
              WHERE userId = ? AND verdict = 'same'
              ORDER BY spIdA`,
            [U1],
        );
        // Two entries: (SP_A,SP_B) and (SP_A,SP_C) — both point to root SP_A
        expect(rows).toHaveLength(2);

        // Every entry must involve SP_A (the root)
        const involvesSPA = rows.every((r: any) => r.spIdA === SP_A || r.spIdB === SP_A);
        expect(involvesSPA).toBe(true);
    });

    it('getPersonalComponentForProduct returns all three product IDs', async () => {
        await upsertEquivalence(U1, SP_A, SP_B, 'same');
        await upsertEquivalence(U1, SP_B, SP_C, 'same');

        const component = await getPersonalComponentForProduct(U1, PROD_C);
        expect(new Set(component)).toEqual(new Set([PROD_A, PROD_B, PROD_C]));
    });

    it('getUserProductMergeMap hides B and C, keeps A', async () => {
        await upsertEquivalence(U1, SP_A, SP_B, 'same');
        await upsertEquivalence(U1, SP_B, SP_C, 'same');

        const map = await getUserProductMergeMap(U1, [PROD_A, PROD_B, PROD_C]);
        expect(map.get(PROD_B)).toBe(PROD_A);
        expect(map.get(PROD_C)).toBe(PROD_A);
        expect(map.has(PROD_A)).toBe(false);
    });
});

// ===========================================================================
// 4. getPersonalComponentForProduct — product with no equivalences
// ===========================================================================

describe('getPersonalComponentForProduct — isolated product', () => {
    it('returns just the product itself when no equivalences exist', async () => {
        const component = await getPersonalComponentForProduct(U1, PROD_B);
        expect(component).toEqual([PROD_B]);
    });
});

// ===========================================================================
// 5. getReverificationPairKeysForReceipt + clearReverification
// ===========================================================================

describe('reverification flag lifecycle', () => {
    it('returns empty set when no equivalences are flagged', async () => {
        const s = await getReverificationPairKeysForReceipt(U1, [SP_A, SP_B]);
        expect(s.size).toBe(0);
    });

    it('returns the pair key after setting needsReverification = 1', async () => {
        const a = Math.min(SP_A, SP_B);
        const b = Math.max(SP_A, SP_B);
        await pool.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict, needsReverification)
             VALUES (?, ?, ?, 'same', 1)`,
            [U1, a, b],
        );

        const s = await getReverificationPairKeysForReceipt(U1, [SP_A, SP_B]);
        expect(s.has(`${a}-${b}`)).toBe(true);
    });

    it('clearReverification removes the flag', async () => {
        const a = Math.min(SP_A, SP_B);
        const b = Math.max(SP_A, SP_B);
        await pool.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict, needsReverification)
             VALUES (?, ?, ?, 'same', 1)`,
            [U1, a, b],
        );

        await clearReverification(U1, SP_A, SP_B);

        const [rows]: any = await pool.query(
            `SELECT needsReverification FROM UserStoreProductEquivalence
              WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, a, b],
        );
        expect(rows[0].needsReverification).toBe(0);
    });

    it('getReverificationPairKeysForReceipt ignores SPs not in the receipt', async () => {
        const a = Math.min(SP_A, SP_B);
        const b = Math.max(SP_A, SP_B);
        await pool.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict, needsReverification)
             VALUES (?, ?, ?, 'same', 1)`,
            [U1, a, b],
        );
        // Only pass SP_C — the (SP_A,SP_B) pair is not in scope
        const s = await getReverificationPairKeysForReceipt(U1, [SP_C]);
        expect(s.size).toBe(0);
    });
});

// ===========================================================================
// 6. storeProductMergeService — promoteMergeByProductIds
// ===========================================================================

describe('promoteMergeByProductIds', () => {
    it('sets mergedIntoId on the longer-named product (loser = PROD_B)', async () => {
        const result = await promoteMergeByProductIds(PROD_A, PROD_B);
        expect(result.action).toBe('promoted');
        expect(result.winnerProductId).toBe(PROD_A);
        expect(result.loserProductId).toBe(PROD_B);

        const [rows]: any = await pool.query(
            `SELECT mergedIntoId FROM Product WHERE id = ?`, [PROD_B],
        );
        expect(rows[0].mergedIntoId).toBe(PROD_A);
    });

    it('is idempotent — already merged in same direction returns noop', async () => {
        await promoteMergeByProductIds(PROD_A, PROD_B);
        const result2 = await promoteMergeByProductIds(PROD_A, PROD_B);
        expect(result2.action).toBe('noop');
    });

    it('returns noop for same product', async () => {
        const result = await promoteMergeByProductIds(PROD_A, PROD_A);
        expect(result.action).toBe('noop');
    });
});

// ===========================================================================
// 7. storeProductMergeService — demoteMergeByProductIds + needsReverification
// ===========================================================================

describe('demoteMergeByProductIds', () => {
    beforeEach(async () => {
        // Promote first so there is something to demote
        await promoteMergeByProductIds(PROD_A, PROD_B);
    });

    it('clears mergedIntoId on demotion', async () => {
        const result = await demoteMergeByProductIds(PROD_A, PROD_B);
        expect(result.action).toBe('demoted');

        const [rows]: any = await pool.query(
            `SELECT mergedIntoId FROM Product WHERE id = ?`, [PROD_B],
        );
        expect(rows[0].mergedIntoId).toBeNull();
    });

    it('sets needsReverification on user equivalences for the demoted pair', async () => {
        // Insert a personal equivalence for the pair being demoted
        const a = Math.min(SP_A, SP_B);
        const b = Math.max(SP_A, SP_B);
        await pool.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict, needsReverification)
             VALUES (?, ?, ?, 'same', 0)`,
            [U1, a, b],
        );

        await demoteMergeByProductIds(PROD_A, PROD_B);

        const [rows]: any = await pool.query(
            `SELECT needsReverification FROM UserStoreProductEquivalence
              WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, a, b],
        );
        expect(rows[0].needsReverification).toBe(1);
    });

    it('does not affect equivalences for unrelated pairs', async () => {
        const aC = Math.min(SP_A, SP_C);
        const bC = Math.max(SP_A, SP_C);
        await pool.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict, needsReverification)
             VALUES (?, ?, ?, 'same', 0)`,
            [U1, aC, bC],
        );

        await demoteMergeByProductIds(PROD_A, PROD_B); // demotes A↔B, not A↔C

        const [rows]: any = await pool.query(
            `SELECT needsReverification FROM UserStoreProductEquivalence
              WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, aC, bC],
        );
        expect(rows[0].needsReverification).toBe(0);
    });
});

// ===========================================================================
// 8. castSwipeVote — burst path skips personal layer
// ===========================================================================

describe('castSwipeVote — burst swipe skips personal equivalence', () => {
    let receiptId: number;

    beforeEach(async () => {
        // Create a minimal receipt so castSwipeVote can read parsedData
        const [result]: any = await pool.query(
            `INSERT INTO Receipt (userId, filePath, fileType, parsedData)
             VALUES (?, 'pl-test.jpg', 'image/jpeg', ?)`,
            [U1, JSON.stringify({
                header: { storeId: STORE_ID, chainId: CHAIN_ID },
                footer: { receiptNo: 'PL-BURST', date: '2025-01-01' },
                products: [{
                    name: 'SP A product',
                    storeProductId: SP_A,
                    matchConfirmed: true,
                    priceVerified: false,
                    price: 1.99,
                    promoPrice: null,
                    quantity: 1,
                    unit: 'vnt',
                    altMatches: [],
                }],
            })],
        );
        receiptId = result.insertId;
    });

    it('does not write a UserStoreProductEquivalence row on a burst vote', async () => {
        // dwellMs below burst threshold (isBurstSwipe checks < 500ms typically)
        const result = await castSwipeVote({
            userId: U1,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: SP_B,
            vote: 'identical',
            dwellMs: 50, // burst
        });

        // Vote may be dropped-burst or processed — either way, no equivalence row
        const [rows]: any = await pool.query(
            `SELECT id FROM UserStoreProductEquivalence WHERE userId = ?`, [U1],
        );
        expect(rows).toHaveLength(0);
    });
});

// ===========================================================================
// 9. castSwipeVote — self-pair 'different' inserts AdminReviewFlag
// ===========================================================================

describe('castSwipeVote — self-pair different flags for admin review', () => {
    let receiptId: number;

    beforeEach(async () => {
        const [result]: any = await pool.query(
            `INSERT INTO Receipt (userId, filePath, fileType, parsedData)
             VALUES (?, 'pl-selfpair.jpg', 'image/jpeg', ?)`,
            [U1, JSON.stringify({
                header: { storeId: STORE_ID, chainId: CHAIN_ID },
                footer: { receiptNo: 'PL-SELF', date: '2025-01-01' },
                products: [{
                    name: 'SP A product',
                    storeProductId: SP_A,
                    matchConfirmed: true,
                    priceVerified: false,
                    price: 1.99,
                    promoPrice: null,
                    quantity: 1,
                    unit: 'vnt',
                    altMatches: [],
                }],
            })],
        );
        receiptId = result.insertId;
    });

    it("inserts an AdminReviewFlag row when the user swipes 'different' on a self-pair", async () => {
        const res = await castSwipeVote({
            userId: U1,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: SP_A, // self-pair
            vote: 'different',
            dwellMs: 2000,
        });

        expect(res.ok).toBe(true);
        expect(res.effect).toBe('vote-recorded');

        const [rows]: any = await pool.query(
            `SELECT type, spId, flaggedBy FROM AdminReviewFlag
              WHERE spId = ? AND flaggedBy = ?`,
            [SP_A, U1],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('self-pair-rejected');
    });

    it("does NOT insert an AdminReviewFlag when the user swipes 'identical' on a self-pair", async () => {
        await castSwipeVote({
            userId: U1,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: SP_A,
            vote: 'identical',
            dwellMs: 2000,
        });

        const [rows]: any = await pool.query(
            `SELECT id FROM AdminReviewFlag WHERE spId = ? AND flaggedBy = ?`,
            [SP_A, U1],
        );
        expect(rows).toHaveLength(0);
    });
});

// ===========================================================================
// 10. castSwipeVote — non-burst vote writes personal equivalence and
//     clears any existing needsReverification flag for the pair
// ===========================================================================

describe('castSwipeVote — non-burst cross-pair vote', () => {
    let receiptId: number;

    beforeEach(async () => {
        const [result]: any = await pool.query(
            `INSERT INTO Receipt (userId, filePath, fileType, parsedData)
             VALUES (?, 'pl-cross.jpg', 'image/jpeg', ?)`,
            [U1, JSON.stringify({
                header: { storeId: STORE_ID, chainId: CHAIN_ID },
                footer: { receiptNo: 'PL-CROSS', date: '2025-01-01' },
                products: [{
                    name: 'SP A product',
                    storeProductId: SP_A,
                    matchConfirmed: true,
                    priceVerified: false,
                    price: 1.99,
                    promoPrice: null,
                    quantity: 1,
                    unit: 'vnt',
                    altMatches: [],
                }],
            })],
        );
        receiptId = result.insertId;
    });

    it("writes a 'same' equivalence for an 'identical' vote", async () => {
        const res = await castSwipeVote({
            userId: U1,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: SP_B,
            vote: 'identical',
            dwellMs: 2000,
        });

        expect(res.ok).toBe(true);

        const [rows]: any = await pool.query(
            `SELECT verdict FROM UserStoreProductEquivalence
              WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, Math.min(SP_A, SP_B), Math.max(SP_A, SP_B)],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].verdict).toBe('same');
    });

    it('clears needsReverification flag on re-vote', async () => {
        const a = Math.min(SP_A, SP_B);
        const b = Math.max(SP_A, SP_B);
        // Manually set the flag to simulate a prior demotion
        await pool.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict, needsReverification)
             VALUES (?, ?, ?, 'same', 1)
             ON DUPLICATE KEY UPDATE needsReverification = 1`,
            [U1, a, b],
        );

        await castSwipeVote({
            userId: U1,
            receiptId,
            receiptLineIdx: 0,
            candidateStoreProductId: SP_B,
            vote: 'identical',
            dwellMs: 2000,
        });

        const [rows]: any = await pool.query(
            `SELECT needsReverification FROM UserStoreProductEquivalence
              WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, a, b],
        );
        expect(rows[0].needsReverification).toBe(0);
    });
});
