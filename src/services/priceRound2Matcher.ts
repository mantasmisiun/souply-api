import pool from '../config/db.js';
import { getAsOfDatePricesForCandidates, getChainSpsByRegularPrice, countPriceRowsNearValue } from '../models/priceModel.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { scoreNameRelaxed } from '../utils/productMatcher.js';

type Connection = typeof pool | any;

/**
 * Round-2 (PRICE-based) receipt-product matching.
 *
 * Round 1 (name-fuzzy) returns ≤3 same-chain candidates per line (`altMatches`),
 * auto-applying the top one. Where the top variants are tied on NAME — most often
 * same-name different-PACK-SIZE (NAMINIS pienas 1L / 2L / 500ml; LYDYTAS sūris
 * 185g / 370g) — the name can't separate them but the PRICE can. Round 2 looks up
 * each candidate's as-of-receipt-date CHAIN price history and confirms the
 * candidate whose stored price matches what the receipt actually paid.
 *
 * Design (all 7 decisions resolved, see project_price_round_matching memory):
 *  - SAME-CHAIN candidates only (cross-chain fallbacks have no comparable price —
 *    the lookup's chainId filter drops them).
 *  - Compare the receipt's observed price(s) to the candidate's stored regular OR
 *    active-promo price; ±€0.01 / ~1% tolerance (weekly-snapshot drift).
 *  - For WEIGHABLE lines compare €/kg (`pricePerUnit`), NEVER the line total —
 *    the total is for a fraction of a kg (~1000× off; cf. the weighed-item guard).
 *  - ≥1 match → confirm + flag `priceVerified` (improves the cost-elsewhere
 *    comparison for free). ≥2 matches → the one with the highest Round-1 name
 *    confidence wins (price-match + best-name, not a hard fall-back).
 *  - Ignore coupon-gating; all discounts equal (coupon discounts are excluded
 *    upstream already).
 *  - FAIL-OPEN: no history / no match / garbled price / unit mismatch → the
 *    Round-1 pick is left exactly as-is. Round 2 is a confirmer, never a gate.
 *
 * It is also a REJECTER (negative signal). When NO candidate price-confirms and
 * the current pick's REGULAR price is EXTREME vs its known chain price (outside
 * [0.4×, 2.5×] — a gap no sale/snapshot explains, e.g. a €5 item matched to a €25
 * product), the name match is almost certainly wrong. Round 2 then either RE-PICKS
 * a price-plausible, name-competitive sibling (drops the bad candidate), or — if
 * none — flags the line so the save loop SKIPS its price write (protects the wrong
 * SP's reference price). The REGULAR price is the anchor; the discount is only a
 * CONFIRM signal (it varies week-to-week, so it never drives a rejection).
 *
 * Mutates `parsedProducts[i]` in place (storeProductId / priceVerified /
 * matchConfirmed). Must run BEFORE the line resolver (so a re-picked SP flows
 * through the same same-chain reuse path) and BEFORE this receipt's own Price
 * rows are written (the lookup also excludes this receipt's rows by id).
 */
export interface Round2Result {
    /** lines where some candidate price-matched (now priceVerified). */
    confirmed: number;
    /** subset of `confirmed` where the winning SP differs from the Round-1 pick. */
    overridden: number;
    /**
     * Per-line detail for the PERFECT (price-confirmed) matches, keyed by the
     * line index. The save flow uses this to print a "MATCH vs PERFECT MATCH"
     * summary. `from` is the pre-Round-2 (name) pick, so a changed pick is
     * visible (name→SP `from`, price→SP `spId`).
     */
    perfect: Map<number, { spId: number; viaPromo: boolean; conf: number; from: number | null }>;
    /**
     * Lines whose name match is PRICE-IMPLAUSIBLE (the receipt's regular price is
     * wildly off the matched SP's known price) AND no plausible sibling existed —
     * the save flow SKIPS the price write for these so a wrong SP's reference
     * price isn't poisoned. The display match is left as-is (conservative).
     */
    rejected: Set<number>;
    /**
     * Lines where the implausible name pick was DROPPED for a price-plausible,
     * name-competitive sibling. line index → the swap detail (for the log).
     */
    repicked: Map<number, { spId: number; from: number | null; conf: number; name: string }>;
}

