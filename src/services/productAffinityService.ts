import pool from '../config/db.js';
import { INTERACTION_WEIGHTS, WEIGHTED_SCORE_EXPR } from '../models/productInteractionModel.js';

/**
 * PRODUCT AFFINITY — the one answer to "how much does THIS shopper want THIS
 * product", for any feature that has to choose between products a name match
 * cannot separate.
 *
 * The raw signal already existed: `ProductInteraction` records what a user
 * bought, checked off, or added, and `UserProductScore` materialises the decayed
 * per-pair total. What did NOT exist was a single place to ask the question, so
 * two different blends had grown in two different features (a linear
 * confidence ramp in category browse, a Jelinek-Mercer blend in Smart Basket)
 * over two different decays. New callers had nothing to reuse and would have
 * grown a third.
 *
 * THE SHAPE OF THE ANSWER
 *   personal — decayed weight of this user's own interactions with the product
 *   global   — the same measure across everybody (`Product.globalScore`)
 *
 * Those are FACTS. Turning them into an order is `rankAffinity`, which needs the
 * whole candidate set — see the long comment there for why a per-product blend
 * of the two numbers is mathematically incapable of expressing a preference.
 *
 * WHAT THIS IS NOT: a price signal. Ranking a recipe's candidates by price would
 * put the cheapest yoghurt in the basket regardless of whether the shopper has
 * ever bought it — and the basket calculator already answers "where is this
 * cheapest" later, per store. Affinity answers "which product", price answers
 * "which shop", and mixing them makes both worse.
 */

/** What one product is worth to one user. */
export interface ProductAffinity {
    productId: number;
    /** Decayed sum of this user's interactions. 0 when they have none. */
    personal: number;
    /** How many interactions back that number — the confidence in `personal`. */
    interactions: number;
    /**
     * Everybody's decayed sum for this product (`Product.globalScore`) — which
     * INCLUDES this user's own contribution, hence `personal <= global` always.
     */
    global: number;
}

/**
 * Interactions needed before a shopper's own history fully outranks the crowd's.
 *
 * Ten is inherited from the category-browse blend that has been in production
 * the longest. Below it the two are mixed in proportion: one interaction is a
 * weak opinion, ten is a habit.
 */
export const FULL_CONFIDENCE_INTERACTIONS = 10;

/**
 * THE TRAP THIS FILE EXISTS TO AVOID — read before changing anything here.
 *
 * `personal` and `global` are NOT independent quantities on a shared scale:
 *
 *     global(p) = Σ over ALL users of personal(u, p)
 *
 * — the same weights, the same 90-day decay, summed over everyone. So
 * `personal(u,p) ≤ global(p)` is an INVARIANT, and a convex blend
 * `c·personal + (1−c)·global` can never exceed `global`. Measured over every
 * real pair in the dev database, recomputed fresh from `ProductInteraction`:
 * personal exceeded global in **0 of 307** pairs; in 222 the user was the only
 * toucher (so the blend was the identity) and in 85 it strictly LOWERED the
 * score. A shopper who had bought a product seven times ranked it 2.4 points
 * BELOW a stranger who had never heard of it.
 *
 * In other words the first cut of this file could only ever penalise a
 * preference, never express one, and `FULL_CONFIDENCE_INTERACTIONS` was the
 * point of maximum penalty. It passed its tests because the tests seeded states
 * the write path cannot produce (a personal score above the global one).
 *
 * The fix is to compare LIKE WITH LIKE: rank a product against the OTHER
 * CANDIDATES for the same ingredient, on each side separately, and blend the
 * two rankings. Shares are scale-free, so the fact that one side is a subset
 * sum of the other stops mattering.
 */
