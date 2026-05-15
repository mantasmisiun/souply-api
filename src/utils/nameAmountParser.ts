/**
 * Extracts `{amount, unit}` from a StoreProduct name.
 *
 * Used in two places:
 *   1. Admin amounts-tab queue picker — surfaces SPs where the parsed
 *      result disagrees with the stored values (priority 2). SPs whose
 *      names yield no parse are silently skipped — there's no signal
 *      to act on.
 *   2. The admin card UI — the parsed result pre-fills the amount/unit
 *      inputs so the admin's job is "confirm or override," not "type
 *      from scratch."
 *
 * Pure function — no DB. Tested against real catalog names in
 * `tests/nameAmountParser.test.ts`.
 *
 * Returns `null` when:
 *   - No `<number><unit>` pattern is found
 *   - A multi-pack pattern (`10 x 100g`) is detected — ambiguous total
 *
 * Tolerance to formatting noise (all yield the same result):
 *   "200g" / "200 g" / "200gr" / "200gr." / "200 GR"
 *   "0,5kg" / "0.5kg" / "0,5 kg"
 *   "10 vnt" / "10 vnt." / "10vnt" / "10 Vnt"
 *   "8 rit." / "8 rit" / "8 ritės"
 */

export type CanonicalUnit = 'g' | 'kg' | 'ml' | 'l' | 'vnt' | 'rit';

export interface ParsedAmount {
    amount: number;
    unit: CanonicalUnit;
    /** Literal substring the regex matched. Useful for the "rasta:" line on the admin card. */
    matched: string;
}

/**
 * Maps each canonical unit to its dimension class. Two parses match
 * only when their dimensions agree (`200g` ≠ `200ml` even though the
 * number is the same).
 */
export type Dimension = 'mass' | 'volume' | 'piece';

const DIMENSION_OF: Record<CanonicalUnit, Dimension> = {
    g: 'mass',
    kg: 'mass',
    ml: 'volume',
    l: 'volume',
    vnt: 'piece',
    rit: 'piece',
};

/** Convert to the canonical base unit per dimension (g / ml / piece-count). */
function toCanonical(amount: number, unit: CanonicalUnit): number {
    switch (unit) {
        case 'kg': return amount * 1000;
        case 'g':  return amount;
        case 'l':  return amount * 1000;
        case 'ml': return amount;
        case 'vnt': return amount;
        case 'rit': return amount;
    }
}

/**
 * Pre-check for multi-pack ambiguity. `10 x 100g` could mean a total
 * of 1 kg or a per-unit size of 100g — admin has to decide manually.
 * Return early with null in that case so the queue picker skips the SP.
 */
const MULTIPACK_RE = /\d+\s*[xX×]\s*\d/;

/**
 * Captures `<number><whitespace?><unit>` runs. Notes:
 *   - `(?![a-ząčęėįšųūž])` lookahead stops `l` matching inside
 *     "lazerinis", `g` matching inside "grūdai", etc. Lithuanian
 *     diacritics included.
 *   - `gr?` covers `g` and `gr` / `gr.`; the optional `.` is handled
 *     by the lookahead being satisfied by `.` (non-letter).
 *   - `vnt\.?` / `rit\.?` cover the trailing period variants.
 *   - Decimal separator can be `.` or `,`.
 */
const UNIT_RE = /(\d+(?:[.,]\d+)?)\s*(kg|gr?|ml|l|vnt\.?|rit\.?|ritės|ritė)(?![a-ząčęėįšųūž])/gi;

function normaliseUnit(raw: string): CanonicalUnit | null {
    const lower = raw.toLowerCase().replace(/\.$/, '');
    if (lower === 'kg') return 'kg';
    if (lower === 'g' || lower === 'gr') return 'g';
    if (lower === 'ml') return 'ml';
    if (lower === 'l') return 'l';
    if (lower === 'vnt') return 'vnt';
    if (lower === 'rit' || lower === 'ritė' || lower === 'ritės') return 'rit';
    return null;
}

export function parseAmountFromName(name: string): ParsedAmount | null {
    if (!name) return null;
    if (MULTIPACK_RE.test(name)) return null;

    // Find every <num><unit> hit. Take the LAST — by convention size
    // suffixes sit at the end of the name ("Pienas Dobilas 2,5% 1L").
    const hits: ParsedAmount[] = [];
    UNIT_RE.lastIndex = 0;
    for (let m = UNIT_RE.exec(name); m !== null; m = UNIT_RE.exec(name)) {
        const rawNum = m[1].replace(',', '.');
        const amount = parseFloat(rawNum);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const unit = normaliseUnit(m[2]);
        if (!unit) continue;

        hits.push({ amount, unit, matched: m[0] });
    }

    if (hits.length === 0) return null;
    return hits[hits.length - 1];
}

/**
 * Whether the parsed result agrees with the SP's stored amount/unit.
 *
 * Rules:
 *   - Stored amount null OR unit null → false (no agreement, but the
 *     parser has a suggestion → admin should see this).
 *   - Different dimensions (mass vs volume) → false (real conflict).
 *   - Same dimension, canonical values within ±1 % → true.
 *
 * The ±1 % tolerance defends against floating-point round-trips. Real
 * catalog values don't drift by more than that within the same
 * dimension (a 200g pack isn't sold as 199g).
 */
export function amountsAgree(
    parsed: ParsedAmount,
    stored: { amount: number | null; unit: string | null },
): boolean {
    if (stored.amount === null || stored.unit === null) return false;

    const storedUnit = normaliseUnit(stored.unit);
    if (!storedUnit) return false;

    if (DIMENSION_OF[parsed.unit] !== DIMENSION_OF[storedUnit]) return false;

    const a = toCanonical(parsed.amount, parsed.unit);
    const b = toCanonical(stored.amount, storedUnit);
    if (b <= 0) return false;
    const diff = Math.abs(a - b) / b;
    return diff <= 0.01;
}

/**
 * `isWeighable` derives from the canonical unit's dimension class —
 * mass units mean the item is weighed at checkout, piece/volume
 * (vnt, rit, ml, l) means a packaged item. Surfaced so the admin
 * tab can write it alongside amount/unit without showing a checkbox.
 */
export function isWeighableForUnit(unit: CanonicalUnit): boolean {
    return DIMENSION_OF[unit] === 'mass';
}
