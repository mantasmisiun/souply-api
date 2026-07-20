import pool from '../config/db.js';
import { getPersonalComponentForProduct } from './userEquivalenceModel.js';
import { resolveEffectiveProductId } from '../services/storeProductMergeService.js';

export interface LinkedSets {
    /** basketProductId → Product ids the VIEWER voted 'same' (personal merge). */
    personal: Map<number, Set<number>>;
    /** basketProductId → Product ids hard-merged into the same effective root. */
    merge: Map<number, Set<number>>;
}

/**
 * Linked-product sets per basket item — the "same product, different signal"
 * expansion that feeds the basket calc's Tier-2 evidence ladder:
 *   · personal — Product ids the VIEWER voted 'same' (UserStoreProductEquivalence
 *                'same' component). Strongest: the user's explicit judgement.
 *   · merge    — Product ids hard-merged into the same effective root
 *                (Product.mergedIntoId, community Wilson-promoted). Also "same
 *                product".
 * Both are keyed by the basket item's own productId. The cluster tier
 * (Product.baseProductId, the weaker name-similarity grouping) is handled by the
 * calc's existing base-mode query and is NOT included here.
 *
 * Best-effort: any lookup that throws degrades to an empty set (the global tiers
 * still resolve the item), so the calc never fails on a merge-graph hiccup.
 */
export async function fetchLinkedSets(
    productIds: number[],
    userId: string | undefined,
): Promise<LinkedSets> {
    const personal = new Map<number, Set<number>>();
    const merge = new Map<number, Set<number>>();
    for (const pid of productIds) { personal.set(pid, new Set()); merge.set(pid, new Set()); }
    if (!productIds.length) return { personal, merge };

    // PERSONAL — the viewer's own 'same' component per item (only with a userId).
    if (userId) {
        await Promise.all(productIds.map(async pid => {
            try {
                const comp = await getPersonalComponentForProduct(userId, pid);
                const set = personal.get(pid)!;
                for (const q of comp) if (Number(q) !== pid) set.add(Number(q));
            } catch { /* personal tier best-effort */ }
        }));
    }

    // GLOBAL HARD MERGE — products sharing the effective mergedIntoId root.
    const rootByItem = new Map<number, number>();
    await Promise.all(productIds.map(async pid => {
        try { rootByItem.set(pid, Number(await resolveEffectiveProductId(pid))); }
        catch { rootByItem.set(pid, pid); }
    }));
    const roots = [...new Set(rootByItem.values())];
    if (roots.length) {
        try {
            // Root rows (id ∈ roots) + their direct losers (mergedIntoId ∈ roots).
            const [rows]: any = await pool.query(
                `SELECT id, mergedIntoId FROM Product WHERE id IN (?) OR mergedIntoId IN (?)`,
                [roots, roots],
            );
            const groupByRoot = new Map<number, number[]>();
            for (const r of rows as any[]) {
                const root = r.mergedIntoId != null ? Number(r.mergedIntoId) : Number(r.id);
                if (!roots.includes(root)) continue;
                const arr = groupByRoot.get(root) ?? [];
                arr.push(Number(r.id));
                groupByRoot.set(root, arr);
            }
            for (const pid of productIds) {
                const group = groupByRoot.get(rootByItem.get(pid)!) ?? [];
                const set = merge.get(pid)!;
                for (const q of group) if (q !== pid) set.add(q);
            }
        } catch { /* merge tier best-effort */ }
    }
    return { personal, merge };
}
