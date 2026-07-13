/**
 * CROSS-CHAIN RESCUE — end-to-end integration scenarios on the test DB.
 *
 * Covers the full production surface of the rescue feature with REAL rows:
 *   S1  twin dedupe (morkos-class): identical on a cross-chain proposal whose
 *       receipt-chain already holds a brand-suffixed NAME TWIN on an orphan
 *       island → the twin is REUSED (no duplicate SP), the user gets a personal
 *       equivalence edge, a global pair vote is recorded, no merge at 1 vote.
 *   S2  community absorb: three distinct users confirm the same pair → Wilson
 *       promote → the orphan island Product merges into the catalog Product.
 *   S3  no twin → provisional mint; visibility: excluded from match candidates
 *       and from other users' product-detail view (owner still sees it).
 *   S4  second-user convergence + clustered K=2 promotion (garbled print,
 *       agreeing prices) → provisional goes global.
 *   S5  conflict battery: same-user re-votes don't double-count; different
 *       candidates for one orphan stay separate; 'different' never mints;
 *       amount-incompatible twin is NOT reused; a vanished source SP fails soft.
 *   S6  Slot-2c seeding: a receipt line matched to an orphan puts that orphan's
 *       pair card FIRST in the backfill.
 *
 * IDs use the 981xx range; each run wipes its own rows (pattern from
 * personalLayer.test.ts).
 */
import { jest } from '@jest/globals';
import pool from '../src/config/db.js';
import { castReceiptLineVote } from '../src/services/receiptLineVoteService.js';
import { getMatchAggregate, orderPair } from '../src/models/storeProductMatchModel.js';
import { resolveEffectiveProductId } from '../src/services/storeProductMergeService.js';
import { getStoreProductsByChainWithProductData, getStoreProductsByProductId } from '../src/models/storeProductModel.js';
import { buildSlot2cBackfill } from '../src/services/slot2cBackfillService.js';

jest.setTimeout(30000);

const U1 = 'cctest-1111-1111-1111-111111111111';
const U2 = 'cctest-2222-2222-2222-222222222222';
const U3 = 'cctest-3333-3333-3333-333333333333';
const crowdUsers: string[] = [];

const CH_IKI = 98101;   // the receipt chain
const CH_MAX = 98102;   // the source (catalog) chain
const STORE_IKI = 98101;
const STORE_MAX = 98102;
const CAT = 98101;
const NEPRISKIRTA = 688;

// Catalog product at MAXIMA + its orphan brand-twin island at IKI (morkos-class)
const P_MORKOS = 98101;
const SP_MAX_MORKOS = 98101;      // MAXIMA "Plautos morkos" (catalog, categorised)
const P_ORPHAN = 98102;           // 688 island
const SP_IKI_CLEVER = 98102;      // IKI "Plautos morkos CLEVER" (brandName CLEVER)

// Twin-free product for the mint path
const P_KOKOS = 98103;
const SP_MAX_KOKOS = 98103;       // MAXIMA "Kokosų pienas KOKO" — no IKI twin

// Amount-incompatible twin fixture
const P_SULTYS = 98104;
const SP_MAX_SULTYS = 98104;      // MAXIMA "Apelsinų sultys" 1 l
const SP_IKI_SULTYS_HALF = 98105; // IKI "Apelsinų sultys" 0.5 l — NOT a twin (size differs)

// Second candidate for the split-vote conflict
const P_MORKOS2 = 98105;
const SP_MAX_MORKOS2 = 98106;     // MAXIMA "Šviežios morkos" (different product)

let nextReceiptId = 981001;
const seededReceipts: number[] = [];

async function seedReceipt(conn: any, userId: string, lines: {
    name: string; price: number; alt?: number; matchedSpId?: number | null; categoryId?: number | null;
}[]): Promise<number> {
    const id = nextReceiptId++;
    seededReceipts.push(id);
    await conn.query(
        `INSERT INTO Receipt (id, userId, storeId, filePath, parsedData)
         VALUES (?, ?, ?, '', ?)`,
        [id, userId, STORE_IKI, JSON.stringify({
            header: { chainId: CH_IKI },
            // relatedness scope reads matched-line categories from THIS blob
            products: lines.map(l => ({ name: l.name, categoryId: l.categoryId ?? null })),
        })],
    );
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await conn.query(
            `INSERT INTO ReceiptItem (receiptId, lineIdx, name, price, quantity, unit, altMatches, matchedSpId, categoryId)
             VALUES (?, ?, ?, ?, 1, 'vnt', ?, ?, ?)`,
            [id, i, l.name, l.price,
             l.alt ? JSON.stringify([{ storeProductId: l.alt, confidence: 0.7, name: 'alt' }])
                 // relatedness scope reads the MATCHED alt entry's categoryId
                 : (l.matchedSpId && l.categoryId
                     ? JSON.stringify([{ storeProductId: l.matchedSpId, confidence: 0.9, categoryId: l.categoryId }])
                     : null),
             l.matchedSpId ?? null, l.categoryId ?? null],
        );
    }
    return id;
}

