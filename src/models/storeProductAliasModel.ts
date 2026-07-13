import pool from '../config/db.js';
import { normalizeProductName } from '../utils/productMatcher.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

type Connection = typeof pool | any;

/**
 * Receipt-name VOCABULARY model (Issue H). Learns how a chain PRINTS a StoreProduct
 * on its receipts so future receipts match the same garbled OCR string by a confirmed
 * alias instead of re-deriving it with fuzzy name math. See sql/receipt_name_vocabulary.sql
 * + memory project_vocabulary_subsystem.
 *
 * Aliases are normalized with the SAME normalizeProductName the matcher applies to the
 * query, so a stored alias compares apples-to-apples against an OCR line.
 */

export type AliasVote = 'identical' | 'similar' | 'different';

export interface AliasVoteOutcome {
    aliasId: number;
    status: 'pending' | 'canonical' | 'similarity' | 'rejected';
    identicalUsers: number;
    similarUsers: number;
    differentUsers: number;
}

/**
 * Record a vote that the OCR string `rawName` (in `chainId`) refers to StoreProduct
 * `storeProductId`, then recompute the alias's distinct-user tallies + status. Upserts
 * the alias (dedup by chain+SP+normalized text, bumping occurrences) and the user's
 * single vote, then re-derives the state machine:
 *   adminVerdict wins → canonical/rejected; else a 'different' vote is a strong veto
 *   (rejected); else ≥ K distinct 'identical' users → canonical; else a 'similar'
 *   vote → similarity; else pending.
 * No-op when the normalized text is empty (too garbled to be a useful alias). Runs in
 * the caller's transaction.
 */
export async function recordAliasVote(
    input: {
        chainId: number;
        storeProductId: number;
        rawName: string;
        userId: string;
        vote: AliasVote;
        receiptId: number | null;
    },
    conn: Connection,
): Promise<AliasVoteOutcome | null> {
    const { chainId, storeProductId, rawName, userId, vote, receiptId } = input;
    if (!Number.isFinite(chainId) || !Number.isFinite(storeProductId) || storeProductId <= 0) return null;
    if (!userId) return null;
    const normalizedAlias = normalizeProductName(rawName);
    // Require at least one significant (≥4-char) token — a 1-2 char fragment is not a
    // useful alias and would over-match.
    if (!normalizedAlias || !normalizedAlias.split(' ').some((t) => t.length >= RECOGNITION.match.significantMinLen)) return null;
    const rawSample = typeof rawName === 'string' ? rawName.slice(0, 255) : null;

    // 1. Upsert the alias row (dedup by chain+SP+normalized; bump occurrences/lastSeen).
    await conn.query(
        `INSERT INTO StoreProductReceiptAlias (chainId, storeProductId, normalizedAlias, rawSample, occurrences, sampleReceiptId)
         VALUES (?, ?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE occurrences = occurrences + 1, lastSeenAt = CURRENT_TIMESTAMP,
             rawSample = COALESCE(rawSample, VALUES(rawSample)),
             sampleReceiptId = COALESCE(sampleReceiptId, VALUES(sampleReceiptId))`,
        [chainId, storeProductId, normalizedAlias, rawSample, receiptId],
    );

    const [aRows]: any = await conn.query(
        `SELECT id, adminVerdict FROM StoreProductReceiptAlias WHERE chainId = ? AND storeProductId = ? AND normalizedAlias = ?`,
        [chainId, storeProductId, normalizedAlias],
    );
    const alias = aRows?.[0];
    if (!alias) return null;
    return applyAliasVote(Number(alias.id), userId, vote, receiptId ?? null, alias.adminVerdict ?? null, conn);
}

/**
 * The alias state machine (balanced veto): adminVerdict wins; else a 'different' vote
 * rejects only when dissenters TIE OR EXCEED the identical confirmers (one bad vote can't
 * overturn an alias two users confirmed); else ≥ K distinct 'identical' users → canonical;
 * else a 'similar' vote → similarity; else pending. Shared by applyAliasVote and the
 * receipt-reset recompute so both derive status identically.
 */
