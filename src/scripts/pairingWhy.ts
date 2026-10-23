/**
 * WHY DID THESE TWO NOT PAIR? — diagnostic for the "missed item + extra item"
 * class of bug (one real purchase counted BOTH as a forgotten list item AND as an
 * impulse receipt line, because the planning matcher never recognised them as the
 * same kind of thing).
 *
 *   npm run pairing:why -- "Spirito actas WELL DONE, 9 proc." "Maistinė acto rūgštis"
 *   npm run pairing:why -- --trip 184          # every unmatched pair of a real trip
 *
 * It runs the PRODUCTION tiers (planningScoreService.nameTokens / sameKind), so
 * what it prints is what the app decided — not a re-implementation. When the
 * verdict is "head nouns differ only by a case ending", the fix is a group in
 * src/utils/ltLemmas.ts.
 */

import { normalizeProductName } from '../utils/productNameNormalize.js';
import { lemmaOf, isKnownLemmaForm } from '../utils/ltLemmas.js';
import { nameTokens, sameKind, computePlanningScore } from '../services/planningScoreService.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Words the token tier drops before comparing — useful to see explicitly. */
const droppedTokens = (name: string): string[] => {
    const kept = nameTokens(name);
    return normalizeProductName(name ?? '')
        .split(' ')
        .filter((w) => w && !kept.has(lemmaOf(w)));
};

const tokenLine = (name: string): string => {
    const words = normalizeProductName(name ?? '').split(' ').filter(Boolean);
    return words
        .map((w) => {
            const l = lemmaOf(w);
            if (l !== w) return green(`${w}→${l}`);
            return isKnownLemmaForm(w) ? green(w) : w;
        })
        .join(' ');
};

/**
 * Do two normalized words look like the same head noun in different cases?
 * Deliberately crude — this only decides whether to SUGGEST an ltLemmas group for
 * a human to review, it never matches anything by itself.
 */
const looksLikeSameNoun = (a: string, b: string): boolean => {
    if (a === b) return false;
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    // Same first 3+ letters, and only a short ending differs (a case suffix).
    return i >= 3 && a.length - i <= 3 && b.length - i <= 3;
};

const explainPair = (listName: string, receiptName: string, listProductId?: number | null, receiptProductId?: number | null, listL3?: number | null, receiptL3?: number | null) => {
    const li = { productName: listName, productId: listProductId ?? null, l3: listL3 ?? null };
    const ri = { name: receiptName, productId: receiptProductId ?? null, l3: receiptL3 ?? null };
    const paired = sameKind({ ...li }, { ...ri });

    console.log(`${bold('list   ')} ${listName}`);
    console.log(`${dim('  tokens')} ${tokenLine(listName)}`);
    const dl = droppedTokens(listName);
    if (dl.length) console.log(`${dim('  dropped (short/filler)')} ${dim(dl.join(' '))}`);
    console.log(`${bold('receipt')} ${receiptName}`);
    console.log(`${dim('  tokens')} ${tokenLine(receiptName)}`);
    const dr = droppedTokens(receiptName);
    if (dr.length) console.log(`${dim('  dropped (short/filler)')} ${dim(dr.join(' '))}`);

    const lt = nameTokens(listName);
    const rt = nameTokens(receiptName);
    const shared = [...rt].filter((w) => lt.has(w));

    // Tier by tier, in the order sameKind evaluates them.
    const t1 = li.productId != null && ri.productId != null && Number(li.productId) === Number(ri.productId);
    console.log(`  ${t1 ? green('✓') : red('✗')} tier 1 productId   ${dim(`${li.productId ?? '—'} vs ${ri.productId ?? '—'}`)}`);
    console.log(`  ${shared.length ? green('✓') : red('✗')} tier 2 name token  ${shared.length ? green(shared.join(' ')) : dim('no shared token')}`);
    const t3 = li.l3 != null && ri.l3 != null && li.l3 !== 688 && Number(li.l3) === Number(ri.l3);
    console.log(`  ${t3 ? green('✓') : red('✗')} tier 3 category L3 ${dim(`${li.l3 ?? '—'} vs ${ri.l3 ?? '—'}${ri.l3 === 688 || li.l3 === 688 ? ' (688 = unassigned, never matches)' : ''}`)}`);
    console.log(paired ? green('  ⇒ PAIRED') : red('  ⇒ NOT PAIRED'));

    if (!paired && !shared.length) {
        const suggestions: string[] = [];
        for (const a of lt) for (const b of rt) if (looksLikeSameNoun(a, b)) suggestions.push(`['${a}', '${b}']`);
        if (suggestions.length) {
            console.log(yellow(`  → these differ only by a case ending. Add to LT_LEMMA_GROUPS in src/utils/ltLemmas.ts:`));
            for (const s of new Set(suggestions)) console.log(yellow(`      ${s}`));
        } else {
            console.log(dim('  → no near-identical head nouns; not an inflection problem (check category/L3 or the matcher itself).'));
        }
    }
    console.log('');
};

const main = async () => {
    const argv = process.argv.slice(2);
    const tripIdx = argv.indexOf('--trip');

    if (tripIdx >= 0) {
        const tripId = Number(argv[tripIdx + 1]);
        if (!Number.isFinite(tripId)) throw new Error('--trip needs a trip id');
        const score = await computePlanningScore(tripId);
        console.log(bold(`trip ${tripId}`), dim(`missed ${score.forgottenCount} · extra ${score.impulseCount} · paired ${score.pairs.length}`));
        console.log('');
        if (!score.unmatchedListItems.length || !score.unmatchedReceiptItems.length) {
            console.log(green('no missed × extra combination to explain.'));
        }
        for (const li of score.unmatchedListItems) {
            for (const ri of score.unmatchedReceiptItems) {
                explainPair(li.name ?? '', ri.name, li.productId, ri.productId);
            }
        }
        process.exit(0);
    }

    const [a, b] = argv;
    if (!a || !b) {
        console.log('usage: npm run pairing:why -- "<list name>" "<receipt name>"');
        console.log('       npm run pairing:why -- --trip <tripId>');
        process.exit(1);
    }
    explainPair(a, b);
    process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