async function wipeAll(conn: any) {
    await conn.query(`SET foreign_key_checks = 0`);
    const sps = [SP_MAX_MORKOS, SP_IKI_CLEVER, SP_MAX_KOKOS, SP_MAX_SULTYS, SP_IKI_SULTYS_HALF, SP_MAX_MORKOS2];
    const allUsers = [U1, U2, U3, ...crowdUsers];
    await conn.query(`DELETE FROM StoreProductMatchVote WHERE userId IN (?)`, [allUsers]);
    await conn.query(`DELETE FROM StoreProductMatch WHERE spIdA IN (?) OR spIdB IN (?)`, [sps, sps]);
    await conn.query(`DELETE FROM UserStoreProductEquivalence WHERE userId IN (?)`, [allUsers]);
    await conn.query(`DELETE v FROM StoreProductReceiptAliasVote v JOIN StoreProductReceiptAlias a ON a.id = v.aliasId WHERE a.chainId IN (?,?)`, [CH_IKI, CH_MAX]);
    await conn.query(`DELETE FROM StoreProductReceiptAlias WHERE chainId IN (?,?)`, [CH_IKI, CH_MAX]);
    if (seededReceipts.length) {
        await conn.query(`DELETE FROM Price WHERE receiptId IN (?)`, [seededReceipts]);
        await conn.query(`DELETE FROM ReceiptItem WHERE receiptId IN (?)`, [seededReceipts]);
        await conn.query(`DELETE FROM Receipt WHERE id IN (?)`, [seededReceipts]);
    }
    await conn.query(`DELETE FROM Price WHERE storeProductId IN (?)`, [sps]);
    // minted provisionals (auto-ids) — anything traced to our fixture sources
    await conn.query(`DELETE FROM Price WHERE storeProductId IN (SELECT id FROM StoreProduct WHERE mintedFromSpId IN (?))`, [sps]);
    await conn.query(`DELETE FROM StoreProduct WHERE mintedFromSpId IN (?)`, [sps]);
    await conn.query(`DELETE FROM StoreProduct WHERE id IN (?)`, [sps]);
    await conn.query(`UPDATE Product SET mergedIntoId = NULL WHERE id IN (?,?,?,?,?)`, [P_MORKOS, P_ORPHAN, P_KOKOS, P_SULTYS, P_MORKOS2]);
    await conn.query(`DELETE FROM Product WHERE id IN (?,?,?,?,?)`, [P_MORKOS, P_ORPHAN, P_KOKOS, P_SULTYS, P_MORKOS2]);
    await conn.query(`DELETE FROM Store WHERE id IN (?,?)`, [STORE_IKI, STORE_MAX]);
    await conn.query(`DELETE FROM StoreChain WHERE id IN (?,?)`, [CH_IKI, CH_MAX]);
    await conn.query(`DELETE FROM Category WHERE id = ?`, [CAT]);
    await conn.query(`DELETE FROM User WHERE id IN (?)`, [allUsers]);
    await conn.query(`SET foreign_key_checks = 1`);
}