export function deriveAliasStatus(
    identicalUsers: number,
    similarUsers: number,
    differentUsers: number,
    adminVerdict: 'confirmed' | 'rejected' | null,
): 'pending' | 'canonical' | 'similarity' | 'rejected' {
    const K = RECOGNITION.vocab.canonicalDistinctUsers;
    if (adminVerdict === 'rejected') return 'rejected';
    if (adminVerdict === 'confirmed') return 'canonical';
    if (differentUsers > 0 && differentUsers >= identicalUsers) return 'rejected';
    if (identicalUsers >= K) return 'canonical';
    if (similarUsers > 0) return 'similarity';
    return 'pending';
}

/**
 * Recompute an alias's distinct-user tallies + status from the votes that CURRENTLY remain
 * (used after a receipt reset removes some votes). If no votes remain and no admin verdict
 * pins it, the alias only ever existed because of the removed data → delete it. Returns true
 * when the alias row was deleted. Runs in the caller's transaction.
 */
export async function recomputeAliasAfterVoteRemoval(aliasId: number, conn: Connection): Promise<boolean> {
    const [tRows]: any = await conn.query(
        `SELECT vote, COUNT(DISTINCT userId) AS n FROM StoreProductReceiptAliasVote WHERE aliasId = ? GROUP BY vote`,
        [aliasId],
    );
    let identicalUsers = 0, similarUsers = 0, differentUsers = 0;
    for (const r of tRows) {
        if (r.vote === 'identical') identicalUsers = Number(r.n);
        else if (r.vote === 'similar') similarUsers = Number(r.n);
        else if (r.vote === 'different') differentUsers = Number(r.n);
    }
    const [aRows]: any = await conn.query(`SELECT adminVerdict FROM StoreProductReceiptAlias WHERE id = ?`, [aliasId]);
    const adminVerdict = (aRows?.[0]?.adminVerdict ?? null) as 'confirmed' | 'rejected' | null;
    if (identicalUsers + similarUsers + differentUsers === 0 && !adminVerdict) {
        await conn.query(`DELETE FROM StoreProductReceiptAlias WHERE id = ?`, [aliasId]);
        return true;
    }
    const status = deriveAliasStatus(identicalUsers, similarUsers, differentUsers, adminVerdict);
    await conn.query(
        `UPDATE StoreProductReceiptAlias SET identicalUsers = ?, similarUsers = ?, differentUsers = ?, status = ? WHERE id = ?`,
        [identicalUsers, similarUsers, differentUsers, status, aliasId],
    );
    return false;
}

/**
 * Upsert a user's single vote on an EXISTING alias, then recompute its distinct-user
 * tallies + status (the balanced-veto state machine). Shared by recordAliasVote (the
 * receipt-line Card-B path) and recordAliasVoteById (a pending-alias swipe card).
 *
 * Balanced veto: a 'different' vote rejects only when dissenters TIE OR EXCEED the
 * identical confirmers, so one bad vote can't overturn an alias two users confirmed.
 */
async function applyAliasVote(
    aliasId: number,
    userId: string,
    vote: AliasVote,
    receiptId: number | null,
    adminVerdict: 'confirmed' | 'rejected' | null,
    conn: Connection,
): Promise<AliasVoteOutcome> {
    await conn.query(
        `INSERT INTO StoreProductReceiptAliasVote (aliasId, userId, vote, receiptId)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE vote = VALUES(vote), receiptId = VALUES(receiptId)`,
        [aliasId, userId, vote, receiptId],
    );
    const [tRows]: any = await conn.query(
        `SELECT vote, COUNT(DISTINCT userId) AS n FROM StoreProductReceiptAliasVote WHERE aliasId = ? GROUP BY vote`,
        [aliasId],
    );
    let identicalUsers = 0, similarUsers = 0, differentUsers = 0;
    for (const r of tRows) {
        if (r.vote === 'identical') identicalUsers = Number(r.n);
        else if (r.vote === 'similar') similarUsers = Number(r.n);
        else if (r.vote === 'different') differentUsers = Number(r.n);
    }
    const status = deriveAliasStatus(identicalUsers, similarUsers, differentUsers, adminVerdict);
    await conn.query(
        `UPDATE StoreProductReceiptAlias SET identicalUsers = ?, similarUsers = ?, differentUsers = ?, status = ? WHERE id = ?`,
        [identicalUsers, similarUsers, differentUsers, status, aliasId],
    );
    return { aliasId, status, identicalUsers, similarUsers, differentUsers };
}

