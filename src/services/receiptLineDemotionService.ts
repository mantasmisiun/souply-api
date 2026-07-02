import type { Connection } from 'mysql2/promise';
import { computeItemConfidence } from './itemConfidence.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { syncReceiptItemMatchState, itemToLine } from '../models/receiptItemModel.js';

/** The receipt's chainId from the blob header (still present; products[] no longer are). */
async function getReceiptChainId(receiptId: number, conn: Connection): Promise<number> {
    const [rows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ?', [receiptId]);
    const raw = rows?.[0]?.parsedData;
    if (!raw) return NaN;
    try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Number(p?.header?.chainId);
    } catch { return NaN; }
}

/**
 * Demote a receipt line whose PRIMARY match identity the user rejected.
 *
 * Trigger: a personal 'different' vote (the 1-vote split) on a pair where one SP
 * is a receipt line's current `storeProductId` and the OTHER is that line's TOP
 * altMatch — i.e. the user said "my line is NOT really this product". The classic
 * case is the cross-chain bootstrap (line SP 97651 minted from Barbora slyvos
 * SP 240): voting (97651, 240) 'different' rejects the borrowed identity.
 *
 * Effect: the line is RE-POINTED to its best runner-up altMatch when that runner-up
 * is already a valid SAME-CHAIN SP at/above auto-apply confidence; otherwise the SP
 * link is cleared so the Items tab shows the OCR name (display is `matchConfirmed`-
 * gated). Either way the price is unverified and the confidence recomputed (a
 * `userRejected` veto when it falls back to OCR). NOTE: a cross-chain runner-up is
 * NOT re-pointed here (it would need bootstrap/re-resolution inside the vote txn) —
 * it falls back to OCR. The rejected SP's already-written Price row is left as-is
 * (a known limitation shared with the original demotion).
 *
 * Reads + writes parsedData FOR UPDATE inside the caller's transaction so a
 * concurrent autosave can't clobber it. Returns true if a line was demoted.
 * Caller treats this fail-open — a vote must never fail because demotion couldn't run.
 */
export async function demoteRejectedReceiptLine(
    receiptId: number,
    spA: number,
    spB: number,
    conn: Connection,
): Promise<boolean> {
    // Find the ReceiptItem row(s) whose match is one of the rejected pair (source of truth),
    // FOR UPDATE. chainId from the receipt header (blob no longer carries products[]). The
    // demotion is a single-row UPDATE, not a whole-blob rewrite.
    const [itemRows]: any = await conn.query(
        'SELECT * FROM ReceiptItem WHERE receiptId = ? AND matchedSpId IN (?, ?) ORDER BY lineIdx ASC FOR UPDATE',
        [receiptId, spA, spB],
    );
    if (!itemRows?.length) return false;
    const chainId = await getReceiptChainId(receiptId, conn);

    for (const row of itemRows) {
        const line = itemToLine(row);
        const lineSp = Number(line?.storeProductId);
        if (!Number.isFinite(lineSp) || lineSp <= 0) continue;
        const other = lineSp === spA ? spB : spA;
        const alts = Array.isArray(line.altMatches) ? line.altMatches : [];
        const top = alts[0];
        // Only when the rejected SP is the line's PRIMARY identity source (top
        // altMatch) AND the line's SP is a DISTINCT id (a bootstrapped/cross-chain
        // mint). A same-chain line whose SP IS its top altMatch is a self-pair —
        // a different rejection path (see demoteReceiptLineDirect).
        if (!top || Number(top.storeProductId) !== other || lineSp === Number(top.storeProductId)) continue;

        await applyDemotion(receiptId, line, /* rejectedSpId */ other, lineSp, alts, chainId, conn);
        await syncReceiptItemMatchState(receiptId, Number(row.lineIdx), line, conn);
        return true;
    }
    return false;
}

/**
 * Direct rejection of a line's OWN match (the "is this the right product? No" /
 * self-pair gesture): demote the line at `lineIdx` regardless of which SP the
 * vote names. Same re-point-runner-up-else-OCR effect.
 */
