import pool from '../src/config/db.js';
import {
    upsertEquivalence,
    clearReverification,
    flagDivergentDifferentVotes,
} from '../src/models/userEquivalenceModel.js';
import { promoteMergeByProductIds, demoteMergeByProductIds } from '../src/services/storeProductMergeService.js';
import { resolveReceiptCategoriesLive } from '../src/services/receiptHydrationService.js';

/**
 * The re-verification loop ("decisions are not remanent"):
 *   TRIGGER A — a fresh S1 receipt match contradicting a personal 'different' on a
 *   same-Product pair flags that vote (flagDivergentDifferentVotes), AT MOST ONCE
 *   (reverifiedAt anti-nag stamp, written by clearReverification on re-vote).
 *   TRIGGER B — a global merge transition flags divergent votes in BOTH directions
 *   (join → flags 'different' voters, reversal → flags 'same' voters) and CLEARS the
 *   stamp: a global flip earns one fresh challenge even for a reconfirmed vote.
 *   DISPLAY — while flagged, the read overlay SUSPENDS the demotion: the line keeps
 *   its match and carries pendingReverification (the "reconfirm" chip); an unflagged
 *   'different' still demotes.
 */

const USER = 'reverify-test-user-0000000000000000';
const CAT_ID = 9971;          // own category so cleanup is deterministic
let productA: number;         // shared product for SP_A + SP_B (the same-Product pair)
let productC: number;         // separate product for SP_C (cross-Product control)
let SP_A: number, SP_B: number, SP_C: number;

const getRow = async (spX: number, spY: number) => {
    const [a, b] = spX < spY ? [spX, spY] : [spY, spX];
    const [rows]: any = await pool.query(
        'SELECT verdict, needsReverification, reverifiedAt FROM UserStoreProductEquivalence WHERE userId=? AND spIdA=? AND spIdB=?',
        [USER, a, b],
    );
    return rows[0] ?? null;
};

const CHAIN_X = 9971;
const CHAIN_Y = 9972;

