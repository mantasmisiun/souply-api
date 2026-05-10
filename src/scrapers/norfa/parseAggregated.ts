// Norfa aggregated product name parser.
// Handles three patterns found on norfa.lt promo pages:
//   1. "N rūšių" — one promo price covering N variants, possibly multiple sizes
//   2. "arba" / "ir" (uppercase context) — two or more named variants
//   3. Multi-brand comma list — "Gaz. gėrimas 7 UP, MIRINDA, MOUNTAIN DEW, 1,5 l"

// ── Size stripping ────────────────────────────────────────────────────────────

const TAIL_SIZE_RE =
    /,\s*\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?\s*(?:g\/pak\.?|g|kg|ml|l|vnt\.?(?:\/pak\.?)?|pak\.)\s*$/i;

function stripSizesIterative(name: string): { base: string; sizes: string[] } {
    const sizes: string[] = [];
    let cur = name;
    for (let i = 0; i < 8; i++) {
        const m = cur.match(TAIL_SIZE_RE);
        if (!m) break;
        sizes.unshift(m[0].replace(/^,\s*/, '').trim());
        cur = cur.slice(0, m.index!).trim();
    }
    return { base: cur, sizes };
}

// ── Pattern 1: rūšių ─────────────────────────────────────────────────────────

export interface RusiaiParsed {
    baseName: string;
    sizes: string[];
    maxK: number;
}

const RUSIAI_RE = /,?\s*\(?\s*(?:įv\.)?\s*\d*\s*rūšių\s*\)?/gi;
const FAT_CONTENT_RE = /,?\s*\d+(?:[.,]\d+)?%\s*rieb\./gi;
const AR_ABBREV_RE = /,?\s*a\.\s*r\./gi;

function extractMaxK(name: string): number {
    const m = name.match(/\(?(?:įv\.)?\s*(\d+)\s*rūšių\)?/i);
    return m ? parseInt(m[1], 10) : 3;
}