/**
 * Record a vote on a pending-alias SWIPE CARD by its alias id (H3 pending-card
 * surfacing): the user votes on a learned alias directly, not via a receipt line.
 * Returns the alias's new status (or null if it's gone). Runs in the caller's txn.
 */
export async function recordAliasVoteById(
    aliasId: number,
    userId: string,
    vote: AliasVote,
    conn: Connection,
): Promise<AliasVoteOutcome | null> {
    if (!Number.isFinite(aliasId) || !userId) return null;
    const [rows]: any = await conn.query('SELECT id, adminVerdict FROM StoreProductReceiptAlias WHERE id = ?', [aliasId]);
    const alias = rows?.[0];
    if (!alias) return null;
    return applyAliasVote(aliasId, userId, vote, null, alias.adminVerdict ?? null, conn);
}

/**
 * SP's L2 (mid) + L3 (leaf) category labels — used ONLY by the vocabulary swipe LOG to
 * confirm what a 'similar' vote's similarity link points at. Best-effort (null on miss).
 */
export async function fetchSpCategoryLabels(storeProductId: number, conn: Connection): Promise<{ l2: string | null; l3: string | null }> {
    try {
        const [rows]: any = await conn.query(
            `SELECT COALESCE(ct.name, c.name) AS l3,
                    CASE WHEN c.parentCategoryId IS NULL  THEN NULL
                         WHEN c2.parentCategoryId IS NULL THEN COALESCE(ct.name, c.name)
                         ELSE COALESCE(ct2.name, c2.name) END AS l2
               FROM StoreProduct sp
               JOIN Product p  ON p.id = sp.productId
               LEFT JOIN Category c  ON p.categoryId = c.id
               LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
               LEFT JOIN CategoryTranslation ct  ON ct.categoryId  = c.id  AND ct.locale  = 'lt'
               LEFT JOIN CategoryTranslation ct2 ON ct2.categoryId = c2.id AND ct2.locale = 'lt'
              WHERE sp.id = ?`,
            [storeProductId],
        );
        return { l2: rows?.[0]?.l2 ?? null, l3: rows?.[0]?.l3 ?? null };
    } catch {
        return { l2: null, l3: null };
    }
}

/**
 * Map of storeProductId → its CANONICAL receipt-name aliases for a chain. Read by the
 * matcher so a confirmed alias is an additional exact match target. Canonical only —
 * pending/similarity/rejected aliases never influence name matching.
 */
export async function fetchCanonicalAliasesByChain(chainId: number): Promise<Map<number, string[]>> {
    return (await fetchAliasesByChainGrouped(chainId)).canonical;
}

export interface GroupedAliases {
    /** Used as ADDITIONAL exact match targets (how the chain prints the SP). */
    canonical: Map<number, string[]>;
    /** A 'different'-vetoed (OCR, SP) combo — SUPPRESS re-suggesting that SP for the
     *  OCR (the no-repeat rule, as a matcher signal). */
    rejected: Map<number, string[]>;
    /** A 'similar' = same-category-substitute link — when the query matches one, scope
     *  matching to that SP's L2 + boost its L3 (the orphan re-matching). */
    similarity: Map<number, string[]>;
}

/**
 * All resolved (non-pending) aliases for a chain, grouped by status, keyed by
 * storeProductId. One query. Attached to candidates by the chain catalog fetch so the
 * matcher can use canonical aliases as match targets, rejected ones to suppress, and
 * similarity ones to category-scope.
 */
