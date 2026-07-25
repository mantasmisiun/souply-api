import { RECOGNITION } from '../../../shared/recognitionConfig.js';

/**
 * RECEIPT HEAL — consensus merge of a RETAKE against the stored parse.
 *
 * A receipt only EXISTS once its identity (chain + date + number + total) cleared
 * the capture gate, so the header is trustworthy and only the LINE ITEMS are
 * partially garbled. A retake is therefore a SECOND observation of the same
 * receipt: we align the two parsed line-lists and heal — never replace.
 *
 * The core is a price-anchored SEQUENCE ALIGNMENT (a diff over parsed lines,
 * gaps allowed), then a conservative field-level best-of with ONE rule:
 *   never downgrade — a line that was already good is only ever improved.
 * Inserts the retake recovers are validated against the receipt TOTAL (checksum):
 * a missed line is trusted when it helps close the line-sum-vs-total gap.
 *
 * This module is PURE (no DB): it takes normalized lines + the total and returns
 * a plan. The endpoint maps ReceiptItems / candidate products onto HealLine, and
 * applies the plan (kept lines untouched → matches/votes/swipes survive; only
 * healed/inserted lines re-match + re-swipe).
 */

const CFG = RECOGNITION.retake;

/** A parsed line, from either the stored parse or the retake. `ref` is the
 *  caller's back-reference (ReceiptItem id, or candidate array index). */
export interface HealLine<R = unknown> {
    /** Printed comparable amount (line total) — the primary alignment key. */
    price: number;
    quantity: number;
    name: string;
    /** Has a product match (storeProductId). */
    matched: boolean;
    /** User-confirmed match — a heal never downgrades it. */
    confirmed: boolean;
    /** Parser confidence 0..1. */
    confidence: number;
    /** OCR/price sanity veto → the line is suspect. */
    implausible: boolean;
    ref?: R;
}

// ── name helpers ─────────────────────────────────────────────────────────────

const normalizeName = (s: string | null | undefined): string =>
    (s ?? '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');

const nameTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of normalizeName(s).split(' ')) if (w.length >= 3) out.add(w);
    return out;
};

/** Token overlap coefficient 0..1 (shared ÷ smaller side). */
const nameSimilarity = (a: string, b: string): number => {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    return shared / Math.min(ta.size, tb.size);
};

/** A name is usable if it carries a real ≥3-letter word (not OCR confetti). */
export const hasUsableName = (s: string | null | undefined): boolean =>
    /[a-zÀ-ɏ]{3,}/i.test((s ?? ''));

/** A line is UNREADABLE (retake-worthy) — no usable name, non-positive price, or
 *  an OCR/price veto. Unmatched-but-clean lines are NOT unreadable. */
export const isUnreadable = (l: HealLine): boolean =>
    !hasUsableName(l.name) || !(l.price > 0) || l.implausible;

/** Higher = better line. Drives never-downgrade + per-field best-of. */
const lineQuality = (l: HealLine): number => {
    let q = 0;
    if (l.confirmed) q += 3;
    else if (l.matched) q += 2;
    q += Math.max(0, Math.min(1, l.confidence));
    if (l.implausible) q -= 2;
    if (!hasUsableName(l.name)) q -= 2;
    if (!(l.price > 0)) q -= 1;
    return q;
};

/** Just the name's own trustworthiness (usable + matched + confidence). */
const nameQuality = (l: HealLine): number =>
    (hasUsableName(l.name) ? 1 : 0) + (l.matched ? 1 : 0) + Math.max(0, Math.min(1, l.confidence));

const priceClose = (a: number, b: number): boolean =>
    Math.abs(a - b) <= Math.max(CFG.priceMatchAbsEur, CFG.priceMatchFrac * Math.max(Math.abs(a), Math.abs(b)));

// ── quality flag (the payload's `lowQuality` / `unreadableCount`) ─────────────

export interface QualityAssessment {
    unreadableCount: number;
    unmatchedCount: number;
    lineCount: number;
    lowQuality: boolean;
}

/** Assess a stored parse: enough UNREADABLE lines, most lines UNMATCHED (a strong
 *  bad-scan signal), or a big reconciliation gap vs the printed `total` (null →
 *  gap check skipped). */