beforeAll(async () => {
    const conn = await (pool as any).getConnection();
    try {
        await wipeAll(conn);
        await conn.query(`INSERT INTO StoreChain (id, name) VALUES (?, 'CC IKI'), (?, 'CC MAXIMA')`, [CH_IKI, CH_MAX]);
        await conn.query(`INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?), (?,?,?,?)`,
            [STORE_IKI, CH_IKI, 'CC IKI Store', 'x', STORE_MAX, CH_MAX, 'CC MAX Store', 'x']);
        await conn.query(`INSERT INTO Category (id, name) VALUES (?, 'CC Vegetables')`, [CAT]);
        await conn.query(`INSERT INTO Category (id, name, isHidden) VALUES (?, 'Nepriskirta', 1) ON DUPLICATE KEY UPDATE isHidden = 1`, [NEPRISKIRTA]);
        await conn.query(`INSERT INTO Product (id, categoryId, name) VALUES
            (?, ?, 'Plautos morkos'), (?, ?, 'Plautos morkos CLEVER'),
            (?, ?, 'Kokosų pienas KOKO'), (?, ?, 'Apelsinų sultys'), (?, ?, 'Šviežios morkos')`,
            [P_MORKOS, CAT, P_ORPHAN, NEPRISKIRTA, P_KOKOS, CAT, P_SULTYS, CAT, P_MORKOS2, CAT]);
        await conn.query(`INSERT INTO StoreProduct (id, productId, chainId, storeProductName, brandName, amount, unit, isWeighable) VALUES
            (?, ?, ?, 'Plautos morkos',        NULL,     1, 'kg', 1),
            (?, ?, ?, 'Plautos morkos CLEVER', 'CLEVER', 1, 'kg', 1),
            (?, ?, ?, 'Kokosų pienas KOKO',    'KOKO',   1, 'l',  0),
            (?, ?, ?, 'Apelsinų sultys',       NULL,     1, 'l',  0),
            (?, ?, ?, 'Apelsinų sultys',       NULL,   0.5, 'l',  0),
            (?, ?, ?, 'Šviežios morkos',       NULL,     1, 'kg', 1)`,
            [SP_MAX_MORKOS, P_MORKOS, CH_MAX,
             SP_IKI_CLEVER, P_ORPHAN, CH_IKI,
             SP_MAX_KOKOS, P_KOKOS, CH_MAX,
             SP_MAX_SULTYS, P_SULTYS, CH_MAX,
             SP_IKI_SULTYS_HALF, P_SULTYS, CH_IKI,
             SP_MAX_MORKOS2, P_MORKOS2, CH_MAX]);
        await conn.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0), (?,0,0), (?,0,0)`, [U1, U2, U3]);
        await conn.query(`INSERT INTO Price (storeProductId, storeId, price, date, isFallback) VALUES (?, ?, 0.75, NOW(), 1)`, [SP_MAX_MORKOS, STORE_MAX]);
    } finally {
        conn.release();
    }
});

afterAll(async () => {
    const conn = await (pool as any).getConnection();
    try { await wipeAll(conn); } finally { conn.release(); }
    await pool.end();
});

const spCountIn = async (chainId: number): Promise<number> => {
    const [r]: any = await pool.query(`SELECT COUNT(*) n FROM StoreProduct WHERE chainId = ?`, [chainId]);
    return Number(r[0].n);
};

describe('S1 — twin dedupe (morkos-class)', () => {
    it('identical on a cross-chain proposal reuses the brand-suffixed orphan twin, mints nothing', async () => {
        const rid = await seedReceipt(pool, U1, [{ name: 'PLAULS MORKOS', price: 0.89, alt: SP_MAX_MORKOS }]);
        const before = await spCountIn(CH_IKI);
        const line = await castReceiptLineVote(rid, 0, 'identical', pool, U1, SP_MAX_MORKOS);

        expect(await spCountIn(CH_IKI)).toBe(before);                     // no duplicate minted
        expect(Number(line.storeProductId)).toBe(SP_IKI_CLEVER);          // twin reused

        const [edges]: any = await pool.query(
            `SELECT verdict FROM UserStoreProductEquivalence WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [U1, Math.min(SP_IKI_CLEVER, SP_MAX_MORKOS), Math.max(SP_IKI_CLEVER, SP_MAX_MORKOS)]);
        expect(edges[0]?.verdict).toBe('same');                           // personal layer unified

        const { spIdA, spIdB } = orderPair(SP_IKI_CLEVER, SP_MAX_MORKOS);
        const agg = await getMatchAggregate(spIdA, spIdB, pool);
        expect(agg?.identicalVotes).toBe(1);                              // one global vote

        expect(await resolveEffectiveProductId(P_ORPHAN)).toBe(P_ORPHAN); // NOT merged at 1 vote

        const [aliases]: any = await pool.query(
            `SELECT normalizedAlias FROM StoreProductReceiptAlias WHERE storeProductId = ?`, [SP_IKI_CLEVER]);
        expect(aliases.length).toBe(1);                                   // OCR print learned on the twin
    });
});