export async function demoteReceiptLineDirect(
    receiptId: number,
    lineIdx: number,
    conn: Connection,
): Promise<any | null> {
    // Read the line from its ReceiptItem row (source of truth) FOR UPDATE; chainId from the
    // receipt header. Single-row UPDATE, no whole-blob rewrite.
    const [itemRows]: any = await conn.query('SELECT * FROM ReceiptItem WHERE receiptId = ? AND lineIdx = ? FOR UPDATE', [receiptId, lineIdx]);
    const row = itemRows?.[0];
    if (!row) return null;
    const line = itemToLine(row);
    const lineSp = Number(line.storeProductId);
    if (!Number.isFinite(lineSp) || lineSp <= 0) return null; // nothing matched to reject
    const alts = Array.isArray(line.altMatches) ? line.altMatches : [];

    await applyDemotion(receiptId, line, /* rejectedSpId */ lineSp, lineSp, alts, await getReceiptChainId(receiptId, conn), conn);
    await syncReceiptItemMatchState(receiptId, lineIdx, line, conn);
    return line; // the mutated line, so the caller can return it for an instant UI update
}

/**
 * Re-point the line to its best SAME-CHAIN runner-up altMatch (≥ auto-apply), else
 * clear it to OCR with a `userRejected` veto. Mutates `line` in place.
 */
async function applyDemotion(
    receiptId: number,
    line: any,
    rejectedSpId: number,
    lineSp: number,
    alts: any[],
    chainId: number,
    conn: Connection,
): Promise<void> {
    const runnerUp = alts
        .filter((a) => {
            const sid = Number(a?.storeProductId);
            return sid > 0 && sid !== rejectedSpId && sid !== lineSp && Number(a?.confidence) >= RECOGNITION.match.autoApplyThreshold;
        })
        .sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];

    if (runnerUp && Number.isFinite(chainId) && chainId > 0) {
        const sid = Number(runnerUp.storeProductId);
        // Only re-point to a runner-up that is ALREADY a valid same-chain SP — no
        // bootstrap/re-resolution inside the vote path. Cross-chain runner-ups → OCR.
        const [r]: any = await conn.query('SELECT chainId FROM StoreProduct WHERE id = ?', [sid]);
        if (r?.[0] && Number(r[0].chainId) === chainId) {
            line.storeProductId = sid;
            line.matchedName = runnerUp.name ?? null;
            line.storeProductImageUrl = runnerUp.imageUrl ?? null;
            line.matchConfidence = Number(runnerUp.confidence);
            line.matchConfirmed = true;
            // Line-level category follows the NEW pick so the receipt summary's
            // breakdown stops showing the rejected match's category (the runner-up
            // re-point keeps matchConfirmed=true, so the breakdown still reads the
            // line — it must read the line's OWN category, not the stale altMatches[0]).
            line.categoryId = runnerUp.categoryId ?? null;
            line.categoryName = runnerUp.categoryName ?? null;
            line.categoryL2Name = runnerUp.categoryL2Name ?? null;
            line.priceVerified = false; // Round-2 hasn't confirmed the new pick's price
            line.itemConfidence = computeItemConfidence({
                nameConf: Number(runnerUp.confidence),
                nameText: typeof line.name === 'string' ? line.name : '',
                priceVerified: false,
                viaPromo: false,
                gapToRunnerUp: 0,
                source: 'reused',
                priceImplausible: false,
                userRejected: false, // the runner-up is a fresh, un-rejected pick
            });
            return;
        }
    }

    // No same-chain runner-up. NO-MINT (P3): the receipt never creates an SP/Product. Mark
    // the rejected match's Price UNVERIFIED so a wrong match can't pollute comparison, then
    // fall through to OCR-only below. (Previously this minted a quarantined orphan SP to carry
    // the price; under the no-mint policy the observation lives on the ReceiptItem instead.)
    if (Number.isFinite(chainId) && chainId > 0 && Number.isFinite(Number(line.price)) && Number(line.price) > 0) {
        await conn.query(
            `UPDATE Price SET priceVerified = 0
              WHERE isFallback = 0
                AND (receiptItemId IN (SELECT id FROM ReceiptItem WHERE receiptId = ? AND matchedSpId = ?)
                     OR (receiptItemId IS NULL AND receiptId = ? AND storeProductId = ?))`,
            [receiptId, lineSp, receiptId, lineSp],
        );
    }

    // Fall back to OCR-only + userRejected veto (garbled price, no chain, no runner-up).
    line.storeProductId = null;
    line.matchedName = null;
    line.storeProductImageUrl = null;
    line.matchConfirmed = false;
    line.priceVerified = false;
    line.categoryId = null;
    line.categoryName = null;
    line.categoryL2Name = null;
    line.itemConfidence = computeItemConfidence({
        nameConf: null,
        nameText: typeof line.name === 'string' ? line.name : '',
        priceVerified: false,
        viaPromo: false,
        gapToRunnerUp: 0,
        source: 'none',
        priceImplausible: false,
        userRejected: true,
    });
}
