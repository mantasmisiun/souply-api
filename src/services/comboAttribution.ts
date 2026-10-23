/**
 * WHICH lines a set-deal ("RINKINYS") discount is shown against — DISPLAY ONLY.
 *
 * IKI deducts a set deal at the FOOTER, so it is deliberately never folded into a
 * line's price: doing that would push a discounted unit price into price learning
 * and cross-store comparison (a €1,69 water booked as €0,74 would poison the
 * price history). See the receipt-229 decision. This module only decides how to
 * PRESENT the deal; `ReceiptItem.price` / `promoPrice` are untouched.
 *
 * A set deal by definition needs 2+ qualifying items, so showing it spread evenly
 * across every line is misleading — on a receipt of vinegar + 2× water it made the
 * vinegar look discounted. Tiers, strongest signal first:
 *
 *   1. ANCHOR — the parser records which line the RINKINYS row was printed under
 *      (footer.comboDiscountAnchors). IKI prints it directly beneath the items
 *      that earned it, so this is the ground truth. The anchored line's whole
 *      GROUP (other lines of the same product) shares the deal.
 *   2. MULTIPLES — no anchor: fall back to lines that are plainly multiples,
 *      i.e. quantity ≥ 2, or 2+ lines of the same product.
 *   3. EVEN — nothing identifiable: split across every line, the old behaviour.
 *
 * In every tier a line's share is capped at its own total, so a displayed price
 * can never go negative; any remainder that cannot be placed is returned so the
 * caller can keep showing it as a footer-level amount.
 */

export interface ComboLine {
    /** Stable identity of the product on this line (matchedSpId), else null. */
    matchedSpId: number | null;
    /** Fallback identity when unmatched. */
    name: string;
    quantity: number;
    /** What this line contributes to the printed total. */
    lineTotal: number;
}

export interface ComboAttribution {
    /** Per-line share, index-aligned with the input. Always ≥ 0. */
    shares: number[];
    /** Which tier produced it — useful for telemetry/debugging. */
    basis: 'anchor' | 'multiples' | 'even' | 'none';
    /** Amount that could not be placed on any line (all were capped). */
    unattributed: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Group key: the matched product, else a normalised name. */
const keyOf = (l: ComboLine): string =>
    l.matchedSpId != null ? `sp:${l.matchedSpId}` : `nm:${(l.name ?? '').trim().toLowerCase()}`;

/**
 * Spread `amount` over `targets` (indices), proportional to each line's total so
 * a bigger line absorbs more, capping every share at the line's own total. Runs
 * repeatedly so a capped line's leftover moves to the others instead of vanishing.
 */
const spread = (lines: ComboLine[], targets: number[], amount: number): { shares: number[]; left: number } => {
    const shares = new Array(lines.length).fill(0);
    let left = amount;
    let pool = targets.filter((i) => lines[i].lineTotal > 0);
    // Each pass places what it can; a pass that places nothing ends it.
    for (let guard = 0; guard < 8 && left > 0.005 && pool.length > 0; guard++) {
        const base = pool.reduce((s, i) => s + lines[i].lineTotal, 0);
        if (base <= 0) break;
        let placed = 0;
        for (const i of pool) {
            const want = (lines[i].lineTotal / base) * left;
            const room = lines[i].lineTotal - shares[i];
            const give = Math.min(want, room);
            if (give > 0) { shares[i] += give; placed += give; }
        }
        if (placed <= 0) break;
        left -= placed;
        pool = pool.filter((i) => lines[i].lineTotal - shares[i] > 0.005);
    }
    return { shares: shares.map(r2), left: r2(Math.max(0, left)) };
};

export function attributeComboDiscount(
    lines: ComboLine[],
    comboDiscount: number | null | undefined,
    anchors: number[] | null | undefined,
): ComboAttribution {
    const amount = comboDiscount != null && comboDiscount > 0 ? comboDiscount : 0;
    const none: ComboAttribution = { shares: new Array(lines.length).fill(0), basis: 'none', unattributed: 0 };
    if (amount <= 0 || lines.length === 0) return none;

    // ── Tier 1: the line the deal was printed under, plus its group ──
    const valid = (anchors ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < lines.length);
    if (valid.length > 0) {
        const keys = new Set(valid.map((i) => keyOf(lines[i])));
        const targets = lines.map((_, i) => i).filter((i) => keys.has(keyOf(lines[i])));
        const { shares, left } = spread(lines, targets, amount);
        if (shares.some((v) => v > 0)) return { shares, basis: 'anchor', unattributed: left };
    }

    // ── Tier 2: the plain multiples ──
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(keyOf(l), (counts.get(keyOf(l)) ?? 0) + 1);
    const multiples = lines
        .map((_, i) => i)
        .filter((i) => lines[i].quantity >= 2 || (counts.get(keyOf(lines[i])) ?? 0) >= 2);
    if (multiples.length > 0) {
        const { shares, left } = spread(lines, multiples, amount);
        if (shares.some((v) => v > 0)) return { shares, basis: 'multiples', unattributed: left };
    }

    // ── Tier 3: nothing identifiable → everything, evenly weighted ──
    const { shares, left } = spread(lines, lines.map((_, i) => i), amount);
    if (shares.some((v) => v > 0)) return { shares, basis: 'even', unattributed: left };
    return { ...none, unattributed: r2(amount) };
}