export const assessQuality = (
    lines: HealLine[],
    total: number | null,
    /** Receipt-level set-deal discount (IKI "RINKINYS"). It is deducted at the
     *  FOOTER, never from the line prices, so the line sum legitimately exceeds
     *  the printed total by exactly this much. Without subtracting it a perfectly
     *  captured receipt looks broken — a €2.35 receipt with a €1.90 set deal
     *  showed a 71 % gap and raised the "Perfotografuoti" retake banner on a scan
     *  whose every line was correct and matched. */
    comboDiscount: number | null = null,
): QualityAssessment => {
    const lineCount = lines.length;
    const unreadableCount = lines.filter(isUnreadable).length;
    const unmatchedCount = lines.filter((l) => !l.matched).length;
    const fracUnreadable = lineCount > 0 ? unreadableCount / lineCount : 0;
    const fracUnmatched = lineCount > 0 ? unmatchedCount / lineCount : 0;
    let gapTrips = false;
    if (total != null && total > 0) {
        const combo = comboDiscount != null && comboDiscount > 0 ? comboDiscount : 0;
        const sum = lines.reduce((s, l) => s + (l.price > 0 ? l.price : 0), 0) - combo;
        gapTrips = Math.abs(total - sum) / total > CFG.reconcileGapFrac;
    }
    return {
        unreadableCount,
        unmatchedCount,
        lineCount,
        lowQuality: lineCount > 0
            && (fracUnreadable >= CFG.unreadableLineFrac
                || fracUnmatched >= CFG.unmatchedLineFrac
                || gapTrips),
    };
};

// ── same-receipt guard ───────────────────────────────────────────────────────

export interface ReceiptIdentity {
    chainId: number | null;
    receiptNo: string | null;
    /** ALL printed forms of the id (IKI: composite "Kvito Nr. 168/645/104148", VMI
     *  "Kvito numeris 104148", "Kvitas 3157", + a deterministic date+time+total synthetic).
     *  A retake that garbles ONE form (redaction clipping the composite) still matches on
     *  another — the same set duplicate detection uses. Falls back to [receiptNo]. */
    receiptNos?: string[] | null;
    date: string | null;   // "YYYY-MM-DD..." — compared by day
    total: number | null;
}

const dayOf = (d: string | null): string | null => (d ? String(d).slice(0, 10) : null);

/** Receipt ids worth matching on: composite (has '/') or ≥6 digits — filters short/noise
 *  ids like "3157". Mirrors receiptModel.isDistinctiveReceiptNo (the dedup path). */
const distinctiveReceiptIds = (idty: ReceiptIdentity): string[] => {
    const arr = idty.receiptNos && idty.receiptNos.length
        ? idty.receiptNos
        : (idty.receiptNo ? [idty.receiptNo] : []);
    return [...new Set(
        arr.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
           .filter((v) => v.includes('/') || v.replace(/\D/g, '').length >= 6),
    )];
};

/** Two printed ids are the same number if equal, or one's digit-string is a suffix of the
 *  other's (≥6 digits): the VMI "104148" is the tail of the composite "168/645/104148". */
const receiptIdsMatch = (x: string, y: string): boolean => {
    if (x === y) return true;
    const dx = x.replace(/\D/g, ''), dy = y.replace(/\D/g, '');
    return dx.length >= 6 && dy.length >= 6 && (dx.endsWith(dy) || dy.endsWith(dx));
};

/** Is the retake the SAME physical receipt? Hard NO on a chain/date/total contradiction.
 *  Receipt-number agreement is checked across ALL printed forms (receiptNos), so a retake
 *  that mis-read one form still matches on another; if BOTH sides produced distinctive ids
 *  yet none overlap, that's a genuinely different receipt. When a field is missing it can't
 *  disprove identity — but at least one strong signal (any id overlap, or chain+date) must
 *  positively agree. */