export const rankAffinity = (items: readonly ProductAffinity[]): Map<number, number> => {
    const out = new Map<number, number>();
    if (items.length === 0) return out;

    // Confidence comes from what the shopper has shown ACROSS this choice, not
    // from one product: two interactions spread over two candidates is still a
    // weak opinion about which to buy. Clamped at zero — `interactionCount` is a
    // signed column with no CHECK, and a negative one inverted the whole ranking,
    // putting a shopper's favourite last.
    const totalInteractions = Math.max(0, items.reduce((n, i) => n + safe(i.interactions), 0));

    /**
     * NO HISTORY, NO OPINION.
     *
     * With nothing to say, this used to fall through to the global score — which
     * silently replaced the name heuristics for every LOGGED-IN shopper, even a
     * brand-new one. Measured: 4 of 30 staple ingredients changed product purely
     * by being signed in (plain sugar became vanilla sugar, Basmati became
     * long-grain). Signing in must not change what a recipe buys until the
     * shopper has actually shown a preference, so an empty history returns a flat
     * zero and leaves the ordering exactly where an anonymous import leaves it.
     */
    if (totalInteractions === 0) {
        for (const item of items) out.set(item.productId, 0);
        return out;
    }

    const maxPersonal = Math.max(...items.map(i => safe(i.personal)), 0);
    const maxGlobal = Math.max(...items.map(i => safe(i.global)), 0);
    const confidence = Math.min(totalInteractions, FULL_CONFIDENCE_INTERACTIONS)
        / FULL_CONFIDENCE_INTERACTIONS;

    for (const item of items) {
        const personalShare = maxPersonal > 0 ? safe(item.personal) / maxPersonal : 0;
        const globalShare = maxGlobal > 0 ? safe(item.global) / maxGlobal : 0;
        out.set(item.productId, confidence * personalShare + (1 - confidence) * globalShare);
    }
    return out;
};

/** A number, or zero. Guards NaN and Infinity, which would otherwise make the
 *  sort order depend on the input order rather than on the data. */
const safe = (n: number): number => (Number.isFinite(n) ? n : 0);

const EMPTY: ProductAffinity = { productId: 0, personal: 0, interactions: 0, global: 0 };

/**
 * One shopper's stored scores, held for the lifetime of ONE operation.
 *
 * A recipe import asks about candidates ingredient by ingredient — 31 round
 * trips for a 16-ingredient recipe, of which 87 % was measured to be latency
 * rather than work. The shopper's whole score table is small (a sparse row per
 * product they have touched; 113 for the busiest dev account, read in 0.2 ms),
 * so it is fetched once and reused.
 */
export type AffinityCache = { userId: string; rows: Map<number, { score: number; interactions: number }> };

/** Load a shopper's entire score table once, for reuse across an operation. */
export const loadAffinityCache = async (userId: string): Promise<AffinityCache> => {
    const [rows]: any = await pool.query(
        `SELECT productId, score, interactionCount FROM UserProductScore WHERE userId = ?`,
        [userId],
    );
    return {
        userId,
        rows: new Map((rows as any[]).map(r => [
            Number(r.productId),
            { score: Number(r.score) || 0, interactions: Number(r.interactionCount) || 0 },
        ])),
    };
};

/**
 * Affinity for a specific set of products.
 *
 * ONE indexed query. `UserProductScore` is keyed `PRIMARY (userId, productId)`,
 * so this is a primary-key range scan over the ids the caller already has —
 * it never scans the user's whole history and never touches the 49 000-row
 * Product table beyond the ids asked for.
 *
 * Sparse by design: a user has rows only for products they have touched, and
 * everything else falls through to the global score. A dense per-user table
 * would be 49 000 rows per user for no gain.
 *
 * @param globalScores the caller usually already has these (the product search
 *        selects `globalScore`); pass them to avoid a second query.
 */