// Round 2 may only OVERRIDE the Round-1 name pick when the price-matching
// candidate's NAME confidence is within this much of the current pick — i.e. they
// were genuinely name-TIED (pack-size disambiguation). A larger gap means the
// price-matcher is a different product that merely shares a price (two tomato
// varieties), and a confident name match must NOT be overridden on that.
const NAME_TIE_DELTA = RECOGNITION.price.nameTieDelta;

// PRICE-IMPLAUSIBILITY band (REGULAR price only). A receipt regular price outside
// [0.4×, 2.5×] of the matched SP's known regular price is a gap no sale, weekly
// snapshot, or rounding explains — it signals a WRONG match (a €5 item matched to
// a €25 product, or vice-versa). Inside the band, anything goes (fail-open): a 50%
// sale, a recent price change, multi-buy noise. Discounts are NOT used to reject
// (they vary week-to-week); a discount that matched would have CONFIRMED already.
const REJECT_LOW = RECOGNITION.price.rejectLow;
const REJECT_HIGH = RECOGNITION.price.rejectHigh;

// ±€0.01 absolute OR ~1% relative — weekly snapshots drift slightly, and a cent
// of rounding is normal between a scraped price and a printed receipt line.
const priceClose = (observed: number[], target: number | null | undefined): boolean => {
    if (target == null || !(target > 0)) return false;
    const tol = Math.max(RECOGNITION.price.priceCloseAbs, target * RECOGNITION.price.priceCloseRel);
    return observed.some((o) => o > 0 && Math.abs(o - target) <= tol);
};