export const isSameReceipt = (a: ReceiptIdentity, b: ReceiptIdentity): boolean => {
    if (a.chainId != null && b.chainId != null && a.chainId !== b.chainId) return false;
    const da = dayOf(a.date), db = dayOf(b.date);
    if (da && db && da !== db) return false;
    if (a.total != null && b.total != null && a.total > 0 && b.total > 0
        && Math.abs(a.total - b.total) / Math.max(a.total, b.total) > CFG.sameReceiptTotalFrac) return false;
    const aIds = distinctiveReceiptIds(a), bIds = distinctiveReceiptIds(b);
    const idsOverlap = aIds.some((x) => bIds.some((y) => receiptIdsMatch(x, y)));
    if (idsOverlap) return true;                             // any shared printed form → same
    // Both scans produced distinctive ids yet NONE match → genuinely different receipts.
    if (aIds.length > 0 && bIds.length > 0) return false;
    // Neither side offered a distinctive id to arbitrate — fall back to the raw canonical id.
    if (a.receiptNo && b.receiptNo && a.receiptNo !== b.receiptNo) return false;
    return a.chainId != null && b.chainId != null && a.chainId === b.chainId && !!da && !!db && da === db;
};

// ── sequence alignment (price-first Needleman–Wunsch over parsed lines) ───────

type AlignOp =
    | { type: 'match'; i: number; j: number }
    | { type: 'del'; i: number }    // existing-only — the retake missed it
    | { type: 'ins'; j: number };   // candidate-only — the stored parse missed it

/** Similarity of a candidate pair. Price agreement is the backbone; name overlap
 *  lifts it. A pair that agrees on neither price nor name is a poor match (< 0),
 *  so the DP prefers gaps over pairing unrelated lines. */
const pairScore = <R>(e: HealLine<R>, c: HealLine<R>): number => {
    const priceOk = e.price > 0 && c.price > 0 && priceClose(e.price, c.price);
    const sim = nameSimilarity(e.name, c.name);
    if (!priceOk && sim < CFG.nameSimFloor) return -1;
    return (priceOk ? 2 : 0) + sim;
};

const alignLines = <R>(existing: HealLine<R>[], candidate: HealLine<R>[]): AlignOp[] => {
    const n = existing.length, m = candidate.length;
    const gap = -CFG.alignGapPenalty;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) dp[i][0] = i * gap;
    for (let j = 1; j <= m; j++) dp[0][j] = j * gap;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = Math.max(
                dp[i - 1][j - 1] + pairScore(existing[i - 1], candidate[j - 1]),
                dp[i - 1][j] + gap,
                dp[i][j - 1] + gap,
            );
        }
    }
    // Traceback (produces ops in reverse, then flip → receipt order).
    const ops: AlignOp[] = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0
            && dp[i][j] === dp[i - 1][j - 1] + pairScore(existing[i - 1], candidate[j - 1])) {
            ops.push({ type: 'match', i: i - 1, j: j - 1 }); i--; j--;
        } else if (i > 0 && dp[i][j] === dp[i - 1][j] + gap) {
            ops.push({ type: 'del', i: i - 1 }); i--;
        } else {
            ops.push({ type: 'ins', j: j - 1 }); j--;
        }
    }
    return ops.reverse();
};

// ── heal plan ────────────────────────────────────────────────────────────────

export interface HealResultLine<R> {
    op: 'kept' | 'healed' | 'inserted';
    changed: boolean;
    existing?: HealLine<R>;
    candidate?: HealLine<R>;
    /** Merged field decisions (what the healed receipt line should carry). */
    name: string;
    price: number;
    quantity: number;
    /** Adopt the candidate's product match (its name won the merge + it matched). */
    takeCandidateMatch: boolean;
    /** Adopt the candidate's price fields (the stored price was missing/implausible). */
    takeCandidatePrice: boolean;
}

export interface HealPlan<R> {
    lines: HealResultLine<R>[];
    healedCount: number;
    insertedCount: number;
    keptCount: number;
}

/**
 * Heal `existing` (the stored parse) with `candidate` (the retake), anchored on
 * the receipt `total`. Returns the ordered plan. Conservative by design:
 *  • matched pair → per-field best-of, never downgrading a confirmed/good line;
 *  • existing-only line (retake missed it) → KEPT untouched;
 *  • candidate-only line (stored parse missed it) → INSERTED only if readable AND
 *    it helps close the line-sum-vs-total gap (or, with no total, if readable).
 */
