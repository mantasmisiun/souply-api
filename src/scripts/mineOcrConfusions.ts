/**
 * ── OCR CONFUSION-TABLE MINER (Phase 4, shared/ROBUST_PARSING_PLAN.md) ──
 *
 * Mines character-level OCR confusions from the corpus we ALREADY own:
 *   1. ReceiptItem rows the user CONFIRMED via swipes (matchConfirmed=1):
 *      `name` (the OCR read) vs `matchedName` (the catalog truth).
 *   2. The vocabulary aliases (StoreProductReceiptAlias, canonical/confirmed):
 *      `rawName` (OCR) vs the SP's storeProductName (truth).
 *
 * For every (ocr, truth) pair that is CLOSE overall (≥ MIN_SIM after diacritic
 * folding — far pairs are different words, not misreads), run a Levenshtein
 * BACKTRACE and count the per-character substitutions / deletions / insertions.
 * The aggregated table is what the hand-written maps (GLYPH_DIGIT in ikiParser,
 * GLYPH_LEX_FOLD, cardMaskDetection's folds, the matcher's weightedLevenshtein)
 * encode from single incidents today — mined, it grows with every scan + swipe.
 *
 * OUTPUT: a ranked report (stdout) + JSON artifact (src/scripts/receiptBatch/
 * snapshots/ocrConfusions.latest.json), including a DIFF against the glyph maps
 * currently hard-coded in the parser — human reviews, then updates the maps.
 * Deliberately NOT auto-wired into the parser: confusion tables are load-bearing
 * (they widen match acceptance), so a human gate stays between data and code.
 *
 * Usage:  npm run ocr:confusions
 */
import '../config/env.js';
import pool from '../config/db.js';

const MIN_SIM = 0.65;          // pair must be this similar overall to be alignment-worthy
const MIN_COUNT = 2;           // report confusions seen at least this often
const CASE_FOLD = true;

// Confusions the parser already encodes (review diff target). Keep in sync manually —
// the whole point of the report is telling us when this list is stale.
const KNOWN: Record<string, string[]> = {
    '0': ['o'], 'o': ['0'], '1': ['i', 'l', '|', '!'], 'i': ['1', 'l', 't', 'ì', 'í'],
    'l': ['1', 'i', 't'], 's': ['5', '$'], '5': ['s'], 'b': ['8', '6'], '8': ['b'],
    'z': ['2', '7'], '2': ['z'], 'g': ['9', 'q'], '9': ['g', 'y', 'q'], '4': ['a', 'y'],
    'a': ['4'], 'e': ['3', '€', 'ė', 'é'], '3': ['e'], 'c': ['(', '{', '['], 't': ['(', 'i', 'l'],
};

const fold = (s: string): string => {
    let t = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (CASE_FOLD) t = t.toLowerCase();
    return t.replace(/\s+/g, ' ').trim();
};

function levBacktrace(a: string, b: string): Array<[string, string]> {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
            );
        }
    }
    // walk back, collecting edit ops: [ocrChar, truthChar] ('' = ins/del)
    const ops: Array<[string, string]> = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
            if (a[i - 1] !== b[j - 1]) ops.push([a[i - 1], b[j - 1]]);
            i--; j--;
        } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
            ops.push([a[i - 1], '']);                      // OCR inserted a char
            i--;
        } else {
            ops.push(['', b[j - 1]]);                      // OCR dropped a char
            j--;
        }
    }
    return ops;
}

const similarity = (a: string, b: string): number => {
    const max = Math.max(a.length, b.length);
    if (max === 0) return 1;
    let d = 0;
    for (const _ of levBacktrace(a, b)) d++;
    return 1 - d / max;
};

