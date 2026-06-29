import type { Connection } from 'mysql2/promise';
import { computeItemConfidence } from './itemConfidence.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { createProduct } from '../models/productModel.js';
import { createStoreProduct } from '../models/storeProductModel.js';
import { getUnassignedCategoryId } from './receiptLineResolver.js';

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
    const [rows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ? FOR UPDATE', [receiptId]);
    const raw = rows?.[0]?.parsedData;
    if (!raw) return false;
    let parsed: any;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return false;
    }
    const products = parsed?.products;
    if (!Array.isArray(products)) return false;
    const chainId = Number(parsed?.header?.chainId);

    for (const line of products) {
        const lineSp = Number(line?.storeProductId);
        if (!Number.isFinite(lineSp) || lineSp <= 0) continue;
        if (lineSp !== spA && lineSp !== spB) continue;
        const other = lineSp === spA ? spB : spA;
        const alts = Array.isArray(line.altMatches) ? line.altMatches : [];
        const top = alts[0];
        // Only when the rejected SP is the line's PRIMARY identity source (top
        // altMatch) AND the line's SP is a DISTINCT id (a bootstrapped/cross-chain
        // mint). A same-chain line whose SP IS its top altMatch is a self-pair —
        // a different rejection path (see demoteReceiptLineDirect).
        if (!top || Number(top.storeProductId) !== other || lineSp === Number(top.storeProductId)) continue;

        await applyDemotion(receiptId, line, /* rejectedSpId */ other, lineSp, alts, chainId, conn);
        await conn.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(parsed), receiptId]);
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
    const [rows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ? FOR UPDATE', [receiptId]);
    const raw = rows?.[0]?.parsedData;
    if (!raw) return null;
    let parsed: any;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    const line = parsed?.products?.[lineIdx];
    if (!line) return null;
    const lineSp = Number(line.storeProductId);
    if (!Number.isFinite(lineSp) || lineSp <= 0) return null; // nothing matched to reject
    const alts = Array.isArray(line.altMatches) ? line.altMatches : [];

    await applyDemotion(receiptId, line, /* rejectedSpId */ lineSp, lineSp, alts, Number(parsed?.header?.chainId), conn);
    await conn.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(parsed), receiptId]);
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

    // No same-chain runner-up. Decision 5: rather than discard the data, mint a fresh
    // QUARANTINED ORPHAN — its own uncategorised Product + SP, KEEPING the price but
    // excluded from comparison (a lone orphan has no peers) until swipes give it a
    // category + peers. A garbled / price≤0 line still creates NOTHING (the poisoning
    // guard) and clears to OCR below.
    const ocrName = typeof line.name === 'string' && line.name.trim() ? line.name.trim() : '?';
    const linePrice = Number(line.price);
    if (Number.isFinite(chainId) && chainId > 0 && Number.isFinite(linePrice) && linePrice > 0) {
        try {
            const categoryId = await getUnassignedCategoryId(conn);
            const productId = await createProduct(categoryId, null, ocrName, conn);
            const newSpId = await createStoreProduct(
                productId,
                chainId,
                ocrName,
                null,
                !!line.isWeighable,
                Number.isFinite(line.amount) ? Number(line.amount) : null,
                typeof line.sizeUnit === 'string' ? line.sizeUnit : (typeof line.unit === 'string' ? line.unit : null),
                null,
                conn,
            );
            // Move the recorded price onto the orphan, UNVERIFIED (a lone orphan can't
            // be compared, so it can never pollute comparisons — yet the data isn't lost).
            await conn.query(
                'UPDATE Price SET storeProductId = ?, priceVerified = 0 WHERE receiptId = ? AND storeProductId = ? AND isFallback = 0',
                [newSpId, receiptId, lineSp],
            );
            line.storeProductId = newSpId;
            line.matchedName = null;
            line.storeProductImageUrl = null;
            line.matchConfidence = null;
            line.matchConfirmed = false;
            line.priceVerified = false;
            line.itemConfidence = computeItemConfidence({
                nameConf: null,
                nameText: ocrName,
                priceVerified: false,
                viaPromo: false,
                gapToRunnerUp: 0,
                source: 'created',
                priceImplausible: false,
            });
            return;
        } catch {
            // Any mint failure → fall through to the OCR-clear below (fail-safe).
        }
    }

    // Fall back to OCR-only + userRejected veto (garbled price, no chain, or mint failed).
    line.storeProductId = null;
    line.matchedName = null;
    line.storeProductImageUrl = null;
    line.matchConfirmed = false;
    line.priceVerified = false;
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