export async function fetchAliasesByChainGrouped(chainId: number): Promise<GroupedAliases> {
    const out: GroupedAliases = { canonical: new Map(), rejected: new Map(), similarity: new Map() };
    if (!Number.isFinite(chainId)) return out;
    const [rows]: any = await pool.query(
        `SELECT storeProductId, normalizedAlias, status FROM StoreProductReceiptAlias
         WHERE chainId = ? AND status IN ('canonical', 'rejected', 'similarity')`,
        [chainId],
    );
    for (const r of rows) {
        const sp = Number(r.storeProductId);
        if (!Number.isFinite(sp)) continue;
        const m = r.status === 'canonical' ? out.canonical : r.status === 'rejected' ? out.rejected : out.similarity;
        const list = m.get(sp);
        if (list) list.push(r.normalizedAlias);
        else m.set(sp, [r.normalizedAlias]);
    }
    return out;
}

/**
 * Canonical aliases for a SPECIFIC set of SP ids (not a whole chain). Targeted lookup
 * used by the vocab-driven queue (H3) to bridge cross-chain identity pairs: how each
 * chain PRINTS a product often agrees even when the catalog names diverge. Returns
 * Map<spId, normalizedAlias[]>; empty map for an empty input.
 */
export async function fetchCanonicalAliasesForSps(spIds: number[]): Promise<Map<number, string[]>> {
    const map = new Map<number, string[]>();
    const ids = [...new Set(spIds.filter((n) => Number.isFinite(n) && n > 0))];
    if (ids.length === 0) return map;
    const [rows]: any = await pool.query(
        `SELECT storeProductId, normalizedAlias FROM StoreProductReceiptAlias
         WHERE status = 'canonical' AND storeProductId IN (?)`,
        [ids],
    );
    for (const r of rows) {
        const sp = Number(r.storeProductId);
        const list = map.get(sp);
        if (list) list.push(r.normalizedAlias);
        else map.set(sp, [r.normalizedAlias]);
    }
    return map;
}

/** A pending-alias swipe card: "is this receipt text the same product as this SP?" */
export interface PendingAliasCard {
    aliasId: number;
    chainId: number;
    rawSample: string | null;       // the receipt OCR text as printed
    normalizedAlias: string;
    occurrences: number;            // how many receipts printed it (surfacing priority)
    storeProductId: number;
    storeProductName: string;
    imageUrl: string | null;
}

/**
 * Pending-alias cards for a user to vote on (H3 pending-card surfacing): aliases still
 * gathering consensus (status='pending') that the user HASN'T voted on yet (the
 * no-repeat-combo rule), with the SP they point at, most-seen first. `chainId` null =
 * across all chains. Pure read.
 */
export async function fetchPendingAliasCards(
    userId: string,
    chainId: number | null,
    limit: number,
): Promise<PendingAliasCard[]> {
    if (!userId) return [];
    const lim = Math.max(1, Math.min(50, Math.floor(limit) || 10));
    const chainClause = chainId != null && Number.isFinite(chainId) ? 'AND a.chainId = ?' : '';
    // Placeholder order: [chainId?], userId (NOT EXISTS), lim (LIMIT).
    const params = chainClause ? [chainId, userId, lim] : [userId, lim];
    const [rows]: any = await pool.query(
        `SELECT a.id AS aliasId, a.chainId, a.rawSample, a.normalizedAlias, a.occurrences,
                a.storeProductId, sp.storeProductName, sp.imageUrl
         FROM StoreProductReceiptAlias a
         JOIN StoreProduct sp ON sp.id = a.storeProductId
         WHERE a.status = 'pending' ${chainClause}
           AND NOT EXISTS (SELECT 1 FROM StoreProductReceiptAliasVote v WHERE v.aliasId = a.id AND v.userId = ?)
         ORDER BY a.occurrences DESC, a.lastSeenAt DESC
         LIMIT ?`,
        params,
    );
    return rows.map((r: any) => ({
        aliasId: Number(r.aliasId),
        chainId: Number(r.chainId),
        rawSample: r.rawSample ?? null,
        normalizedAlias: r.normalizedAlias,
        occurrences: Number(r.occurrences),
        storeProductId: Number(r.storeProductId),
        storeProductName: r.storeProductName,
        imageUrl: r.imageUrl ?? null,
    }));
}
