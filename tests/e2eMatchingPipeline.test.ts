/**
 * END-TO-END recognition regression harness.
 *
 * Runs the REAL pipeline for each fixture: Round-1 `findBestProductMatches` →
 * Round-2 `applyPriceRound2Matching` (as-of-date price lookup mocked) →
 * `computeItemConfidence`, and asserts the verdict + the confidence BREAKDOWN so a
 * threshold/score tuning shows WHICH signal moved, not just a flipped boolean.
 *
 * The resolver's `source` (reused/created/bootstrapped/skipped_unpriced) is a
 * fixture INPUT — the resolver is DB-heavy and locked separately in
 * receiptLineResolver.test.ts; here we lock how its outcome feeds confidence.
 * Parse-stage incidents (salmon FUR €/kg, IKI price=0 poison) are locked in the
 * souply-app ikiReceipt*.test.ts word-box fixtures. New incident? add a fixture.
 */
import { jest } from '@jest/globals';

const mockGetAsOfDatePrices = jest.fn<any>();
jest.unstable_mockModule('../src/models/priceModel.js', () => ({
    getAsOfDatePricesForCandidates: mockGetAsOfDatePrices,
}));

const { findBestProductMatches } = await import('../src/utils/productMatcher.js');
const { applyPriceRound2Matching } = await import('../src/services/priceRound2Matcher.js');
const { computeItemConfidence } = await import('../src/services/itemConfidence.js');
const { RECOGNITION, confidenceBand } = await import('../../shared/recognitionConfig.js');

type Source = 'reused' | 'created' | 'bootstrapped' | 'skipped_unpriced' | 'none';

interface Fixture {
    id: string;
    desc: string;
    chainId: number;
    receiptDate: string;
    ocr: { name: string; amount: number | null; unit: string | null; isWeighable: boolean | null; price: number; pricePerUnit?: number | null; promoPrice?: number | null };
    candidates: Array<{ id: number; name: string; amount?: number | null; unit?: string | null; isWeighable?: boolean; productId?: number }>;
    asOfPrices: Record<string, { price: number; promoPrice?: number | null; promoEnd?: string | null }>;
    resolveSource: Source;
    expect: {
        topMatchId?: number | null;   // which candidate Round-1 chose (after Round-2)
        priceVerified?: boolean;
        priceImplausible?: boolean;
        band: 'S1' | 'S2' | 'S3';
        bandNot?: 'S1' | 'S2' | 'S3';
        vetoReason?: string | null;
        scoreMax?: number;
        scoreMin?: number;
    };
}

const cand = (c: Fixture['candidates'][number]) => ({
    id: c.id,
    productId: c.productId ?? c.id,
    categoryId: 1,
    categoryName: null,
    categoryL2Name: null,
    storeProductName: c.name,
    brandName: null,
    amount: c.amount ?? null,
    unit: c.unit ?? null,
    isWeighable: c.isWeighable ?? false,
    imageUrl: null,
});

async function run(fx: Fixture) {
    const matches = findBestProductMatches(fx.ocr.name, fx.ocr.amount, fx.ocr.unit, fx.candidates.map(cand), undefined, undefined, fx.ocr.isWeighable);
    const top = matches[0] ?? null;
    const line: any = {
        name: fx.ocr.name,
        storeProductId: top?.storeProductId ?? null,
        matchedName: top?.name ?? null,
        matchConfidence: top?.confidence ?? null,
        altMatches: matches.map((m) => ({ storeProductId: m.storeProductId, productId: m.productId, name: m.name, confidence: m.confidence, isWeighable: m.isWeighable })),
        price: fx.ocr.price,
        promoPrice: fx.ocr.promoPrice ?? null,
        pricePerUnit: fx.ocr.pricePerUnit ?? null,
        unit: fx.ocr.unit,
        isWeighable: fx.ocr.isWeighable,
    };
    mockGetAsOfDatePrices.mockResolvedValue(
        new Map(Object.entries(fx.asOfPrices).map(([k, v]) => [Number(k), { price: v.price, promoPrice: v.promoPrice ?? null, promoEnd: v.promoEnd ? new Date(v.promoEnd) : null }])),
    );
    const r2 = await applyPriceRound2Matching([line], fx.chainId, new Date(fx.receiptDate), 99999);
    const priceVerified = r2.perfect.has(0);
    const priceImplausible = r2.rejected.has(0);
    const alt = line.altMatches;
    const gap = alt.length >= 2 ? Number(alt[0].confidence) - Number(alt[1].confidence) : 0;
    const ic = computeItemConfidence({
        nameConf: line.matchConfidence,
        nameText: line.name,
        priceVerified,
        viaPromo: !!r2.perfect.get(0)?.viaPromo,
        gapToRunnerUp: gap > 0 ? gap : 0,
        source: fx.resolveSource,
        priceImplausible,
    });
    if (process.env.DUMP) {
        // eslint-disable-next-line no-console
        console.error(`[DUMP] ${fx.id}: chosen=${line.storeProductId} matchedName=${JSON.stringify(line.matchedName)} nameConf=${line.matchConfidence} pv=${priceVerified} pi=${priceImplausible} | band=${ic.band} score=${ic.score} base=${ic.base} ocrRel=${ic.ocrReliability} veto=${ic.vetoes.map((v: any) => v.reason).join(',')} ovr=${ic.override} | alts=${JSON.stringify(line.altMatches.map((a: any) => [a.storeProductId, Number(a.confidence).toFixed(2)]))}`);
    }
    return { chosenId: line.storeProductId as number | null, priceVerified, priceImplausible, ic };
}

