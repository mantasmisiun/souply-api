/**
 * LITHUANIAN HEAD-NOUN LEMMAS for same-kind product matching.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  IF A "MISSED ITEM + EXTRA ITEM" PAIR IS REPORTED THAT ARE OBVIOUSLY THE SAME
 *  THING, CHECK THIS FILE FIRST. It is the intended fix for that whole class of
 *  bug, and it is meant to be extended.
 *
 *  HOW TO ADD A CASE
 *    1. Run the diagnostic to confirm the cause:
 *         npm run pairing:why -- "<list name>" "<receipt name>"
 *       If it reports "no shared token" and the head nouns differ only by a case
 *       ending, this file is the fix.
 *    2. Add the surface forms to the right group below (or add a new group).
 *       Forms must be NORMALIZED: lowercase, diacritics folded — write `surio`,
 *       not `sūrio`. `normalizeProductName` does that folding for real input.
 *    3. `npm test -- ltLemmas` — the invariant tests catch a form listed in two
 *       groups, a non-normalized form, and duplicates.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. Lithuanian declines heavily and receipts print different cases
 * from the catalogue: a list says "Spirito ACTAS" (nominative), the receipt says
 * "Maistinė ACTO rūgštis" (genitive). Token matching is exact-string, so those
 * miss, and the same purchase is then counted BOTH as a missed list item AND as
 * an extra (impulse) receipt line.
 *
 * WHY NOT JUST STEM IT. `productMatcher.ltStem` already strips case endings, but
 * deliberately refuses tokens under 6 chars and never leaves a stem under 4 —
 * "actas"→"act" is 3 chars, judged too weak to be safe generally. Short head
 * nouns (actas, duona, pienas, sūris, mėsa) are exactly the frequent ones, so
 * they get an explicit, reviewed mapping instead of a risky global rule.
 *
 * SCOPE: head nouns — the word that says WHAT the product is. Do NOT add brands,
 * adjectives or sizes; those are what keep genuinely different products apart.
 *
 * WHAT MUST STAY OUT (measured against the real catalogue, 56 k StoreProducts):
 * a genitive that is mostly a FLAVOUR / INGREDIENT modifier of a DIFFERENT kind of
 * product. `bulviu` occurs 416× — nearly all "bulvių traškučiai" (crisps), and
 * crisps are not potatoes; likewise citrinu (261, lemonade), obuoliu (358, juice),
 * bananu (176, yoghurt), pieno (320, milk chocolate), surio (364, cheese sauce).
 * Bridging those would pair a planned potato with bought crisps. Produce also
 * gains nothing from bridging: receipts and the catalogue both print fruit and
 * vegetables in the NOMINATIVE ("BANANAI", "Pomidorai"), so there is no case gap
 * to close. Hence: no produce, no milk, no cheese — see tests/ltLemmas.test.ts,
 * which pins those forms OUT of the map.
 */

/**
 * Each group is one concept: every form maps to the group's FIRST entry.
 * Keep groups small and unambiguous — a form that could plausibly belong to two
 * concepts belongs in NEITHER (the invariant test enforces uniqueness).
 */
export const LT_LEMMA_GROUPS: readonly (readonly string[])[] = [
    // ── pantry ──
    ['actas', 'acto', 'actu', 'actai', 'actus'],                 // vinegar
    ['aliejus', 'aliejaus', 'aliejai'],                          // oil
    ['druska', 'druskos', 'druskai'],                            // salt
    ['cukrus', 'cukraus', 'cukrui'],                             // sugar
    ['miltai', 'miltu', 'miltus', 'miltams'],                    // flour
    ['kruopos', 'kruopu'],                                       // groats
    ['makaronai', 'makaronu', 'makaronus'],                      // pasta
    ['ryziai', 'ryziu', 'ryzius'],                               // rice
    ['padazas', 'padazo', 'padazai', 'padazu'],                  // sauce
    ['majonezas', 'majonezo'],                                   // mayonnaise
    ['kecupas', 'kecupo'],                                       // ketchup
    ['medus', 'medaus'],                                         // honey
    ['kava', 'kavos', 'kavai'],                                  // coffee
    ['arbata', 'arbatos', 'arbatai'],                            // tea
    // ── bakery ──
    ['duona', 'duonos', 'duonai'],                               // bread
    ['bandele', 'bandeles', 'bandeliu'],                         // bun
    ['sausainiai', 'sausainiu', 'sausainius'],                   // biscuits
    ['pyragas', 'pyrago', 'pyragai'],                            // cake
    // ── dairy ──
    ['sviestas', 'sviesto', 'sviestui'],                         // butter
    ['grietine', 'grietines', 'grietinei'],                      // sour cream
    ['grietinele', 'grietineles'],                               // cream
    ['varske', 'varskes'],                                       // curd
    ['kiausiniai', 'kiausiniu', 'kiausinius'],                   // eggs
    ['jogurtas', 'jogurto'],                                     // yoghurt
    ['kefyras', 'kefyro'],                                       // kefir
    // ── meat / fish ──
    ['mesa', 'mesos', 'mesai'],                                  // meat
    ['vistiena', 'vistienos'],                                   // chicken
    ['kiauliena', 'kiaulienos'],                                 // pork
    ['jautiena', 'jautienos'],                                   // beef
    ['file', 'files'],                                           // fillet
    ['lasisa', 'lasisos', 'lasisu'],                             // salmon
    ['kumpis', 'kumpio'],                                        // ham
    // Sausage — 'desrele(s)' is a diminutive, not a case form, but a plan for
    // "dešra" and a till line for "dešrelės" are the same KIND of purchase.
    ['desra', 'desros', 'desrele', 'desreles'],
    // ── drinks ──
    ['vanduo', 'vandens', 'vandeni'],                            // water (irregular — no stemmer catches this)
    ['sultys', 'sulciu', 'sultis'],                              // juice
    ['alus', 'alaus'],                                           // beer
    ['vynas', 'vyno'],                                           // wine
    ['gira', 'giros'],                                           // kvass
];

/** surface form → canonical lemma. Built once at module load. */
const FORM_TO_LEMMA: Map<string, string> = (() => {
    const m = new Map<string, string>();
    for (const group of LT_LEMMA_GROUPS) {
        const lemma = group[0];
        for (const form of group) m.set(form, lemma);
    }
    return m;
})();

/**
 * Canonical form of one NORMALIZED token — unchanged when it isn't a known head
 * noun, so this is safe to apply to every token.
 */
export function lemmaOf(token: string): string {
    return FORM_TO_LEMMA.get(token) ?? token;
}

/** True when the token is a mapped head noun (used by the diagnostic). */
export function isKnownLemmaForm(token: string): boolean {
    return FORM_TO_LEMMA.has(token);
}

/** Every mapped form → lemma, for the invariant tests + diagnostics. */
export function lemmaEntries(): [string, string][] {
    return [...FORM_TO_LEMMA.entries()];
}