export const getProductAffinity = async (
    userId: string | null | undefined,
    productIds: number[],
    globalScores?: Map<number, number>,
    cache?: AffinityCache,
): Promise<Map<number, ProductAffinity>> => {
    const out = new Map<number, ProductAffinity>();
    const ids = [...new Set(productIds.filter(id => Number.isFinite(id) && id > 0))];
    if (ids.length === 0) return out;

    const globals = globalScores ?? await loadGlobalScores(ids);

    let personal = new Map<number, { score: number; interactions: number }>();
    if (cache && userId && cache.userId === userId) {
        personal = cache.rows;
    } else if (userId) {
        const [rows]: any = await pool.query(
            `SELECT productId, score, interactionCount
               FROM UserProductScore
              WHERE userId = ? AND productId IN (?)`,
            [userId, ids],
        );
        personal = new Map((rows as any[]).map(r => [
            Number(r.productId),
            { score: Number(r.score) || 0, interactions: Number(r.interactionCount) || 0 },
        ]));
    }

    for (const id of ids) {
        const p = personal.get(id);
        const global = globals.get(id) ?? 0;
        const personalScore = p?.score ?? 0;
        const interactions = p?.interactions ?? 0;
        // Raw facts only. Ranking is `rankAffinity`'s job, because it needs the
        // whole candidate set to compare like with like.
        out.set(id, { productId: id, personal: personalScore, interactions, global });
    }
    return out;
};

const loadGlobalScores = async (ids: number[]): Promise<Map<number, number>> => {
    const [rows]: any = await pool.query(
        `SELECT id, globalScore FROM Product WHERE id IN (?)`, [ids],
    );
    return new Map((rows as any[]).map(r => [Number(r.id), Number(r.globalScore) || 0]));
};

/** Affinity for one product — the convenience form. Prefer the batch call. */
export const getOneProductAffinity = async (
    userId: string | null | undefined,
    productId: number,
): Promise<ProductAffinity> =>
    (await getProductAffinity(userId, [productId])).get(productId) ?? { ...EMPTY, productId };

/**
 * Re-decay every stored per-user score.
 *
 * THE GAP THIS CLOSES: `UserProductScore.score` is written only when a user
 * interacts with that product, and the decay is baked in AT WRITE TIME. A
 * shopper who bought oat milk weekly for a year and then stopped keeps that
 * score forever, while `Product.globalScore` re-decays every night — so the
 * personal half of every blend drifted out of step with the global half, and
 * the drift always favoured stale habits.
 *
 * Recomputed from `ProductInteraction`, which is the source of truth, so this is
 * idempotent and safe to run as often as wanted. One UPDATE over a sparse table
 * (306 rows in dev, bounded by interactions rather than by users × products).
 */
export const refreshUserProductScores = async (): Promise<number> => {
    /**
     * Rows whose interactions no longer exist cannot be fixed by the UPDATE
     * below — it is an inner join, so it simply skips them and a score of 999
     * survives forever with nothing justifying it. Delete them first: the
     * interactions are the source of truth, and a score without any is not a
     * stale opinion, it is a phantom.
     */
    await pool.query(
        `DELETE ups FROM UserProductScore ups
          WHERE NOT EXISTS (
              SELECT 1 FROM ProductInteraction pi
               WHERE pi.userId = ups.userId AND pi.productId = ups.productId)`,
    );
    /**
     * Rebuild from the source of truth as an UPSERT, not an UPDATE.
     *
     * The first cut was an `UPDATE ... JOIN`, which can refresh a row that exists
     * but can never CREATE one — so a shopper whose interactions were recorded
     * while the fire-and-forget `recalcUserProductScore` failed (it swallows its
     * errors) stayed permanently invisible to every feature that reads this
     * table. Dev had such a pair. An upsert makes the table a pure function of
     * `ProductInteraction`, which is what "source of truth" has to mean.
     */
    const [res]: any = await pool.query(
        `INSERT INTO UserProductScore (userId, productId, score, interactionCount, updatedAt)
         SELECT pi.userId, pi.productId,
                ${WEIGHTED_SCORE_EXPR} AS score,
                COUNT(*) AS interactionCount,
                NOW()
           FROM ProductInteraction pi
          GROUP BY pi.userId, pi.productId
         ON DUPLICATE KEY UPDATE
             score = VALUES(score),
             interactionCount = VALUES(interactionCount),
             updatedAt = VALUES(updatedAt)`,
    );
    return Number(res?.affectedRows ?? 0);
};

/** Re-export so a caller never has to guess what a signal is worth. */
export { INTERACTION_WEIGHTS };