export const applyPriceRound2Matching = async (
    parsedProducts: any[],
    chainId: number,
    receiptDate: Date,
    receiptId: number,
    conn?: Connection,
): Promise<Round2Result> => {
    const res: Round2Result = { confirmed: 0, overridden: 0, perfect: new Map(), rejected: new Set(), repicked: new Map() };
    if (!Number.isFinite(chainId) || !Array.isArray(parsedProducts) || parsedProducts.length === 0) {
        return res;
    }

    // 1. Collect every Round-1 candidate id across all lines for a single lookup.
    const candidateIds = new Set<number>();
    for (const line of parsedProducts) {
        const alt = Array.isArray(line?.altMatches) ? line.altMatches : [];
        for (const am of alt) {
            const id = Number(am?.storeProductId);
            if (Number.isFinite(id) && id > 0) candidateIds.add(id);
        }
    }
    if (candidateIds.size === 0) return res;

    // 2. One chain-wide, as-of-date price lookup (excludes this receipt's rows).
    const priceMap = await getAsOfDatePricesForCandidates(
        [...candidateIds], chainId, receiptDate, receiptId, conn,
    );
    if (priceMap.size === 0) return res;

    // 3. Per line: the highest-confidence candidate whose stored price matches.
    for (let i = 0; i < parsedProducts.length; i++) {
        const line = parsedProducts[i];
        const alt = Array.isArray(line?.altMatches) ? line.altMatches : [];
        if (alt.length === 0) continue;

        // Observed receipt price(s). Weighable → €/kg only (never the line total).
        // `regObs` is the REGULAR unit price (the rejection anchor); `observed`
        // also carries the discounted price so a promo can CONFIRM.
        const weighed = (!!line?.isWeighable || line?.unit === 'kg') && Number(line?.pricePerUnit) > 0;
        const regObs = weighed ? Number(line.pricePerUnit) : Number(line?.price);
        const promoObs = Number(line?.promoPrice) > 0 ? Number(line.promoPrice) : null;
        const observed: number[] = [];
        if (weighed) {
            observed.push(Number(line.pricePerUnit));
            // Weighed promo is €/kg too (weighed-item representation) — include it so an
            // active DB promo can confirm a discounted weighed line, same as packaged ones.
            if (promoObs != null) observed.push(promoObs);
        } else {
            if (Number(line?.price) > 0) observed.push(Number(line.price));
            if (promoObs != null) observed.push(promoObs);
        }
        if (observed.length === 0) continue;
        // The line VISIBLY paid a discount (promo below its own printed regular). Used by the
        // promo-consistency gate below.
        const lineDiscounted = promoObs != null && regObs > 0 && promoObs < regObs - 0.005;

        const prev = Number.isFinite(line?.storeProductId) ? Number(line.storeProductId) : null;
        const prevAlt = prev != null ? alt.find((am: any) => Number(am?.storeProductId) === prev) : null;
        const prevConf = prevAlt && Number.isFinite(prevAlt.confidence) ? Number(prevAlt.confidence) : null;

        // Classify candidates: price-CONFIRMERS (regular or promo match) and the
        // price-PLAUSIBLE set (regular within the sane band — used to re-pick away
        // from an implausible match without inventing a price-coincidence match).
        const matchers: Array<{ am: any; spId: number; conf: number; viaPromo: boolean }> = [];
        const plausible: Array<{ am: any; spId: number; conf: number }> = [];
        for (const am of alt) {
            const spId = Number(am?.storeProductId);
            if (!Number.isFinite(spId) || spId <= 0) continue;
            const db = priceMap.get(spId);
            if (!db) continue; // no history / cross-chain candidate → skip
            const conf = Number.isFinite(am?.confidence) ? Number(am.confidence) : 0;
            // Regular price in the sane band? (anchor — discounts vary, regulars don't)
            let regInBand = true;
            if (regObs > 0 && db.price > 0) {
                const r = regObs / db.price;
                regInBand = r >= REJECT_LOW && r <= REJECT_HIGH;
                if (regInBand) plausible.push({ am, spId, conf });
            }
            const regMatch = priceClose(observed, db.price);
            const promoActive = db.promoPrice != null && (db.promoEnd == null || db.promoEnd >= receiptDate);
            const promoMatch = promoActive && priceClose(observed, db.promoPrice);
            // A price match only CONFIRMS when the regular price isn't extreme — a
            // discount that matches a wildly-different regular is a coincidence, and
            // the regular price is the identity anchor (per the discount-vs-regular
            // rule). So a 5×-off regular can never be rescued by a matching promo.
            //
            // PROMO-CONSISTENCY: a line that visibly paid a DISCOUNT can only be
            // confirmed by a candidate whose price row shows an ACTIVE promo — a
            // promo-less (often stale/fallback) row that happens to share the regular
            // is a coincidence, not a confirmation (receipt-237 salmon: an April
            // fallback row at the same 16.99 regular "confirmed" a discounted line,
            // promoted the wrong SP and laundered priceVerified). Undiscounted lines
            // keep confirming on the regular alone.
            if ((regMatch || promoMatch) && regInBand && (!lineDiscounted || promoActive)) {
                matchers.push({ am, spId, conf, viaPromo: !regMatch && promoMatch });
            }
        }

        if (matchers.length === 0) {
            // ----- REJECT: no candidate price-confirmed. If the CURRENT pick's
            // REGULAR price is EXTREME vs its known chain price (a gap no sale /
            // snapshot explains), the name match is price-implausible. Prefer a
            // price-plausible, name-competitive sibling (drop the bad candidate);
            // else protect the data by skipping this line's price write. -----
            if (prev == null) continue;
            const prevDb = priceMap.get(prev);
            if (!prevDb || !(prevDb.price > 0) || !(regObs > 0)) continue; // no price data → fail-open
            const rPrev = regObs / prevDb.price;
            if (rPrev >= REJECT_LOW && rPrev <= REJECT_HIGH) continue;     // plausible gap → fail-open

            const pb = plausible
                .filter((p) => p.spId !== prev)
                .reduce((a, b) => (a == null || b.conf > a.conf ? b : a), null as { am: any; spId: number; conf: number } | null);
            if (pb && (prevConf == null || pb.conf >= prevConf - NAME_TIE_DELTA)) {
                line.storeProductId = pb.spId;
                if (pb.am?.name) line.matchedName = pb.am.name;
                if (Number.isFinite(pb.am?.confidence)) line.matchConfidence = Number(pb.am.confidence);
                line.matchConfirmed = true;
                res.repicked.set(i, { spId: pb.spId, from: prev, conf: pb.conf, name: pb.am?.name ?? '' });
            } else {
                res.rejected.add(i); // skip the price write; keep the display match
            }
            continue;
        }

        // Pick: if the CURRENT (name) pick itself price-matches → confirm it, never
        // move. Otherwise take the highest-name-confidence price-matcher, but only
        // OVERRIDE a confident current pick when the two are name-TIED (genuine
        // pack-size disambiguation, e.g. NAMINIS 1L/2L). A price-matcher that's a
        // much WEAKER name match is a different product that merely shares a price
        // (two tomato varieties) — never override a confident name pick on that.
        const currentMatch = matchers.find((m) => m.spId === prev);
        let chosen: { am: any; spId: number; conf: number; viaPromo: boolean };
        if (currentMatch) {
            chosen = currentMatch;
        } else {
            const top = matchers.reduce((a, b) => (b.conf > a.conf ? b : a));
            if (prevConf != null && top.conf < prevConf - NAME_TIE_DELTA) {
                continue; // GAP GUARD: keep the confident name pick (leave unverified)
            }
            chosen = top;
        }

        const changed = chosen.spId !== prev;
        res.confirmed++;
        if (changed) {
            res.overridden++;
            line.storeProductId = chosen.spId;
            // Keep the DISPLAY in lock-step with the linked SP so the Items tab never
            // shows one product while the data points at another. altMatch carries the
            // catalog name + confidence (not the image — same-product pack-size
            // variants share a photo, so the existing thumbnail is left as-is).
            if (chosen.am?.name) line.matchedName = chosen.am.name;
            if (Number.isFinite(chosen.am?.confidence)) line.matchConfidence = Number(chosen.am.confidence);
        }
        line.matchConfirmed = true;
        line.priceVerified = true;
        res.perfect.set(i, { spId: chosen.spId, viaPromo: chosen.viaPromo, conf: chosen.conf, from: prev });
    }
    return res;
};