describe('S2 — community absorb of the orphan island', () => {
    it('a few votes do NOT merge (Wilson gate); a unanimous crowd absorbs the island', async () => {
        const r2 = await seedReceipt(pool, U2, [{ name: 'PLAUTOS MORKOS', price: 0.85, alt: SP_MAX_MORKOS }]);
        await castReceiptLineVote(r2, 0, 'identical', pool, U2, SP_MAX_MORKOS);
        const r3 = await seedReceipt(pool, U3, [{ name: 'PLAUT0S MORKOS', price: 0.90, alt: SP_MAX_MORKOS }]);
        await castReceiptLineVote(r3, 0, 'identical', pool, U3, SP_MAX_MORKOS);
        // 3 unanimous votes: minVotes met but Wilson lower ≈ 0.44 < 0.80 → NOT merged.
        // (This documents the tuned community gate — one enthusiastic trio can't rewrite
        // the catalog.)
        expect(await resolveEffectiveProductId(P_ORPHAN)).toBe(P_ORPHAN);

        // A unanimous crowd (16 total) clears the Wilson gate → island absorbed.
        for (let i = 4; i <= 16; i++) {
            const uid = `cctest-crwd-${String(i).padStart(4, '0')}-1111-111111111111`;
            crowdUsers.push(uid);
            await pool.query(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0`, [uid]);
            const rid = await seedReceipt(pool, uid, [{ name: 'PLAUTOS MORKOS', price: 0.85, alt: SP_MAX_MORKOS }]);
            await castReceiptLineVote(rid, 0, 'identical', pool, uid, SP_MAX_MORKOS);
        }
        expect(await resolveEffectiveProductId(P_ORPHAN)).toBe(P_MORKOS);
    });
});

describe('S3 — no twin → provisional mint + visibility quarantine', () => {
    let mintedId = 0;

    it('mints a provisional SP owned by the voter', async () => {
        const rid = await seedReceipt(pool, U1, [{ name: 'KOKOSU PIENAS', price: 2.49, alt: SP_MAX_KOKOS }]);
        const line = await castReceiptLineVote(rid, 0, 'identical', pool, U1, SP_MAX_KOKOS);
        mintedId = Number(line.storeProductId);
        const [rows]: any = await pool.query(`SELECT * FROM StoreProduct WHERE id = ?`, [mintedId]);
        expect(rows[0].chainId).toBe(CH_IKI);
        expect(rows[0].provisional).toBe(1);
        expect(rows[0].provisionalOwnerUserId).toBe(U1);
        expect(rows[0].mintedFromSpId).toBe(SP_MAX_KOKOS);
        expect(rows[0].storeProductName).toBe('Kokosų pienas KOKO');       // identity copied
    });

    it('the provisional SP is invisible to match candidates and to other users', async () => {
        const candidates = await getStoreProductsByChainWithProductData(CH_IKI);
        expect(candidates.some((c: any) => Number(c.id) === mintedId)).toBe(false);

        const anon = await getStoreProductsByProductId(P_KOKOS);
        expect(anon.some((r: any) => Number(r.id) === mintedId)).toBe(false);
        const owner = await getStoreProductsByProductId(P_KOKOS, U1);
        expect(owner.some((r: any) => Number(r.id) === mintedId)).toBe(true);
    });

    it('S4 — a second user CONVERGES on the same provisional and promotes it (prints agree, prices agree)', async () => {
        const rid = await seedReceipt(pool, U2, [{ name: 'K0KOSU PIENAS', price: 2.59, alt: SP_MAX_KOKOS }]);
        const before = await spCountIn(CH_IKI);
        const line = await castReceiptLineVote(rid, 0, 'identical', pool, U2, SP_MAX_KOKOS);

        expect(Number(line.storeProductId)).toBe(mintedId);               // converged, no second mint
        expect(await spCountIn(CH_IKI)).toBe(before);

        const [rows]: any = await pool.query(`SELECT provisional, provisionalOwnerUserId FROM StoreProduct WHERE id = ?`, [mintedId]);
        expect(rows[0].provisional).toBe(0);                              // clustered K=2 promotion
        expect(rows[0].provisionalOwnerUserId).toBeNull();
    });
});

describe('S5 — conflict battery', () => {
    it('a same-user re-vote never double-counts the global aggregate', async () => {
        const rid = await seedReceipt(pool, U1, [{ name: 'PLAULS MORKOS', price: 0.89, alt: SP_MAX_MORKOS }]);
        await castReceiptLineVote(rid, 0, 'identical', pool, U1, SP_MAX_MORKOS);
        const { spIdA, spIdB } = orderPair(SP_IKI_CLEVER, SP_MAX_MORKOS);
        const agg = await getMatchAggregate(spIdA, spIdB, pool);
        expect(agg?.identicalVotes).toBe(16);                             // unchanged from S2's crowd total
    });

    it("'different' on a cross-chain proposal never mints and leaves the line unlinked", async () => {
        const rid = await seedReceipt(pool, U3, [{ name: 'SULTYS APELSINU', price: 1.99, alt: SP_MAX_SULTYS }]);
        const before = await spCountIn(CH_IKI);
        const line = await castReceiptLineVote(rid, 0, 'different', pool, U3, SP_MAX_SULTYS);
        expect(await spCountIn(CH_IKI)).toBe(before);
        expect(line?.storeProductId ?? null).toBeNull();
    });

    it('an amount-incompatible same-chain name twin is NOT reused — provisional mint instead', async () => {
        // IKI has "Apelsinų sultys" 0.5 l; the source is the 1 l MAXIMA pack.
        const rid = await seedReceipt(pool, U1, [{ name: 'APELSINU SULTYS', price: 1.89, alt: SP_MAX_SULTYS }]);
        const line = await castReceiptLineVote(rid, 0, 'identical', pool, U1, SP_MAX_SULTYS);
        const mintedId = Number(line.storeProductId);
        expect(mintedId).not.toBe(SP_IKI_SULTYS_HALF);
        const [rows]: any = await pool.query(`SELECT provisional, amount FROM StoreProduct WHERE id = ?`, [mintedId]);
        expect(rows[0].provisional).toBe(1);
        expect(Number(rows[0].amount)).toBe(1);                           // the source's size, not 0.5
    });

    it('votes on two DIFFERENT candidates for one line stay separate pairs — nothing merges', async () => {
        const rid = await seedReceipt(pool, U2, [{ name: 'MORKOS', price: 0.79, alt: SP_MAX_MORKOS2 }]);
        await castReceiptLineVote(rid, 0, 'identical', pool, U2, SP_MAX_MORKOS2);
        // The second candidate's pair has its own aggregate with 1 vote; no merge.
        expect(await resolveEffectiveProductId(P_MORKOS2)).toBe(P_MORKOS2);
    });

    it('a vanished source SP fails soft — proposal rejected, no crash, line unlinked', async () => {
        const GHOST = 98999;
        const rid = await seedReceipt(pool, U1, [{ name: 'VAIDUOKLIS', price: 1.00, alt: GHOST }]);
        const line = await castReceiptLineVote(rid, 0, 'identical', pool, U1, GHOST);
        expect(line?.storeProductId ?? null).toBeNull();
    });
});

describe('S6 — Slot-2c seeds the receipt-matched orphan first', () => {
    it('a line matched to an orphan SP surfaces that orphan card ahead of the pool', async () => {
        // Fresh orphan island (S2 absorbed the morkos one — reuse the sultys-half SP by
        // parking it on a NEW 688 island for this test).
        const P_ISLAND = 98106;
        await pool.query(`INSERT INTO Product (id, categoryId, name) VALUES (?, ?, 'Apelsinų sultys ISLAND')`, [P_ISLAND, NEPRISKIRTA]);
        await pool.query(`UPDATE StoreProduct SET productId = ?, amount = 1 WHERE id = ?`, [P_ISLAND, SP_IKI_SULTYS_HALF]);
        try {
            const rid = await seedReceipt(pool, U3, [
                { name: 'APELSINU SULTYS', price: 1.99, matchedSpId: SP_IKI_SULTYS_HALF },
                { name: 'PLAUTOS MORKOS', price: 0.89, matchedSpId: SP_MAX_MORKOS, categoryId: CAT },
            ]);
            const items = await buildSlot2cBackfill(U3, rid, 3);
            expect(items.length).toBeGreaterThan(0);
            expect(items[0].orphanSpId).toBe(SP_IKI_SULTYS_HALF);          // the seed jumps the queue
            expect(items[0].candidateSpId).toBe(SP_MAX_SULTYS);            // its name twin as candidate
        } finally {
            await pool.query(`UPDATE StoreProduct SET productId = ?, amount = 0.5 WHERE id = ?`, [P_SULTYS, SP_IKI_SULTYS_HALF]);
            await pool.query(`DELETE FROM Product WHERE id = ?`, [P_ISLAND]);
        }
    });
});