export const healReceipt = <R>(
    existing: HealLine<R>[],
    candidate: HealLine<R>[],
    total: number | null,
): HealPlan<R> => {
    const ops = alignLines(existing, candidate);

    // Insert budget = how far the stored lines fall SHORT of the total. Each
    // accepted insert must fit under the remaining shortfall (checksum).
    const existingSum = existing.reduce((s, l) => s + (l.price > 0 ? l.price : 0), 0);
    let shortfall = total != null && total > 0 ? total - existingSum : Infinity;
    const tol = Math.max(CFG.priceMatchAbsEur, total != null ? CFG.priceMatchFrac * total : 0);

    const lines: HealResultLine<R>[] = [];
    let healedCount = 0, insertedCount = 0, keptCount = 0;

    for (const op of ops) {
        if (op.type === 'del') {
            const e = existing[op.i];
            lines.push({ op: 'kept', changed: false, existing: e, name: e.name, price: e.price, quantity: e.quantity, takeCandidateMatch: false, takeCandidatePrice: false });
            keptCount++;
            continue;
        }
        if (op.type === 'ins') {
            const c = candidate[op.j];
            const readable = hasUsableName(c.name) && c.price > 0 && !c.implausible;
            const fits = total == null ? true : c.price <= shortfall + tol;
            if (readable && fits) {
                if (total != null) shortfall -= c.price;
                lines.push({ op: 'inserted', changed: true, candidate: c, name: c.name, price: c.price, quantity: c.quantity, takeCandidateMatch: c.matched, takeCandidatePrice: true });
                insertedCount++;
            }
            // Unreadable / total-unsupported inserts are dropped (no phantom lines).
            continue;
        }
        // match — per-field best-of, never-downgrade.
        const e = existing[op.i], c = candidate[op.j];
        if (e.confirmed) {
            // Keep the user-confirmed MATCH (the swipe), but a retake may still CORRECT a
            // grossly wrong PRICE the parser produced — the user confirmed the product, not
            // the price. Adopt the candidate's price ONLY when it's sound AND it moves the
            // receipt line-sum toward the printed total (closes a real reconciliation gap);
            // otherwise the line is kept verbatim. The SP + matchConfirmed are preserved
            // (takeCandidateMatch stays false), so no re-swipe is triggered.
            const cGood = c.price > 0 && !c.implausible;
            const reprice = cGood && total != null && total > 0 && !priceClose(e.price, c.price) &&
                Math.abs(existingSum - e.price + c.price - total) + tol < Math.abs(existingSum - total);
            lines.push({
                op: reprice ? 'healed' : 'kept',
                changed: reprice,
                existing: e, candidate: c,
                name: e.name,                     // a confirmed name is never overwritten
                price: reprice ? c.price : e.price,
                quantity: reprice ? c.quantity : e.quantity,
                takeCandidateMatch: false,        // keep the confirmed SP + matchConfirmed
                takeCandidatePrice: reprice,
            });
            if (reprice) healedCount++; else keptCount++;
            continue;
        }
        // Name: the higher-quality side wins; a usable existing name isn't lost to a garbled retake.
        const takeCandName = nameQuality(c) > nameQuality(e) && hasUsableName(c.name);
        const name = takeCandName ? c.name : e.name;
        // Price: keep the existing plausible price (stable); only replace when the
        // existing is missing/implausible and the candidate is sound.
        const eBad = !(e.price > 0) || e.implausible;
        const cGood = c.price > 0 && !c.implausible;
        const takeCandidatePrice = eBad && cGood;
        const price = takeCandidatePrice ? c.price : (e.price > 0 ? e.price : c.price);
        const quantity = takeCandidatePrice ? c.quantity : e.quantity;
        // Adopt the candidate's match only when we took its (better, matched) name
        // and the existing line wasn't already matched.
        const takeCandidateMatch = takeCandName && c.matched && !e.matched;
        const changed = name !== e.name || price !== e.price || takeCandidateMatch;
        lines.push({ op: changed ? 'healed' : 'kept', changed, existing: e, candidate: c, name, price, quantity, takeCandidateMatch, takeCandidatePrice });
        if (changed) healedCount++; else keptCount++;
    }

    return { lines, healedCount, insertedCount, keptCount };
};
