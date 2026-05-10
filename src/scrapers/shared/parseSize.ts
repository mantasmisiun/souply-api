// Ported from Scraper/rimi_scraperV2.js — handles Lithuanian grocery name quirks.
// Shared across all chain scrapers so size parsing stays consistent.

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const KL_TAIL_RE = new RegExp(String.raw`[,\s]*${NUM}\s*kl\.?\s*[,]?\s*$`, 'i');
const BARE_VNT_RE = /[,\s]+vnt\.?\s*$/i;
const MULTIPACK_RE = new RegExp(
    String.raw`[,\s]*(${NUM})\s*[x×]\s*(${NUM})\s*(kg|g|ml|l|vnt)\.?\s*$`,
    'i',
);
const SIMPLE_RE = new RegExp(
    String.raw`[,\s]*(${NUM})\s*(kg|g|ml|l|vnt)\.?\s*$`,
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
    const name = rawName.trim();
    const withoutKl = stripKlTail(name);

    const bv = withoutKl.match(BARE_VNT_RE);
    if (bv) {
        return {
            storeProductName: cleanName(withoutKl.slice(0, bv.index)),
            amount: null,
            unit: 'vnt',
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

    return { storeProductName: cleanName(withoutKl), amount: null, unit: null, isWeighable: false };
}