beforeAll(async () => {
    for (const [id, name] of [[CHAIN_X, 'ReverifyChainX'], [CHAIN_Y, 'ReverifyChainY']] as const) {
        await pool.query('INSERT INTO StoreChain (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [id, name]);
    }
    await pool.query('INSERT INTO User (id, isAdmin, points) VALUES (?, 0, 0) ON DUPLICATE KEY UPDATE points = 0', [USER]);
    await pool.query('INSERT INTO Category (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [CAT_ID, 'ReverifyTest']);
    const mk = async (name: string): Promise<number> => {
        const [r]: any = await pool.query('INSERT INTO Product (categoryId, name) VALUES (?, ?)', [CAT_ID, name]);
        return r.insertId;
    };
    const mkSp = async (productId: number, chainId: number, name: string): Promise<number> => {
        const [r]: any = await pool.query(
            'INSERT INTO StoreProduct (productId, chainId, storeProductName) VALUES (?, ?, ?)',
            [productId, chainId, name],
        );
        return r.insertId;
    };
    productA = await mk('Reverify grietinė');
    productC = await mk('Reverify varškė');
    SP_A = await mkSp(productA, CHAIN_X, 'REVERIFY grietinė 30%');
    SP_B = await mkSp(productA, CHAIN_Y, 'Reverify grietinė, 30% rieb.');
    SP_C = await mkSp(productC, CHAIN_X, 'REVERIFY varškė 9%');
});

afterAll(async () => {
    await pool.query('DELETE FROM UserStoreProductEquivalence WHERE userId = ?', [USER]);
    await pool.query('DELETE FROM StoreProduct WHERE id IN (?, ?, ?)', [SP_A, SP_B, SP_C]);
    await pool.query('DELETE FROM Product WHERE id IN (?, ?)', [productA, productC]);
    await pool.query('DELETE FROM Category WHERE id = ?', [CAT_ID]);
    await pool.query('DELETE FROM StoreChain WHERE id IN (?, ?)', [CHAIN_X, CHAIN_Y]);
    await pool.query('DELETE FROM User WHERE id = ?', [USER]);
    await (pool as any).end();
});

beforeEach(async () => {
    await pool.query('DELETE FROM UserStoreProductEquivalence WHERE userId = ?', [USER]);
    await pool.query('UPDATE Product SET mergedIntoId = NULL WHERE id IN (?, ?)', [productA, productC]);
});

describe('TRIGGER A — flagDivergentDifferentVotes (receipt evidence)', () => {
    it("flags a same-Product 'different' vote touching a matched SP", async () => {
        await upsertEquivalence(USER, SP_A, SP_B, 'different');
        const flagged = await flagDivergentDifferentVotes(USER, [SP_B]);
        expect(flagged).toBe(1);
        expect((await getRow(SP_A, SP_B)).needsReverification).toBe(1);
    });

    it("skips 'same' verdicts and cross-Product 'different' votes", async () => {
        await upsertEquivalence(USER, SP_A, SP_B, 'same');
        await upsertEquivalence(USER, SP_A, SP_C, 'different'); // different Products → not a rejection
        expect(await flagDivergentDifferentVotes(USER, [SP_A, SP_B, SP_C])).toBe(0);
    });

    it('anti-nag: a re-verified vote is never flagged again by receipt evidence', async () => {
        await upsertEquivalence(USER, SP_A, SP_B, 'different');
        await flagDivergentDifferentVotes(USER, [SP_B]);
        // The user re-votes (re-confirms 'different') → flag cleared + stamp written.
        await clearReverification(USER, SP_A, SP_B);
        const row = await getRow(SP_A, SP_B);
        expect(row.needsReverification).toBe(0);
        expect(row.reverifiedAt).not.toBeNull();
        // The next receipt scan must NOT re-flag.
        expect(await flagDivergentDifferentVotes(USER, [SP_B])).toBe(0);
    });
});

describe('TRIGGER B — global merge transitions', () => {
    it("join direction: promote flags divergent 'different' voters and clears the stamp", async () => {
        // productA/productC start separate; the user's cross-pair vote is 'different'
        // AND already reverified (stamped) — the global join must re-open it anyway.
        await upsertEquivalence(USER, SP_A, SP_C, 'different');
        await clearReverification(USER, SP_A, SP_C); // stamps reverifiedAt
        const res = await promoteMergeByProductIds(productA, productC);
        expect(res.action).toBe('promoted');
        const row = await getRow(SP_A, SP_C);
        expect(row.needsReverification).toBe(1);
        expect(row.reverifiedAt).toBeNull();
    });

    it("split direction: demote flags divergent 'same' voters and clears the stamp", async () => {
        await promoteMergeByProductIds(productA, productC); // join first
        await upsertEquivalence(USER, SP_A, SP_C, 'same');
        await clearReverification(USER, SP_A, SP_C);
        const res = await demoteMergeByProductIds(productA, productC);
        expect(res.action).toBe('demoted');
        const row = await getRow(SP_A, SP_C);
        expect(row.needsReverification).toBe(1);
        expect(row.reverifiedAt).toBeNull();
    });
});

describe('DISPLAY — read-overlay suspension while pending', () => {
    const receiptFor = (spId: number) => ({
        userId: USER,
        parsedData: {
            products: [{
                name: 'REVERIFY GRIETINE',
                storeProductId: spId,
                matchedName: 'Reverify grietinė, 30% rieb.',
                storeProductImageUrl: 'https://img.example/x.webp',
                matchConfirmed: true,
                altMatches: [{ storeProductId: spId }],
            }],
        },
    });

    it("an unflagged 'different' demotes the line (rejection in force)", async () => {
        await upsertEquivalence(USER, SP_A, SP_B, 'different');
        const out: any = await resolveReceiptCategoriesLive(receiptFor(SP_B), 'lt');
        const p0 = out.parsedData.products[0];
        expect(p0.storeProductId).toBeNull();
        expect(p0.matchConfirmed).toBe(false);
        expect(p0.userRejectedMatch).toBe(true);
    });

    it('a FLAGGED vote suspends the demotion: match kept + pendingReverification chip', async () => {
        await upsertEquivalence(USER, SP_A, SP_B, 'different');
        await flagDivergentDifferentVotes(USER, [SP_B]);
        const out: any = await resolveReceiptCategoriesLive(receiptFor(SP_B), 'lt');
        const p0 = out.parsedData.products[0];
        expect(p0.storeProductId).toBe(SP_B);
        expect(p0.matchConfirmed).toBe(true);
        expect(p0.matchedName).toBe('Reverify grietinė, 30% rieb.');
        expect(p0.pendingReverification).toBe(true);
        expect(p0.userRejectedMatch).toBeUndefined();
    });

    it("re-confirming 'different' (flag cleared, stamp set) resumes the demotion permanently", async () => {
        await upsertEquivalence(USER, SP_A, SP_B, 'different');
        await flagDivergentDifferentVotes(USER, [SP_B]);
        await clearReverification(USER, SP_A, SP_B); // the re-swipe kept 'different'
        const out: any = await resolveReceiptCategoriesLive(receiptFor(SP_B), 'lt');
        const p0 = out.parsedData.products[0];
        expect(p0.storeProductId).toBeNull();
        expect(p0.userRejectedMatch).toBe(true);
    });

    it("flipping to 'same' removes both the rejection and the pending state", async () => {
        await upsertEquivalence(USER, SP_A, SP_B, 'different');
        await flagDivergentDifferentVotes(USER, [SP_B]);
        await upsertEquivalence(USER, SP_A, SP_B, 'same'); // the re-swipe flipped
        await clearReverification(USER, SP_A, SP_B);
        const out: any = await resolveReceiptCategoriesLive(receiptFor(SP_B), 'lt');
        const p0 = out.parsedData.products[0];
        expect(p0.storeProductId).toBe(SP_B);
        expect(p0.matchConfirmed).toBe(true);
        expect(p0.pendingReverification).toBeUndefined();
    });
});
