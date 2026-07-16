import pool from '../src/config/db.js';
import { logInteraction, collectReceiptBuySpIds } from '../src/models/productInteractionModel.js';

/**
 * Souply 2.0 receipt_buy: the strongest ranking signal (weight 5 > list_check 3).
 * Pure collector rules + the weighted score actually landing in UserProductScore.
 */

const USER = 'rcptbuy-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CAT_ID = 9964;
let productId: number;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO Category (id, name, parentCategoryId) VALUES (?,?,NULL) ON DUPLICATE KEY UPDATE name=VALUES(name)', [CAT_ID, 'RcptBuy Cat']);
    const p: any = await q('INSERT INTO Product (categoryId, name) VALUES (?,?)', [CAT_ID, 'RcptBuy pienas']);
    productId = p.insertId;
});

afterAll(async () => {
    await q('DELETE FROM ProductInteraction WHERE userId = ?', [USER]);
    await q('DELETE FROM UserProductScore WHERE userId = ?', [USER]);
    await q('DELETE FROM Product WHERE id = ?', [productId]);
    await q('DELETE FROM Category WHERE id = ?', [CAT_ID]);
    await (pool as any).end();
});

describe('collectReceiptBuySpIds (pure)', () => {
    const line = (spId: any, band: string | null) => ({
        storeProductId: spId,
        itemConfidence: band ? { band } : undefined,
    });

    it('collects S1/S2 linked lines only', () => {
        expect(collectReceiptBuySpIds([
            line(11, 'S1'),
            line(12, 'S2'),
            line(13, 'S3'),      // garbage band — never scores
            line(null, 'S1'),    // no SP linked
            line(0, 'S1'),       // sentinel id
            { name: 'raw' },     // unresolved line shape
        ])).toEqual([11, 12]);
    });

    it('fires once per LINE — duplicate products on separate lines both count', () => {
        expect(collectReceiptBuySpIds([line(11, 'S1'), line(11, 'S1')])).toEqual([11, 11]);
    });

    it('tolerates junk input', () => {
        expect(collectReceiptBuySpIds(null as any)).toEqual([]);
        expect(collectReceiptBuySpIds([])).toEqual([]);
    });
});

describe('receipt_buy weight', () => {
    it('scores 5 (above list_check 3) with fresh decay', async () => {
        await logInteraction(USER, productId, 'receipt_buy');
        // logInteraction recalcs async-fire-and-forget internally? It awaits the
        // insert then fires recalc without await — give it a beat.
        await new Promise((r) => setTimeout(r, 300));
        const [rows]: any = await pool.query(
            'SELECT score, interactionCount FROM UserProductScore WHERE userId = ? AND productId = ?',
            [USER, productId]);
        expect(rows.length).toBe(1);
        // Fresh event → decay ≈ 1 → score ≈ 5 (allow small decay drift).
        expect(Number(rows[0].score)).toBeGreaterThan(4.5);
        expect(Number(rows[0].interactionCount)).toBe(1);
    });
});