export function parseRusiai(name: string): RusiaiParsed | null {
    if (!/rūšių/i.test(name)) return null;
    const maxK = extractMaxK(name);
    const cleaned = name
        .replace(RUSIAI_RE, '')
        .replace(FAT_CONTENT_RE, '')
        .replace(AR_ABBREV_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
    const { base, sizes } = stripSizesIterative(cleaned);
    const baseName = base.replace(/[,\s]+$/, '').trim();
    return { baseName, sizes, maxK };
}

// ── Pattern 2: arba / ir expansion ──────────────────────────────────────────

function isModifierWord(word: string): boolean {
    const w = word.toLowerCase().replace(/[.,]$/, '');
    if (w.endsWith('oji') || w.endsWith('asis') || w.endsWith('iška') || w.endsWith('iškas')) return true;
    if (/[aąeėiįuū][td]as$|ytas$|yta$|itas$|ita$|intas$|inta$/.test(w)) return true;
    if ((w.endsWith('ų') || w.endsWith('ių')) && w.length > 3) return true;
    return false;
}

function stemMatch(a: string, b: string): boolean {
    const wa = a.toLowerCase().replace(/[.,]$/, '');
    const wb = b.toLowerCase().replace(/[.,]$/, '');
    if (wa.length < 4 || wb.length < 4) return false;
    let n = 0;
    for (let i = 0; i < Math.min(wa.length, wb.length); i++) {
        if (wa[i] === wb[i]) n++; else break;
    }
    return n >= 4;
}

const isAllUpper = (w: string) => w === w.toUpperCase() && /[A-ZÄÖÜÕŽŠĖ]/.test(w);

export function expandVariants(name: string): string[] {
    if (/rūšių/i.test(name)) return [name];

    const hasArba = /\barba\b/.test(name);
    const hasIr = /[A-ZÄÖÜÕŽŠĖ]\s+ir\s+[A-ZÄÖÜÕŽŠĖ]/.test(name);
    if (!hasArba && !hasIr) return [name];

    const { base, sizes } = stripSizesIterative(name);

    const splitRe = hasArba ? / arba / : / ir (?=[A-ZÄÖÜÕŽŠĖ])/;
    const parts = base.split(splitRe);
    if (parts.length < 2) return [name];

    const left = parts[0].trim();
    const right = parts.slice(1).join(' arba ').trim();
    const rightWords = right.split(/\s+/);
    const leftWords = left.split(/\s+/);
    const A = leftWords.at(-1)!;
    const prefix = leftWords.slice(0, -1).join(' ');

    const r0 = rightWords[0];
    const rightStartsLower = r0[0] === r0[0].toLowerCase() && /[a-zäöüõžšė]/.test(r0[0]);
    const rightAllUpper = rightWords.every(w => isAllUpper(w) || /^[\d&+.]/.test(w));

    const getSize = (i: number) => sizes[i] ?? sizes.at(-1);
    const mk = (base: string, i: number) => { const s = getSize(i); return s ? `${base}, ${s}` : base; };

    if (rightStartsLower) {
        // Case A: adjective alternation — B extends while modifiers share stem with A
        let bEnd = 1;
        if (stemMatch(A, r0)) {
            while (bEnd < rightWords.length && isModifierWord(rightWords[bEnd])) bEnd++;
        }
        const B = rightWords.slice(0, bEnd).join(' ');
        const shared = rightWords.slice(bEnd).join(' ');
        const p1 = [prefix, A, shared].filter(Boolean).join(' ');
        const p2 = [prefix, B, shared].filter(Boolean).join(' ');
        return [mk(p1, 0), mk(p2, 1)];

    } else if (rightAllUpper) {
        // Case C: all-uppercase right — different brand/variant, share category prefix
        const firstCaps = leftWords.findIndex(w => isAllUpper(w));
        const catPrefix = (firstCaps === -1 ? leftWords : leftWords.slice(0, firstCaps)).join(' ');
        return [mk(left, 0), mk([catPrefix, right].filter(Boolean).join(' '), 1)];

    } else {
        // Case B: right starts uppercase but has lowercase — complete second product
        const lastLower = [...rightWords].reverse().find(w => /^[a-zäöüõžšė]/.test(w));
        let p1 = left;
        if (lastLower && !left.toLowerCase().includes(lastLower.toLowerCase())) {
            p1 = `${left} ${lastLower}`;
        }
        return [mk(p1, 0), mk(right, 1)];
    }
}

// ── Pattern 4: multi-brand comma list ────────────────────────────────────────

function isAllCapsSegment(s: string): boolean {
    return /^[A-ZÄÖÜÕŽŠĖ0-9& ]+$/.test(s.trim()) && /[A-ZÄÖÜÕŽŠĖ]/.test(s);
}

export function expandMultiBrand(name: string): string[] | null {
    if (/rūšių/i.test(name) || /\barba\b/.test(name) || /[A-ZÄÖÜÕŽŠĖ]\s+ir\s+[A-ZÄÖÜÕŽŠĖ]/.test(name)) return null;

    const { base, sizes } = stripSizesIterative(name);
    const size = sizes[0];

    const parts = base.split(/,\s*/);
    if (parts.length < 3) return null;

    const brandParts = parts.slice(1).filter(p => isAllCapsSegment(p));
    if (brandParts.length < 2) return null;

    const firstWords = parts[0].split(/\s+/);
    let firstCapsIdx = -1;
    for (let i = 0; i < firstWords.length; i++) {
        const w = firstWords[i];
        if (isAllCapsSegment(w)) { firstCapsIdx = i; break; }
        if (/^\d/.test(w) && i + 1 < firstWords.length && isAllCapsSegment(firstWords[i + 1])) {
            firstCapsIdx = i; break;
        }
    }

    const categoryPrefix = firstCapsIdx > 0 ? firstWords.slice(0, firstCapsIdx).join(' ') : '';
    const firstBrand = firstCapsIdx >= 0 ? firstWords.slice(firstCapsIdx).join(' ') : parts[0];
    const allBrands = [firstBrand, ...brandParts];

    return allBrands.map(brand => {
        const fullName = [categoryPrefix, brand].filter(Boolean).join(' ');
        return size ? `${fullName}, ${size}` : fullName;
    });
}