const FIXTURES: Fixture[] = [
    {
        id: 'slyvos-cross-chain-weak',
        desc: 'RAUDONOSIOS PAPRIKOS matches cross-chain to "Raudonosios slyvos" (plums, 240) on the shared color word "raudonosios" — the reproduced receipt-108 incident. A weak (0.65) CREATED match must NOT show as a confirmed SP: lands S2 (OCR-primary + "patikrinti" review badge), never S1. Borderline S2/S3 by design (score≈0.653 vs the 0.65 cut) — a calibration nudge toward S3 is an intended improvement, not a regression.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'RAUDONOSIOS PAPRIKOS', amount: null, unit: 'kg', isWeighable: true, price: 3.49, pricePerUnit: 3.49 },
        candidates: [
            { id: 240, name: 'Raudonosios slyvos', isWeighable: true },
            { id: 22175, name: 'Raudonos aitriosios paprikos, 1kl.', isWeighable: true },
            { id: 205, name: 'Raudonosios vynuogės', isWeighable: true },
        ],
        asOfPrices: {},
        resolveSource: 'created',
        expect: { topMatchId: 240, band: 'S2', bandNot: 'S1', priceVerified: false, scoreMax: RECOGNITION.display.bandS1 - 0.0001 },
    },
    {
        id: 'pomidorai-gap-guard',
        desc: 'LIETUVISKI POMIDORAI: confident name match (60161) must NOT be overridden by the weak-name price-matching sibling Kekiniai (60149). Stays 60161, band S1.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'LIETUVISKI POMIDORAI', amount: null, unit: 'kg', isWeighable: true, price: 3.99, pricePerUnit: 3.99 },
        candidates: [
            { id: 60161, name: 'Lietuviški pomidorai', isWeighable: true },
            { id: 60149, name: 'Kekiniai pomidorai', isWeighable: true },
        ],
        asOfPrices: { '60161': { price: 4.49 }, '60149': { price: 3.99 } },
        resolveSource: 'reused',
        expect: { topMatchId: 60161, band: 'S1', priceVerified: false },
    },
    {
        id: 'naminis-packsize-price-confirm',
        desc: 'NAMINIS milk: 3 same-name pack sizes; the as-of-date price 1.49 confirms the 1L (55852). priceVerified → S1.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'NAMINIS 2,5 PIENAS', amount: null, unit: 'vnt', isWeighable: false, price: 1.49, pricePerUnit: 1.49 },
        candidates: [
            { id: 55852, name: 'Pusriebis Rokiškio pienas NAMINIS, 2,5% rieb.', amount: 1, unit: 'l' },
            { id: 55859, name: 'Rokiškio NAMINIS pienas, 2,5% rieb.', amount: 2, unit: 'l' },
            { id: 55865, name: 'Pusriebis Rokiškio NAMINIS pienas, 2,5% rieb.', amount: 500, unit: 'ml' },
        ],
        asOfPrices: { '55852': { price: 1.49 }, '55859': { price: 2.79 }, '55865': { price: 0.99 } },
        resolveSource: 'reused',
        expect: { topMatchId: 55852, priceVerified: true, band: 'S1' },
    },
    {
        id: 'price-implausible-veto',
        desc: 'A €5 line matched to a €25 SP (regular outside [0.4,2.5]×): Round-2 flags priceImplausible → veto caps to S3 regardless of a strong name.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'EXPENSIVE PRODUCT', amount: null, unit: 'vnt', isWeighable: false, price: 5.0, pricePerUnit: 5.0 },
        candidates: [{ id: 700, name: 'Expensive product' }],
        asOfPrices: { '700': { price: 25.0 } },
        resolveSource: 'reused',
        expect: { band: 'S3', priceImplausible: true, vetoReason: 'priceImplausible' },
    },
    {
        id: 'price-zero-skipped',
        desc: 'A garbled price≤0 line: resolver returns skipped_unpriced → heavy veto, S3 (show OCR, no SP).',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'ATI 1INES ASISOS 8E GAL', amount: null, unit: 'kg', isWeighable: true, price: 0, pricePerUnit: null },
        candidates: [{ id: 97631, name: 'ATI 1INES ASISOS 8E GAL 1,068 kg v 16 99 FUR/ kg', isWeighable: false }],
        asOfPrices: {},
        resolveSource: 'skipped_unpriced',
        expect: { band: 'S3', vetoReason: 'skippedUnpriced' },
    },
    {
        id: 'saffran-anchor-gate',
        desc: 'Single short garbled name "Airanas" must NOT fuzzy-match "Šafranas KOTANYI" (the €261 saffron blowup). Anchor gate rejects → no match → S3.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'Airanas', amount: null, unit: null, isWeighable: false, price: 1.2, pricePerUnit: 1.2 },
        candidates: [{ id: 5001, name: 'Šafranas KOTANYI' }],
        asOfPrices: {},
        resolveSource: 'created',
        expect: { topMatchId: null, band: 'S3' },
    },
    {
        id: 'zewa-size-penalty',
        desc: 'ZEWA same-name pack variants: the matcher must prefer the 32-roll over the 12-roll for a 32-roll OCR line (size bonus/penalty).',
        chainId: 1, receiptDate: '2026-06-11',
        ocr: { name: 'ZEWA EVERYDAY', amount: 32, unit: 'rit', isWeighable: false, price: 8.99, pricePerUnit: 8.99 },
        candidates: [
            { id: 8001, name: 'ZEWA EVERYDAY', amount: 12, unit: 'rit' },
            { id: 8002, name: 'ZEWA EVERYDAY', amount: 32, unit: 'rit' },
        ],
        asOfPrices: {},
        resolveSource: 'reused',
        expect: { topMatchId: 8002, band: 'S1' },
    },
    {
        id: 'apples-not-potatoes',
        desc: 'Packaged apples "Fasuoti obuoliai IKI ŪKIS" (OCR-garbled to "obuol ia1 … OKIS") must NOT match packaged potatoes "Fasuotos bulvės LAURA IKI ŪKIS" on the shared brand/packaging tokens (Fasuot…/IKI/ŪKIS). The distinguishing-noun penalty docks the token lane (obuol↔bulvės disagree) and the strings are too different for the char lane, so potatoes falls below the 0.4 floor → no wrong match (resolver then mints a fresh apples Product).',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'Fasuoti obuol ia1 IKI OKIS', amount: null, unit: 'kg', isWeighable: true, price: 1.85, pricePerUnit: 1.85 },
        candidates: [{ id: 60178, name: 'Fasuotos bulvės LAURA IKI ŪKIS', isWeighable: false }],
        asOfPrices: {},
        resolveSource: 'created',
        expect: { topMatchId: null, band: 'S3' },
    },
    {
        id: 'apples-spare-real',
        desc: 'The noun-penalty must SPARE the genuine apples SP: with both potatoes and a real "Fasuoti obuoliai IKI ŪKIS" in the pool, obuol↔obuoliai is an OCR truncation (sim ≥ floor) so apples is not penalized and wins decisively; potatoes is dropped.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'Fasuoti obuol ia1 IKI OKIS', amount: null, unit: 'kg', isWeighable: true, price: 1.85, pricePerUnit: 1.85 },
        // Both are catalog-"packaged" (isWeighable=0) with NO fixed pack size — the
        // real fasuoti produce: the relaxed weighable gate lets them into a by-weight
        // line, then the noun-penalty drops potatoes and the real apples wins.
        candidates: [
            { id: 60178, name: 'Fasuotos bulvės LAURA IKI ŪKIS', isWeighable: false },
            { id: 99001, name: 'Fasuoti obuoliai IKI ŪKIS', isWeighable: false },
        ],
        asOfPrices: {},
        resolveSource: 'created',
        expect: { topMatchId: 99001, band: 'S2', bandNot: 'S1' },
    },
    {
        id: 'reject-boundary-just-inside',
        desc: 'BOUNDARY at price.rejectHigh (2.5×): observed 12.00 vs chain 5.00 = 2.4× is INSIDE the sane band → fail-open, NOT priceImplausible. Strong name stays S1.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'BOUNDARY ITEM', amount: null, unit: 'vnt', isWeighable: false, price: 12.0, pricePerUnit: 12.0 },
        candidates: [{ id: 900, name: 'Boundary item' }],
        asOfPrices: { '900': { price: 5.0 } },
        resolveSource: 'reused',
        expect: { topMatchId: 900, priceImplausible: false, band: 'S1' },
    },
    {
        id: 'reject-boundary-just-outside',
        desc: 'BOUNDARY at price.rejectHigh (2.5×): observed 13.00 vs chain 5.00 = 2.6× is OUTSIDE the sane band, no plausible sibling → priceImplausible veto → S3. Brackets the 2.5 cutoff against the above.',
        chainId: 3, receiptDate: '2026-06-11',
        ocr: { name: 'BOUNDARY ITEM', amount: null, unit: 'vnt', isWeighable: false, price: 13.0, pricePerUnit: 13.0 },
        candidates: [{ id: 900, name: 'Boundary item' }],
        asOfPrices: { '900': { price: 5.0 } },
        resolveSource: 'reused',
        expect: { topMatchId: 900, priceImplausible: true, band: 'S3', vetoReason: 'priceImplausible' },
    },
];

