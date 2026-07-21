import pool from '../config/db.js';

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
 * CONCURRENCY: fires a BOUNDED number of queries (≤3) regardless of basket size —
 * one personal-edges query (union-found in JS), one batched merge-root CTE, one
 * merge-members query. The earlier per-product fan-out (2N personal + N root CTEs)
 * exhausted the connection pool under load; this keeps each calc's DB footprint
 * flat so many concurrent requests queue cleanly instead of overflowing.
 *
 * Best-effort: any query that throws degrades to empty sets (the global tiers
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

    // PERSONAL — ONE query for the viewer's 'same' edges, union-find in JS.
    if (userId) {
        try {
            const [edges]: any = await pool.query(
                `SELECT sp1.productId AS a, sp2.productId AS b
                   FROM UserStoreProductEquivalence e
                   JOIN StoreProduct sp1 ON sp1.id = e.spIdA
                   JOIN StoreProduct sp2 ON sp2.id = e.spIdB
                  WHERE e.userId = ? AND e.verdict = 'same'`,
                [userId],
            );
            const parent = new Map<number, number>();
            const find = (x: number): number => {
                let root = x;
                while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
                let cur = x;
                while (parent.get(cur) !== undefined && parent.get(cur) !== cur) {
                    const next = parent.get(cur)!; parent.set(cur, root); cur = next;
                }
                return root;
            };
            const union = (a: number, b: number) => {
                if (!parent.has(a)) parent.set(a, a);
                if (!parent.has(b)) parent.set(b, b);
                const ra = find(a), rb = find(b);
                if (ra !== rb) parent.set(ra, rb);
            };
            for (const e of edges as any[]) {
                if (e.a == null || e.b == null) continue;
                union(Number(e.a), Number(e.b));
            }
            const comp = new Map<number, number[]>();
            for (const node of parent.keys()) {
                const r = find(node);
                const arr = comp.get(r) ?? [];
                arr.push(node);
                comp.set(r, arr);
            }
            for (const pid of productIds) {
                if (!parent.has(pid)) continue; // no 'same' edge touches this product
                const set = personal.get(pid)!;
                for (const q of comp.get(find(pid)) ?? []) if (q !== pid) set.add(q);
            }
        } catch { /* personal tier best-effort */ }
    }

    // GLOBAL HARD MERGE — ONE recursive CTE resolves every product's effective
    // root, then ONE query gathers each root's members.
    try {
        const [rootRows]: any = await pool.query(
            `WITH RECURSIVE chain AS (
                 SELECT id AS seed, id AS node, mergedIntoId, 0 AS depth
                   FROM Product WHERE id IN (?)
                 UNION ALL
                 SELECT chain.seed, p.id, p.mergedIntoId, chain.depth + 1
                   FROM Product p JOIN chain ON p.id = chain.mergedIntoId
                  WHERE chain.mergedIntoId IS NOT NULL AND chain.depth < 4
             )
             SELECT seed, node, depth FROM chain`,
            [productIds],
        );
        // The deepest node reached from each seed is its effective root.
        const rootBySeed = new Map<number, number>();
        const depthBySeed = new Map<number, number>();
        for (const r of rootRows as any[]) {
            const seed = Number(r.seed), node = Number(r.node), depth = Number(r.depth);
            if (!depthBySeed.has(seed) || depth > depthBySeed.get(seed)!) {
                depthBySeed.set(seed, depth);
                rootBySeed.set(seed, node);
            }
        }
        const roots = [...new Set(rootBySeed.values())];
        if (roots.length) {
            const [members]: any = await pool.query(
                `SELECT id, mergedIntoId FROM Product WHERE id IN (?) OR mergedIntoId IN (?)`,
                [roots, roots],
            );
            const byRoot = new Map<number, number[]>();
            for (const m of members as any[]) {
                const root = m.mergedIntoId != null ? Number(m.mergedIntoId) : Number(m.id);
                if (!roots.includes(root)) continue;
                const arr = byRoot.get(root) ?? [];
                arr.push(Number(m.id));
                byRoot.set(root, arr);
            }
            for (const pid of productIds) {
                const group = byRoot.get(rootBySeed.get(pid) ?? pid) ?? [];
                const set = merge.get(pid)!;
                for (const q of group) if (q !== pid) set.add(q);
            }
        }
    } catch { /* merge tier best-effort */ }

    return { personal, merge };
}