/**
 * Round-2.5 — PRICE-SCOPED RESCUE FISHING for lines that are still UNLINKED after
 * Rounds 1 (name) and 2 (price rerank). Round 2 can only rerank what Round 1 found;
 * when the CORRECT SP never entered the candidate list (Lithuanian inflection + OCR
 * garble pushing its tokens under the strict floor — receipt-237 salmon), the line
 * dead-ends. This pass inverts the search: fish same-chain SPs whose REGULAR price
 * (the stable identity anchor; promos churn weekly) matches the line's printed
 * regular (€/kg for weighed) within tolerance and a ±window around the receipt
 * date, then re-score names at the relaxed floor WITHIN that small price-vetted
 * pool only. Survivors are APPENDED to `line.altMatches` (flagged `viaPrice`) —
 * never auto-linked — so the proposed-card swipe can ask the user; one confirm
 * teaches the vocabulary alias and the next receipt matches directly.
 *
 * Mutates `parsedProducts[i].altMatches` in place. Fail-open per line. Must run
 * AFTER applyPriceRound2Matching (so a Round-2 promotion wins first) and BEFORE
 * the resolver / swipe-candidate + ReceiptItem writes (so fished entries persist).
 */
export const fishPriceScopedCandidates = async (
    parsedProducts: any[],
    chainId: number,
    receiptDate: Date,
    receiptId: number,
    conn?: Connection,
): Promise<number> => {
    if (!Number.isFinite(chainId) || !Array.isArray(parsedProducts)) return 0;
    const F = RECOGNITION.price;
    let fished = 0;
    // Fishing runs INSIDE the save request — a hard time budget caps the whole pass
    // (receipt-238: two slow pool queries pushed the save past the client timeout).
    const startedAt = Date.now();
    for (const line of parsedProducts) {
        if (!line || (Number.isFinite(line.storeProductId) && Number(line.storeProductId) > 0)) continue;
        if (!line?.name || typeof line.name !== 'string' || !line.name.trim()) continue;
        if (Date.now() - startedAt > F.fishTimeBudgetMs) {
            console.log(`[price-fish] time budget (${F.fishTimeBudgetMs}ms) exhausted — skipping remaining unmatched lines`);
            break;
        }
        const weighed = (!!line?.isWeighable || line?.unit === 'kg') && Number(line?.pricePerUnit) > 0;
        const regObs = weighed ? Number(line.pricePerUnit) : Number(line?.price);
        if (!(regObs > 0)) continue;
        const promoObs = Number(line?.promoPrice) > 0 ? Number(line.promoPrice) : null;
        const lineDiscounted = promoObs != null && promoObs < regObs - 0.005;
        try {
            const existing = Array.isArray(line.altMatches) ? line.altMatches : [];
            const excludeIds = existing
                .map((am: any) => Number(am?.storeProductId))
                .filter((n: number) => Number.isFinite(n) && n > 0);
            // SELECTIVITY gate: a super-common price point (1.99 matches 500k+ Price
            // rows in the window) carries no identity signal — and its pool query is
            // the expensive kind. Bounded index-range count (~30-90ms) decides.
            const nearRows = await countPriceRowsNearValue(
                regObs, F.fishPriceTolAbs, receiptDate, F.fishWindowDays,
                F.fishSelectivityMaxRows, conn,
            );
            if (nearRows > F.fishSelectivityMaxRows) {
                console.log(`[price-fish] "${line.name}" reg=${regObs.toFixed(2)} → SKIP (non-selective anchor: >${F.fishSelectivityMaxRows} price rows share it)`);
                continue;
            }
            // Tight ABSOLUTE anchor (not the Round-2 1% relative confirm tolerance):
            // regulars print to the cent, and at common price points a relative band
            // floods the pool with unrelated products. A DISCOUNTED line additionally
            // requires promo-bearing anchor rows — real-world evidence the product was
            // on promotion, which cuts a common price point down by an order of magnitude.
            const pool = await getChainSpsByRegularPrice(
                chainId, regObs, F.fishPriceTolAbs, receiptDate, F.fishWindowDays,
                receiptId, excludeIds, F.fishPoolMax, lineDiscounted, conn,
            );
            if (pool.length === 0) continue;
            const scored = pool
                .map((c) => ({ c, score: scoreNameRelaxed(line.name, c.name) }))
                .filter((s) => s.score >= F.fishMinNameScore)
                .sort((a, b) => b.score - a.score)
                .slice(0, F.fishMaxPerLine);
            if (scored.length === 0) continue;
            line.altMatches = [
                ...existing,
                ...scored.map(({ c, score }) => ({
                    storeProductId: c.storeProductId,
                    productId: c.productId,
                    categoryId: c.categoryId,
                    categoryName: c.categoryName,
                    categoryL2Name: c.categoryL2Name,
                    name: c.name,
                    brandName: c.brandName,
                    amount: c.amount,
                    unit: c.unit,
                    isWeighable: c.isWeighable,
                    confidence: Math.round(score * 100) / 100,
                    isCatalog: c.isCatalog,
                    viaPrice: true,
                })),
            ];
            fished++;
            console.log(
                `[price-fish] "${line.name}" reg=${regObs.toFixed(2)} → +${scored.length}: `
                + scored.map((s) => `sp=${s.c.storeProductId} "${s.c.name}" name≈${s.score.toFixed(2)}`).join(' | '),
            );
        } catch (e) {
            console.warn('[price-fish] line skipped (non-fatal):', (e as Error)?.message ?? e);
        }
    }
    return fished;
};
