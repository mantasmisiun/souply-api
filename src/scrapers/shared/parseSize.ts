// Ported from Scraper/rimi_scraperV2.js — handles Lithuanian grocery name quirks.
// Shared across all chain scrapers so size parsing stays consistent.

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const KL_TAIL_RE = new RegExp(String.raw`[,\s]*${NUM}\s*kl\.?\s*[,]?\s*$`, 'i');
// "500 g/pak.", "20 pak./dėž." — packaging suffix after the size defeats the
// $-anchored size regexes; strip it first.
const PACK_SUFFIX_RE = /\s*\/\s*(pak|dėž|dez|pack)\.?\s*$/i;
const BARE_VNT_RE = /[,\s]+vnt\.?\s*$/i;
const MULTIPACK_RE = new RegExp(
    String.raw`[,\s]*(${NUM})\s*[x×]\s*(${NUM})\s*(kg|g|ml|l|vnt)\.?\s*$`,
    'i',
);
const SIMPLE_RE = new RegExp(
    String.raw`[,\s]*(${NUM})\s*(kg|g|ml|l|vnt)\.?\s*$`,
    'i',
);
// "800ml /450g", "1 l / 500 g" — volume + net weight on one label (ice cream).
// Prefer the VOLUME (customary display size); strip the whole tail.
const DUAL_RE = new RegExp(
    String.raw`[,\s]*(${NUM})\s*(ml|l|g|kg)\s*\/\s*(${NUM})\s*(g|kg|ml|l)\.?\s*$`,
    'i',
);

const toNum = (s: string) => parseFloat(s.replace(',', '.'));

function stripKlTail(name: string): string {
    let out = name;
    while (KL_TAIL_RE.test(out)) out = out.replace(KL_TAIL_RE, '');
    return out;
}

function cleanName(name: string): string {
    return name.replace(/[,\s]+$/, '').trim();
}

export interface ParsedSize {
    storeProductName: string;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
}

export function parseSize(rawName: string): ParsedSize {
    const name = rawName.trim().replace(PACK_SUFFIX_RE, '');
    const withoutKl = stripKlTail(name);

    const dual = withoutKl.match(DUAL_RE);
    if (dual) {
        const firstVol = ['ml', 'l'].includes(dual[2].toLowerCase());
        const secondVol = ['ml', 'l'].includes(dual[4].toLowerCase());
        // volume wins when exactly one side is a volume; else keep the first
        const useFirst = firstVol || firstVol === secondVol;
        return {
            storeProductName: cleanName(withoutKl.slice(0, dual.index)),
            amount: toNum(useFirst ? dual[1] : dual[3]),
            unit: (useFirst ? dual[2] : dual[4]).toLowerCase(),
            isWeighable: false,
        };
    }

    const mp = withoutKl.match(MULTIPACK_RE);
    if (mp) {
        const count = toNum(mp[1]);
        const each = toNum(mp[2]);
        const unit = mp[3].toLowerCase();
        return {
            storeProductName: cleanName(withoutKl.slice(0, mp.index)),
            amount: +(count * each).toFixed(3),
            unit,
            isWeighable: false,
        };
    }

    // Numeric size BEFORE the bare-vnt branch — "10 vnt." must keep its count
    // (the old order let BARE_VNT eat the unit and strand ", 10" in the name).
    const s = withoutKl.match(SIMPLE_RE);
    if (s) {
        const amount = toNum(s[1]);
        const unit = s[2].toLowerCase();
        const isWeighable = unit === 'kg' && (amount === 1 || amount === null);
        return {
            storeProductName: cleanName(withoutKl.slice(0, s.index)),
            amount,
            unit,
            isWeighable,
        };
    }

    const bv = withoutKl.match(BARE_VNT_RE);
    if (bv) {
        return {
            storeProductName: cleanName(withoutKl.slice(0, bv.index)),
            amount: null,
            unit: 'vnt',
            isWeighable: false,
        };
    }

    return { storeProductName: cleanName(withoutKl), amount: null, unit: null, isWeighable: false };
}
