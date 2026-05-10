// Size extraction from Lidl's price.basePrice.text field.
// Multi-size "50 vnt. / 60 vnt. | per-unit info" → two variants.
// Per-unit annotation "550 g / 1 kg = price" → first size only.
// "1 vnt. = 0,85 €" with known package price → pack count inferred by division.
// Non-standard units (poros, rink.) → {null, null}.

const NUM_RE = String.raw`\d+(?:[.,]\d+)?`;
const UNIT_GROUP = '(vnt|g|kg|ml|l)';
const UNIT_PRICE_RE = /=\s*(\d+(?:[.,]\d+)?)\s*€/i;

export interface LidlSize {
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
}

export interface LidlPrices {
    promoPrice: number | null;
    regularPrice: number;
}

const toNum = (s: string) => parseFloat(s.replace(',', '.'));

function makeSingleSize(numStr: string, unitStr: string, hasUnitPriceAnnotation = false): LidlSize {
    const unit = unitStr.toLowerCase();
    const n = toNum(numStr);
    if (unit === 'vnt' && n === 1) return { amount: null, unit: 'vnt', isWeighable: false };
    // "1 kg" alone → weighable (sold by weight at the counter).
    // "1 kg = 3,98 €" → fixed 1 kg package; the "= price" is a unit-price annotation
    // that Lidl shows for fixed packages, not for items priced by weight.
    const isWeighable = unit === 'kg' && n === 1 && !hasUnitPriceAnnotation;
    return { amount: n, unit, isWeighable };
}

// Infer pack count for "1 vnt. = X €" when the package price is known.
// Lidl's unit-price annotation is computed from the promo price, so we
// divide promoPrice (falling back to regularPrice) by the per-unit price
// and round. Tolerance of ±15% rejects ambiguous cases.
function inferVntPackCount(unitPriceStr: string, prices: LidlPrices): number | null {
    const unitPrice = toNum(unitPriceStr);
    if (!unitPrice) return null;
    const refPrice = prices.promoPrice ?? prices.regularPrice;
    const raw = refPrice / unitPrice;
    const rounded = Math.round(raw);
    if (rounded >= 2 && Math.abs(raw - rounded) / rounded < 0.15) return rounded;
    return null;
}

// Infer actual package size for "1 kg = X €" / "1 l = X €" annotations.
// The per-unit price X is computed by Lidl from the promo price (or regular
// price when no promo exists). So: package_size = ref_price / X.
// Returns { amount, unit } with the inferred size in the smaller unit
// (g for kg annotations, ml for l annotations) when the result is < 1,
// otherwise keeps the original unit.
function inferWeightPackageSize(
    perUnitPriceStr: string,
    baseUnit: 'kg' | 'l',
    prices: LidlPrices,
): { amount: number; unit: string } | null {
    const perUnitPrice = toNum(perUnitPriceStr);
    if (!perUnitPrice) return null;
    const refPrice = prices.promoPrice ?? prices.regularPrice;
    const packageSize = refPrice / perUnitPrice;
    if (packageSize <= 0 || packageSize > 20) return null; // sanity check
    if (baseUnit === 'kg') {
        if (packageSize >= 1) return { amount: Math.round(packageSize * 100) / 100, unit: 'kg' };
        return { amount: Math.round(packageSize * 1000), unit: 'g' };
    } else {
        if (packageSize >= 1) return { amount: Math.round(packageSize * 100) / 100, unit: 'l' };
        return { amount: Math.round(packageSize * 1000), unit: 'ml' };
    }
}

const MULTI_RE = new RegExp(
    `^(${NUM_RE})\\s*${UNIT_GROUP}\\.?\\s*/\\s*(${NUM_RE})\\s*${UNIT_GROUP}\\.?\\s*$`,
    'i',
);
const FIRST_RE = new RegExp(`^(${NUM_RE})\\s*${UNIT_GROUP}\\.?`, 'i');
// "3 x 50 g / 1 kg = 16,60 €" — N packs of AMOUNT UNIT each; total = N × AMOUNT.
const MULTI_PACK_RE = new RegExp(`^(\\d+)\\s*[xX]\\s*(${NUM_RE})\\s*${UNIT_GROUP}`, 'i');

/**
 * Returns one LidlSize per pack variant.
 * Single-size products return a one-element array.
 * Products with unrecognised units return [{null, null, false}].
 *
 * Pass `prices` so pack counts can be inferred from "1 vnt. = X €" annotations.
 */
export function extractLidlSizes(basePriceText: string, prices?: LidlPrices): LidlSize[] {
    const text = basePriceText.trim();
    if (!text) return [{ amount: null, unit: null, isWeighable: false }];

    // Multi-size: "50 vnt. / 60 vnt. | 1 vnt. = 0,02 / 0,01 €"
    // The pipe separates the pack-count part from the per-unit price part.
    const pipeIdx = text.indexOf('|');
    if (pipeIdx > 0) {
        const sizePart = text.slice(0, pipeIdx).trim();
        const m = MULTI_RE.exec(sizePart);
        if (m) {
            const [, n1, u1, n2, u2] = m;
            if (u1.toLowerCase() === u2.toLowerCase()) {
                return [makeSingleSize(n1, u1), makeSingleSize(n2, u2)];
            }
            return [makeSingleSize(n1, u1)];
        }
        const sm = FIRST_RE.exec(sizePart);
        if (sm) return [makeSingleSize(sm[1], sm[2])];
        return [{ amount: null, unit: null, isWeighable: false }];
    }

    // "N x AMOUNT UNIT / 1 UNIT = price €" — multi-pack, total weight = N × AMOUNT.
    const mp = MULTI_PACK_RE.exec(text);
    if (mp) {
        const count = parseInt(mp[1], 10);
        const amount = toNum(mp[2]);
        const unit = mp[3].toLowerCase();
        return [{ amount: Math.round(count * amount * 100) / 100, unit, isWeighable: false }];
    }

    // Single size or "N unit / 1 unit = price €" per-unit annotation — take first N unit.
    // Detect whether a "= price" or "/" annotation follows the matched token so we can
    // distinguish "1 kg" (weighable) from "1 kg = 3,98 €" (fixed 1 kg package),
    // and infer pack count from "1 vnt. = 0,85 €" when prices are provided.
    const m = FIRST_RE.exec(text);
    if (m) {
        const after = text.slice(m[0].length).trim();
        const hasAnnotation = after.startsWith('=') || after.startsWith('/');

        const unit = m[2].toLowerCase();
        if (toNum(m[1]) === 1 && hasAnnotation && prices) {
            const pm = UNIT_PRICE_RE.exec(after);
            if (pm) {
                // "1 vnt. = X €" — infer pack count from package price
                if (unit === 'vnt') {
                    const count = inferVntPackCount(pm[1], prices);
                    if (count !== null) return [{ amount: count, unit: 'vnt', isWeighable: false }];
                }
                // "1 kg = X €" / "1 l = X €" — infer actual package size from price ÷ per-unit rate
                if (unit === 'kg' || unit === 'l') {
                    const inferred = inferWeightPackageSize(pm[1], unit, prices);
                    if (inferred) return [{ amount: inferred.amount, unit: inferred.unit, isWeighable: false }];
                }
            }
        }

        return [makeSingleSize(m[1], m[2], hasAnnotation)];
    }
    return [{ amount: null, unit: null, isWeighable: false }];
}
