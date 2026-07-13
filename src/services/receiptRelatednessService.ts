import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import { getReceiptItemLines } from '../models/receiptItemModel.js';

/** Nepriskirta ("Uncategorised") bucket — a real scraped product that didn't match a
 *  catalog category. These are valuable community categorisation work, so the queue
 *  admits the name-related ones that have a photo (a real product, not garbage). */
const NEPRISKIRTA_CATEGORY_ID = MatchThresholds.nepriskirtaCategoryId;

/**
 * Receipt-relatedness scope + gate for the voluntary "Help identify products"
 * flow (see shared/SWIPE_QUEUE_REDESIGN.md, Decision 3). A global identity card
 * is only surfaced when its product is in a CATEGORY the user bought from AND its
 * name shares enough tokens with one of the receipt's lines — so the pool is
 * finite and never asks about product types the user didn't buy (no hair dye for
 * a grocery run).
 */
type Db = any;

export interface RelatednessScope {
    categoryIds: Set<number>;
    lineNames: string[];
    chainIds: Set<number>;
}

const DIACRITIC_MAP: Record<string, string> = { ą: 'a', č: 'c', ę: 'e', ė: 'e', į: 'i', š: 's', ų: 'u', ū: 'u', ž: 'z' };
const norm = (s: string): string =>
    s.toLowerCase().replace(/[ąčęėįšųūž]/g, (c) => DIACRITIC_MAP[c] ?? c);

const tokens = (s: string): Set<string> =>
    new Set(norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3));

/** Token-set Jaccard similarity of two names (0..1). */
export function tokenJaccard(a: string, b: string): number {
    const ta = tokens(a);
    const tb = tokens(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter);
}

/** Build the relatedness scope (categories + line names + chains) from a receipt. */
export async function getReceiptRelatednessScope(receiptId: number, conn: Db): Promise<RelatednessScope> {
    const [rows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ?', [receiptId]);
    const raw = rows?.[0]?.parsedData;
    const scope: RelatednessScope = { categoryIds: new Set(), lineNames: [], chainIds: new Set() };
    if (!raw) return scope;
    let parsed: any;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return scope;
    }
    const chainId = Number(parsed?.header?.chainId);
    if (Number.isFinite(chainId) && chainId > 0) scope.chainIds.add(chainId);
    // Products from ReceiptItem rows (P2 source of truth), blob fallback if not backfilled.
    let products = await getReceiptItemLines(receiptId, conn);
    if (products.length === 0 && Array.isArray(parsed?.products)) products = parsed.products;
    for (const line of products) {
        if (typeof line?.name === 'string' && line.name.trim()) scope.lineNames.push(line.name);
        const sp = Number(line?.storeProductId);
        const alts = Array.isArray(line?.altMatches) ? line.altMatches : [];
        const matched = alts.find((a: any) => Number(a?.storeProductId) === sp);
        const cat = Number(matched?.categoryId);
        if (Number.isFinite(cat) && cat > 0) scope.categoryIds.add(cat);
    }

    // Broaden to SIBLING leaf categories (same parentCategoryId). "Relevant to what you bought"
    // is the FAMILY, not only the exact leaf the receipt matched: the catalog splits e.g. curd
    // into "Curd cheese" / "Grainy curd" / "Curd snacks" under one parent, so the curd dedup
    // work the user would care about sits in sibling leaves. Stays strictly within the parent —
    // no cross-family leak (a hygiene parent never reaches a grocery scope). Skips 688 (it has no
    // meaningful parent for this purpose and is never added above).
    if (scope.categoryIds.size > 0) {
        const leafIds = [...scope.categoryIds];
        const [sibs]: any = await conn.query(
            `SELECT id FROM Category
              WHERE parentCategoryId IN (
                  SELECT parentCategoryId FROM Category WHERE id IN (?) AND parentCategoryId IS NOT NULL
              )`,
            [leafIds],
        );
        for (const s of (Array.isArray(sibs) ? sibs : [])) {
            const id = Number(s?.id);
            if (Number.isFinite(id) && id > 0) scope.categoryIds.add(id);
        }
    }
    return scope;
}

/** The card's product is in a category the user bought from (the cross-category guard). */
export function isCardRelatedByCategory(
    card: { categoryId: number },
    scope: RelatednessScope,
): boolean {
    return Number.isFinite(card.categoryId) && scope.categoryIds.has(card.categoryId);
}

/**
 * Is a global card related to the receipt? RELATED-ONLY policy (user decision): "relevant to
 * what you bought" = the SAME CATEGORY. A side qualifies when EITHER:
 *   • it is in a CATEGORY the user bought from — even a different brand (a varškė dedup pair
 *     for a varškė purchase). The name-token floor is DELIBERATELY NOT applied here: it was too
 *     strict — "ŽEMAITIJOS varškė" vs "Rokiškio varškė" share only "varške" → Jaccard 0.14 and
 *     real same-category dedup work was dropped. The category check is the cross-category guard
 *     (no hair dye for a grocery run); same-category dedup is exactly the community work wanted.
 *   • it is UNCATEGORISED (Nepriskirta, 688) but a REAL product — it has a photo — AND name-
 *     related to a receipt line. These scraped items can never match a real category, so the
 *     name relation + photo is the signal that it is worth surfacing for categorisation.
 *     (NOTE: slot3 currently excludes 688, so this arm is latent until uncategorised items
 *     enter the dedup pool — a separate change.)
 */
export function isCardRelated(
    card: { categoryId: number; name: string; imageUrl?: string | null },
    scope: RelatednessScope,
    floor: number = RECOGNITION.queue.relatednessNameFloor,
): boolean {
    if (isCardRelatedByCategory(card, scope)) return true;
    if (card.categoryId === NEPRISKIRTA_CATEGORY_ID && !!card.imageUrl) {
        return scope.lineNames.some((n) => tokenJaccard(card.name, n) >= floor);
    }
    return false;
}
