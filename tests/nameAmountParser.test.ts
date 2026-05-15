import { parseAmountFromName, amountsAgree, isWeighableForUnit } from '../src/utils/nameAmountParser.js';

describe('parseAmountFromName', () => {
    describe('weight units', () => {
        it.each([
            ['Sūris RIMI SMART 200g',         200, 'g'],
            ['Sūris 200 g',                   200, 'g'],
            ['Sūris 200gr',                   200, 'g'],
            ['Sūris 200 gr.',                 200, 'g'],
            ['Sūris 200 GR',                  200, 'g'],
            ['Bulvės 1kg',                    1, 'kg'],
            ['Bulvės 1,5 kg',                 1.5, 'kg'],
            ['Bulvės 0,5kg',                  0.5, 'kg'],
            ['Bulvės 0.5kg',                  0.5, 'kg'],
            ['Mėsa, 500g',                    500, 'g'],
        ])('"%s" → %d %s', (name, amount, unit) => {
            const r = parseAmountFromName(name);
            expect(r).not.toBeNull();
            expect(r!.amount).toBeCloseTo(amount, 4);
            expect(r!.unit).toBe(unit);
        });
    });

    describe('volume units', () => {
        it.each([
            ['Pienas Dobilas 1L',             1, 'l'],
            ['Pienas Dobilas 1 l',            1, 'l'],
            ['Pienas Dobilas 1 L',            1, 'l'],
            ['Pienas Dobilas, 1L',            1, 'l'],
            ['Vanduo 1,5 l',                  1.5, 'l'],
            ['Gėrimas 500 ml',                500, 'ml'],
            ['Gėrimas 500ml',                 500, 'ml'],
        ])('"%s" → %d %s', (name, amount, unit) => {
            const r = parseAmountFromName(name);
            expect(r).not.toBeNull();
            expect(r!.amount).toBeCloseTo(amount, 4);
            expect(r!.unit).toBe(unit);
        });
    });

    describe('piece units', () => {
        it.each([
            ['Kiaušiniai 10 vnt',             10, 'vnt'],
            ['Kiaušiniai 10 vnt.',            10, 'vnt'],
            ['Kiaušiniai 10vnt.',             10, 'vnt'],
            ['Tualetinis popierius 8 rit.',   8, 'rit'],
            ['Tualetinis popierius 8 rit',    8, 'rit'],
            ['Servetėlės 12 ritės',           12, 'rit'],
        ])('"%s" → %d %s', (name, amount, unit) => {
            const r = parseAmountFromName(name);
            expect(r).not.toBeNull();
            expect(r!.amount).toBeCloseTo(amount, 4);
            expect(r!.unit).toBe(unit);
        });
    });

    describe('returns null for unparseable input', () => {
        it.each([
            [''],
            ['Daržovės'],
            ['Pienas 2,5%'],          // percent only, no size
            ['Saldainiai Fortuna'],   // no number
            ['Daržovių rinkinys'],    // no unit
        ])('"%s" → null', (name) => {
            expect(parseAmountFromName(name)).toBeNull();
        });
    });

    describe('returns null for multi-pack ambiguity', () => {
        it('10 x 100g → null', () => {
            expect(parseAmountFromName('Sūreliai 10 x 100g')).toBeNull();
        });
        it('6 X 0,5l → null', () => {
            expect(parseAmountFromName('Vanduo Vichy 6 X 0,5l')).toBeNull();
        });
        it('handles × Unicode multiplier → null', () => {
            expect(parseAmountFromName('Sūreliai 10×100g')).toBeNull();
        });
    });

    describe('handles fat-percent without confusing it for unit', () => {
        it('"Pienas Dobilas 2,5% 1L" → {1, l} (last match wins, % not a unit)', () => {
            const r = parseAmountFromName('Pienas Dobilas 2,5% 1L');
            expect(r).not.toBeNull();
            expect(r!.amount).toBeCloseTo(1, 4);
            expect(r!.unit).toBe('l');
        });
    });

    describe('lookahead prevents false matches inside Lithuanian words', () => {
        it('"Lazerinė žvejotos žuvies filė 200g" still parses correctly', () => {
            const r = parseAmountFromName('Lazerinė žvejotos žuvies filė 200g');
            expect(r).not.toBeNull();
            expect(r!.unit).toBe('g');
        });
        it('"Grūdai kava" — no number, no match', () => {
            // "Grūdai" starts with 'g' but no preceding digit → not matched
            expect(parseAmountFromName('Grūdai kava')).toBeNull();
        });
    });

    describe('matched substring preserves original casing for debug surface', () => {
        it('captures the literal text', () => {
            const r = parseAmountFromName('Sūris RIMI SMART 200g');
            expect(r?.matched).toContain('200');
        });
    });
});

describe('amountsAgree', () => {
    it('exact match', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: 200, unit: 'g' },
        )).toBe(true);
    });

    it('equivalent across kg ↔ g', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: 0.2, unit: 'kg' },
        )).toBe(true);
    });

    it('equivalent across l ↔ ml', () => {
        expect(amountsAgree(
            { amount: 1, unit: 'l', matched: '1l' },
            { amount: 1000, unit: 'ml' },
        )).toBe(true);
    });

    it('within ±1 % tolerance', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: 201, unit: 'g' },
        )).toBe(true);
    });

    it('outside ±1 % tolerance', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: 250, unit: 'g' },
        )).toBe(false);
    });

    it('different dimensions (mass vs volume) never agree', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: 200, unit: 'ml' },
        )).toBe(false);
    });

    it('null stored amount → false (so admin sees it)', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: null, unit: 'g' },
        )).toBe(false);
    });

    it('null stored unit → false', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: 200, unit: null },
        )).toBe(false);
    });

    it('unknown stored unit string → false', () => {
        expect(amountsAgree(
            { amount: 200, unit: 'g', matched: '200g' },
            { amount: 200, unit: 'oz' },
        )).toBe(false);
    });
});

describe('isWeighableForUnit', () => {
    it('g/kg are weighable', () => {
        expect(isWeighableForUnit('g')).toBe(true);
        expect(isWeighableForUnit('kg')).toBe(true);
    });
    it('ml/l/vnt/rit are NOT weighable', () => {
        expect(isWeighableForUnit('ml')).toBe(false);
        expect(isWeighableForUnit('l')).toBe(false);
        expect(isWeighableForUnit('vnt')).toBe(false);
        expect(isWeighableForUnit('rit')).toBe(false);
    });
});
