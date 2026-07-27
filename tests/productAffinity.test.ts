import pool from '../src/config/db.js';
import {
    FULL_CONFIDENCE_INTERACTIONS, getProductAffinity, rankAffinity, refreshUserProductScores,
} from '../src/services/productAffinityService.js';
import { parseIngredientLine } from '../src/services/recipes/ingredientParser.js';
import { matchIngredient } from '../src/services/recipes/recipeMatcher.js';

/**
 * PRODUCT AFFINITY — "how much does this shopper want this product".
 *
 * The rules that matter here are not arithmetic; they are about what affinity is
 * ALLOWED to decide. It ranks products that are all genuinely the ingredient. It
 * must never make something the ingredient — a shopper who once bought a seed
 * packet must not be sold seed packets forever.
 */

const CAT = 990330;
const SEED_CAT = 656;
const CHAIN = 990331;
const STORE = 990332;
const USER = 'affinity-aaaa-bbbb-cccc-dddddddddddd';
const OTHER = 'affinity-eeee-ffff-0000-111111111111';

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];
const ids: Record<string, number> = {};

const addProduct = async (name: string, opts: { categoryId?: number; globalScore?: number } = {}) => {
    const p = await q(`INSERT INTO Product (categoryId, name, globalScore) VALUES (?,?,?)`,
        [opts.categoryId ?? CAT, name, opts.globalScore ?? 0]);
    const productId = Number(p.insertId);
    const sp = await q(
        `INSERT INTO StoreProduct (productId, chainId, storeProductName, isWeighable)
         VALUES (?,?,?,0)`, [productId, CHAIN, name]);
    await q(`INSERT INTO Price (storeProductId, storeId, price, date) VALUES (?,?,?,CURDATE())`,
        [Number(sp.insertId), STORE, 1.99]);
    return productId;
};

/** An interaction of `type`, `daysAgo` old — the age is what the decay reads. */
const addInteraction = async (userId: string, productId: number, type: string, daysAgo = 0) =>
    q(`INSERT INTO ProductInteraction (userId, productId, type, createdAt)
       VALUES (?,?,?, DATE_SUB(NOW(), INTERVAL ? DAY))`, [userId, productId, type, daysAgo]);

const setScore = async (userId: string, productId: number, score: number, interactions: number) =>
    q(`INSERT INTO UserProductScore (userId, productId, score, interactionCount, updatedAt)
       VALUES (?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE score=VALUES(score), interactionCount=VALUES(interactionCount)`,
        [userId, productId, score, interactions]);