async function fetchPairs(): Promise<Array<{ ocr: string; truth: string; src: string }>> {
    const pairs: Array<{ ocr: string; truth: string; src: string }> = [];
    // 1. Swipe-confirmed receipt lines.
    const [confirmed]: any = await pool.query(
        `SELECT name AS ocr, matchedName AS truth FROM ReceiptItem
          WHERE matchConfirmed = 1 AND matchedName IS NOT NULL AND name IS NOT NULL AND name <> ''`,
    );
    for (const r of confirmed) pairs.push({ ocr: String(r.ocr), truth: String(r.truth), src: 'swipe-confirmed' });
    // 2. Vocabulary aliases in trusted states.
    const [aliases]: any = await pool.query(
        `SELECT a.rawSample AS ocr, sp.storeProductName AS truth
           FROM StoreProductReceiptAlias a
           JOIN StoreProduct sp ON sp.id = a.storeProductId
          WHERE a.status IN ('canonical', 'confirmed') AND a.rawSample IS NOT NULL`,
    ).catch(() => [[]]);
    for (const r of aliases) if (r.ocr) pairs.push({ ocr: String(r.ocr), truth: String(r.truth), src: 'alias' });
    return pairs;
}

async function main() {
    const pairs = await fetchPairs();
    console.log(`pairs fetched: ${pairs.length}`);
    const subs = new Map<string, number>();     // "x→y" counts (OCR read x where truth is y)
    const drops = new Map<string, number>();    // truth chars OCR dropped
    const ghosts = new Map<string, number>();   // chars OCR invented
    let used = 0;
    for (const { ocr, truth } of pairs) {
        const a = fold(ocr);
        let b = fold(truth);
        if (!a || !b) continue;
        // Receipts print TRUNCATED names ("MAGI JA GLAISTYTAS VANILIN" for a catalog name
        // twice that long) — aligning against the full catalog name floods the "dropped"
        // table with truncation artifacts. Align against the truth's PREFIX of comparable
        // length (small slack for OCR-inserted junk) so only real per-glyph edits count.
        if (b.length > a.length + 3) b = b.slice(0, a.length + 3);
        if (similarity(a, b) < MIN_SIM) continue;  // different words, not a misread
        used++;
        for (const [x, y] of levBacktrace(a, b)) {
            if (x && y) subs.set(`${x}→${y}`, (subs.get(`${x}→${y}`) ?? 0) + 1);
            else if (!x) drops.set(y, (drops.get(y) ?? 0) + 1);
            else ghosts.set(x, (ghosts.get(x) ?? 0) + 1);
        }
    }
    console.log(`pairs aligned (sim ≥ ${MIN_SIM}): ${used}`);

    const ranked = [...subs.entries()].filter(([, c]) => c >= MIN_COUNT).sort((p, q) => q[1] - p[1]);
    console.log(`\n=== SUBSTITUTIONS (OCR→truth, seen ≥${MIN_COUNT}×) ===`);
    const novel: string[] = [];
    for (const [key, count] of ranked) {
        const [x, y] = key.split('→');
        const known = (KNOWN[x] ?? []).includes(y) || (KNOWN[y] ?? []).includes(x);
        if (!known) novel.push(key);
        console.log(`  ${key}  ×${count}${known ? '' : '   ← NOT in the hand-coded maps'}`);
    }
    const topDrops = [...drops.entries()].sort((p, q) => q[1] - p[1]).slice(0, 15);
    console.log(`\n=== DROPPED by OCR (top) ===\n  ${topDrops.map(([c, n]) => `"${c}"×${n}`).join('  ')}`);
    const topGhosts = [...ghosts.entries()].sort((p, q) => q[1] - p[1]).slice(0, 15);
    console.log(`\n=== INVENTED by OCR (top) ===\n  ${topGhosts.map(([c, n]) => `"${c}"×${n}`).join('  ')}`);
    console.log(`\n=== NOVEL confusions to consider adding ===\n  ${novel.join('  ') || '(none — maps are up to date)'}`);

    const fs = await import('fs');
    const out = {
        minedAt: new Date().toISOString(),
        pairs: pairs.length, aligned: used,
        substitutions: Object.fromEntries(ranked),
        dropped: Object.fromEntries(topDrops),
        invented: Object.fromEntries(topGhosts),
        novel,
    };
    const dest = 'src/scripts/receiptBatch/snapshots/ocrConfusions.latest.json';
    fs.writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(`\nsnapshot → ${dest}`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