describe('e2e recognition pipeline regression', () => {
    beforeEach(() => mockGetAsOfDatePrices.mockReset());

    for (const fx of FIXTURES) {
        it(`${fx.id} — ${fx.desc}`, async () => {
            const r = await run(fx);
            if (fx.expect.topMatchId !== undefined) expect(r.chosenId).toBe(fx.expect.topMatchId);
            if (fx.expect.priceVerified !== undefined) expect(r.priceVerified).toBe(fx.expect.priceVerified);
            if (fx.expect.priceImplausible !== undefined) expect(r.priceImplausible).toBe(fx.expect.priceImplausible);
            expect(r.ic.band).toBe(fx.expect.band);
            if (fx.expect.bandNot) expect(r.ic.band).not.toBe(fx.expect.bandNot);
            if (fx.expect.vetoReason) expect(r.ic.vetoes.some((v: any) => v.reason === fx.expect.vetoReason)).toBe(true);
            if (fx.expect.scoreMax !== undefined) expect(r.ic.score).toBeLessThanOrEqual(fx.expect.scoreMax);
            if (fx.expect.scoreMin !== undefined) expect(r.ic.score).toBeGreaterThanOrEqual(fx.expect.scoreMin);
        });
    }
});

describe('band cutoffs are inclusive at the exact edges', () => {
    const s1 = RECOGNITION.display.bandS1; // 0.85
    const s2 = RECOGNITION.display.bandS2; // 0.65
    it('cutoffs are ordered', () => expect(s1).toBeGreaterThan(s2));
    it(`>= ${s1} → S1, just below → S2`, () => {
        expect(confidenceBand(s1)).toBe('S1');
        expect(confidenceBand(s1 - 1e-9)).toBe('S2');
    });
    it(`>= ${s2} → S2, just below → S3`, () => {
        expect(confidenceBand(s2)).toBe('S2');
        expect(confidenceBand(s2 - 1e-9)).toBe('S3');
    });
    it('0 and 1 land in the extreme bands', () => {
        expect(confidenceBand(0)).toBe('S3');
        expect(confidenceBand(1)).toBe('S1');
    });
});