beforeAll(async () => {
    await q(`INSERT INTO Category (id, name) VALUES (?,'AffinityCat')
             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [CAT]);
    await q(`INSERT INTO Category (id, name) VALUES (?,'Daržovių sėklos')
             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [SEED_CAT]);
    await q(`INSERT INTO StoreChain (id, name) VALUES (?,'AffinityChain')
             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [CHAIN]);
    await q(`INSERT INTO Store (id, chainId, name, address) VALUES (?,?,'Aff','X 1')
             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [STORE, CHAIN]);
    for (const u of [USER, OTHER]) {
        await q(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0)
                 ON DUPLICATE KEY UPDATE points=0`, [u]);
    }

    // Two products that are BOTH plainly the ingredient. Nothing but the
    // shopper's own history should separate them.
    ids.plainMilk = await addProduct('Pienas ROKIŠKIO, 2,5 % rieb.', { globalScore: 9 });
    ids.otherMilk = await addProduct('Pienas DVARO, 2,5 % rieb.', { globalScore: 3 });
    // A seed packet: never the ingredient, however much it is bought.
    ids.seedCarrot = await addProduct('Morkos Koral', { categoryId: SEED_CAT });
    ids.freshCarrot = await addProduct('Plautos morkos');
});

afterAll(async () => {
    const productIds = Object.values(ids);
    for (const u of [USER, OTHER]) {
        await q('DELETE FROM ProductInteraction WHERE userId = ?', [u]);
        await q('DELETE FROM UserProductScore WHERE userId = ?', [u]);
    }
    if (productIds.length > 0) {
        await q(`DELETE p FROM Price p JOIN StoreProduct sp ON sp.id=p.storeProductId
                 WHERE sp.productId IN (?)`, [productIds]);
        await q('DELETE FROM StoreProduct WHERE productId IN (?)', [productIds]);
        await q('DELETE FROM Product WHERE id IN (?)', [productIds]);
    }
    await q('DELETE FROM User WHERE id IN (?)', [[USER, OTHER]]);
    await q('DELETE FROM Store WHERE id = ?', [STORE]);
    await q('DELETE FROM StoreChain WHERE id = ?', [CHAIN]);
    await q('DELETE FROM Category WHERE id = ?', [CAT]);
    await (pool as any).end();
});

describe('rankAffinity', () => {
    const aff = (productId: number, personal: number, interactions: number, global: number) =>
        ({ productId, personal, interactions, global });

    /**
     * THE BUG THIS REPLACES. `global` is the sum of every user's `personal`, so
     * `personal <= global` ALWAYS (0 of 307 real pairs violated it). The old
     * per-product convex blend could therefore never exceed `global`: a shopper
     * who had bought something seven times ranked it BELOW a stranger. Ranking
     * has to compare candidates with each other, not the two halves with each
     * other.
     */
    it('promotes the product the shopper actually buys, even though personal <= global', () => {
        // A is the crowd favourite; B is this shopper's, and — as the write path
        // guarantees — B's personal is still below B's own global.
        const ranked = rankAffinity([
            aff(1, 0, 0, 30),     // crowd favourite, shopper never touched it
            aff(2, 8, 10, 12),    // shopper's own, a fraction of the crowd's leader
        ]);
        expect(ranked.get(2)!).toBeGreaterThan(ranked.get(1)!);
    });

    /**
     * NO HISTORY, NO OPINION — deliberately flat, not "the crowd's order".
     *
     * Expressing crowd popularity here silently replaced the name heuristics for
     * every LOGGED-IN shopper, even a brand-new one: 4 of 30 staple ingredients
     * changed product purely by signing in (plain sugar became vanilla sugar).
     * Signing in must change nothing until the shopper has shown a preference.
     */
    it('says nothing at all for a shopper with no history', () => {
        const ranked = rankAffinity([aff(1, 0, 0, 30), aff(2, 0, 0, 12)]);
        expect(ranked.get(1)).toBe(0);
        expect(ranked.get(2)).toBe(0);
    });

    /** A negative count (the column is signed, with no CHECK) once inverted the
     *  whole ranking and put the shopper's favourite last. */
    it('is not inverted by a corrupt interaction count', () => {
        const ranked = rankAffinity([aff(1, 100, -10, 3), aff(2, 0, 0, 3)]);
        expect(ranked.get(1)!).toBeGreaterThanOrEqual(ranked.get(2)!);
    });

    it('ignores NaN rather than letting it decide the order', () => {
        const ranked = rankAffinity([aff(1, NaN, 5, 10), aff(2, 4, 5, 10)]);
        expect(Number.isFinite(ranked.get(1)!)).toBe(true);
        expect(ranked.get(2)!).toBeGreaterThan(ranked.get(1)!);
    });

    /** One interaction is an opinion, ten is a habit — the handover is gradual. */
    it('lets a single interaction nudge, not decide', () => {
        const weak = rankAffinity([aff(1, 0, 0, 100), aff(2, 1, 1, 1)]);
        expect(weak.get(1)!).toBeGreaterThan(weak.get(2)!);      // crowd still wins

        const strong = rankAffinity([aff(1, 0, 0, 100), aff(2, 1, FULL_CONFIDENCE_INTERACTIONS, 1)]);
        expect(strong.get(2)!).toBeGreaterThan(strong.get(1)!);  // habit wins
    });

    it('handles a candidate set nobody has ever touched, and an empty one', () => {
        const none = rankAffinity([aff(1, 0, 0, 0), aff(2, 0, 0, 0)]);
        expect(none.get(1)).toBe(0);
        expect(rankAffinity([]).size).toBe(0);
    });
});

describe('getProductAffinity', () => {
    it('falls back to the global score for products the shopper has never touched', async () => {
        const aff = await getProductAffinity(USER, [ids.plainMilk, ids.otherMilk]);
        expect(aff.get(ids.plainMilk)!.global).toBe(9);
        expect(aff.get(ids.otherMilk)!.global).toBe(3);
        expect(aff.get(ids.plainMilk)!.personal).toBe(0);
        expect(aff.get(ids.plainMilk)!.interactions).toBe(0);
    });

    it('reads one shopper\'s history and nobody else\'s', async () => {
        await setScore(USER, ids.otherMilk, 40, 12);
        const mine = await getProductAffinity(USER, [ids.otherMilk]);
        const theirs = await getProductAffinity(OTHER, [ids.otherMilk]);
        expect(mine.get(ids.otherMilk)!.personal).toBe(40);
        expect(theirs.get(ids.otherMilk)!.personal).toBe(0);  // nobody else's history
    });

    it('treats an anonymous import as the crowd', async () => {
        const aff = await getProductAffinity(null, [ids.otherMilk]);
        expect(aff.get(ids.otherMilk)!.personal).toBe(0);
        expect(aff.get(ids.otherMilk)!.global).toBe(3);
    });

    it('answers for a batch in one call, and shrugs at an empty one', async () => {
        const aff = await getProductAffinity(USER, [ids.plainMilk, ids.otherMilk, ids.freshCarrot]);
        expect(aff.size).toBe(3);
        expect((await getProductAffinity(USER, [])).size).toBe(0);
    });
});

describe('refreshUserProductScores', () => {
    /**
     * The gap this closes: a stored score is written once, with the decay baked
     * in, and never re-run — so a habit the shopper dropped a year ago stayed at
     * full strength while the global half of the blend decayed nightly.
     */
    it('re-decays a stale score from the interactions that justify it', async () => {
        await addInteraction(USER, ids.plainMilk, 'receipt_buy', 400);
        await setScore(USER, ids.plainMilk, 999, 1);          // a stale, undecayed value

        await refreshUserProductScores();

        const rows: any = await q(
            'SELECT score, interactionCount FROM UserProductScore WHERE userId=? AND productId=?',
            [USER, ids.plainMilk]);
        // 400 days at a 90-day time constant is worth almost nothing.
        expect(Number(rows[0].score)).toBeLessThan(1);
        expect(Number(rows[0].interactionCount)).toBe(1);
    });

    it('weighs a purchase above a basket add', async () => {
        await addInteraction(OTHER, ids.plainMilk, 'receipt_buy', 0);
        await addInteraction(OTHER, ids.otherMilk, 'basket_add', 0);
        await setScore(OTHER, ids.plainMilk, 0, 0);
        await setScore(OTHER, ids.otherMilk, 0, 0);
        await refreshUserProductScores();

        const aff = await getProductAffinity(OTHER, [ids.plainMilk, ids.otherMilk]);
        expect(aff.get(ids.plainMilk)!.personal).toBeGreaterThan(aff.get(ids.otherMilk)!.personal);
    });
});

describe('affinity inside recipe matching', () => {
    const match = (line: string, userId: string | null) =>
        matchIngredient(parseIngredientLine(line, 'lt')[0], 'lt', 'lt', new Map(), userId);

    /**
     * THE POINT OF THE FEATURE: two products, both plainly milk, and the one the
     * shopper actually buys wins — even though the other has the better global
     * score and a shorter name.
     */
    it('prefers the milk this shopper actually buys', async () => {
        // Seeded as real INTERACTIONS, not a bare score: a score with nothing
        // behind it is a phantom and the nightly refresh now deletes it, which is
        // exactly what happened to the first version of this test.
        for (let i = 0; i < 12; i++) await addInteraction(USER, ids.otherMilk, 'basket_add', i);
        // The crowd clearly prefers plainMilk; this shopper clearly prefers the
        // other one — and their personal score still sits BELOW that product's
        // own global score, exactly as the write path guarantees.
        await q(`UPDATE Product SET globalScore = 60 WHERE id = ?`, [ids.plainMilk]);
        await q(`UPDATE Product SET globalScore = 25 WHERE id = ?`, [ids.otherMilk]);
        await refreshUserProductScores();
        const anonymous = await match('1 l pieno', null);
        const mine = await match('1 l pieno', USER);
        expect(mine.product?.productId).toBe(ids.otherMilk);          // this shopper's
        expect(anonymous.product?.productId).not.toBe(ids.otherMilk);  // not the crowd's
    });

    /**
     * THE GUARD: affinity ranks candidates, it does not admit them. A seed packet
     * is not a carrot no matter how often it was bought, so a huge personal score
     * on one must not put it in a basket.
     */
    it('never lets history make a seed packet into a vegetable', async () => {
        await setScore(USER, ids.seedCarrot, 500, 50);   // absurd on purpose
        const mine = await match('300 g morkų', USER);
        expect(mine.product?.productId).not.toBe(ids.seedCarrot);
        expect([mine.product, ...mine.alternatives].map(p => p?.productId))
            .not.toContain(ids.seedCarrot);
    });
});
