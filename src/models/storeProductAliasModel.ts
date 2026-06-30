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
): Promise<void> {
    const { chainId, storeProductId, rawName, userId, vote, receiptId } = input;
    if (!Number.isFinite(chainId) || !Number.isFinite(storeProductId) || storeProductId <= 0) return;
    if (!userId) return;
    const normalizedAlias = normalizeProductName(rawName);
    // Require at least one significant (≥4-char) token — a 1-2 char fragment is not a
    // useful alias and would over-match.
    if (!normalizedAlias || !normalizedAlias.split(' ').some((t) => t.length >= RECOGNITION.match.significantMinLen)) return;
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
    if (!alias) return;
    const aliasId = Number(alias.id);

    // 2. Upsert the user's single vote (latest wins).
    await conn.query(
        `INSERT INTO StoreProductReceiptAliasVote (aliasId, userId, vote, receiptId)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE vote = VALUES(vote), receiptId = VALUES(receiptId)`,
        [aliasId, userId, vote, receiptId],
    );

    // 3. Recompute distinct-user tallies from the vote table.
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

    // 4. State machine.
    const K = RECOGNITION.vocab.canonicalDistinctUsers;
    let status: 'pending' | 'canonical' | 'similarity' | 'rejected';
    if (alias.adminVerdict === 'rejected') status = 'rejected';
    else if (alias.adminVerdict === 'confirmed') status = 'canonical';
    else if (differentUsers > 0) status = 'rejected';        // 'different' = strong veto
    else if (identicalUsers >= K) status = 'canonical';
    else if (similarUsers > 0) status = 'similarity';
    else status = 'pending';

    await conn.query(
        `UPDATE StoreProductReceiptAlias SET identicalUsers = ?, similarUsers = ?, differentUsers = ?, status = ? WHERE id = ?`,
        [identicalUsers, similarUsers, differentUsers, status, aliasId],
    );
}

/**
 * Map of storeProductId → its CANONICAL receipt-name aliases for a chain. Read by the
 * matcher so a confirmed alias is an additional exact match target. Canonical only —
 * pending/similarity/rejected aliases never influence name matching.
 */
export async function fetchCanonicalAliasesByChain(chainId: number): Promise<Map<number, string[]>> {
    const map = new Map<number, string[]>();
    if (!Number.isFinite(chainId)) return map;
    const [rows]: any = await pool.query(
        `SELECT storeProductId, normalizedAlias FROM StoreProductReceiptAlias WHERE chainId = ? AND status = 'canonical'`,
        [chainId],
    );
    for (const r of rows) {
        const sp = Number(r.storeProductId);
        if (!Number.isFinite(sp)) continue;
        const list = map.get(sp);
        if (list) list.push(r.normalizedAlias);
        else map.set(sp, [r.normalizedAlias]);
    }
    return map;
}
