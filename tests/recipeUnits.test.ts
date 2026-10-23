/**
 * Data-integrity tests for the recipe unit tables. The tables are maintained
 * by hand for years — these tests exist to catch a fat-fingered edit (an
 * alias pointing at a unit that doesn't exist, a size constant drifting, a
 * three-word alias added without bumping MAX_UNIT_WORDS), not to re-derive
 * the data.
 */

import {
    UNIT_ALIASES,
    MAX_UNIT_WORDS,
    lookupUnit,
    MASS_G,
    VOLUME_ML,
    unitDimension,
    isVagueUnit,
} from '../src/services/recipes/units.js';
import type { Unit } from '../src/services/recipes/types.js';

/** Every member of the closed Unit union, spelled out by hand — if types.ts
 *  gains or loses a member, this array (and the tables) must be revisited. */
const ALL_UNITS: Unit[] = [
    // mass
    'g', 'kg', 'oz', 'lb',
    // volume
    'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'pint', 'quart', 'glass',
    // countable / vague
    'pcs', 'clove', 'slice', 'head', 'bunch', 'handful', 'pinch',
    'can', 'pack', 'sprig', 'stalk', 'sheet', 'drop', 'cm',
];

// ---------------------------------------------------------------------------
// UNIT_ALIASES integrity
// ---------------------------------------------------------------------------

describe('UNIT_ALIASES', () => {
    it('every alias maps to a legal Unit', () => {
        const legal = new Set<string>(ALL_UNITS);
        for (const [alias, unit] of Object.entries(UNIT_ALIASES)) {
            expect(legal.has(unit)).toBe(true);
            // keys are lowercase by contract
            expect(alias).toBe(alias.toLowerCase());
        }
    });

    it('every Unit is reachable through at least one alias', () => {
        const values = new Set(Object.values(UNIT_ALIASES));
        for (const u of ALL_UNITS) {
            expect(values.has(u)).toBe(true);
        }
    });

    // A duplicate key in the object literal silently drops the earlier entry
    // (TS flags it, but only at compile time of THAT file). Pinning the exact
    // count means any accidental add/drop shows up here with a diff to read.
    it('has exactly the audited number of aliases', () => {
        // Bumped when the Lithuanian spoon abbreviations ("valg. š.", "arb. š.")
        // and "puodelis" were added — see the corpus rows they recovered.
        // 316: 'each', the US listing unit in "1 each red onion".
        expect(Object.keys(UNIT_ALIASES).length).toBe(316);
    });

    it('MAX_UNIT_WORDS equals the longest key measured in words', () => {
        const longest = Math.max(
            ...Object.keys(UNIT_ALIASES).map(k => k.split(' ').length),
        );
        expect(MAX_UNIT_WORDS).toBe(longest);
    });
});

// ---------------------------------------------------------------------------
// lookupUnit — curated real forms straight from the corpus
// ---------------------------------------------------------------------------

describe('lookupUnit resolves real corpus forms', () => {
    const cases: Array<[string, Unit]> = [
        // Lithuanian spoons — every declension the sites actually print
        ['šaukštas', 'tbsp'],
        ['šaukšto', 'tbsp'],
        ['šaukštai', 'tbsp'],
        ['šaukštų', 'tbsp'],
        ['valgomasis šaukštas', 'tbsp'],
        ['valgomieji šaukštai', 'tbsp'],
        ['valgomųjų šaukštų', 'tbsp'],
        ['šaukštelis', 'tsp'],
        ['šaukštelio', 'tsp'],
        ['šaukšteliai', 'tsp'],
        ['arbatinis šaukštelis', 'tsp'],
        ['arbatinio šaukštelio', 'tsp'],
        ['arbatiniai šaukšteliai', 'tsp'],
        // Lithuanian mass / volume / count
        ['gramų', 'g'],
        ['gramai', 'g'],
        ['gr', 'g'],
        ['kilogramas', 'kg'],
        ['mililitrų', 'ml'],
        ['litro', 'l'],
        ['vienetas', 'pcs'],
        ['vienetai', 'pcs'],
        ['vieneto', 'pcs'],
        ['skiltelė', 'clove'],
        ['skiltelės', 'clove'],
        ['galvučių', 'head'],
        ['sauja', 'handful'],
        ['saujos', 'handful'],
        ['saujelė', 'handful'],
        ['žiupsnelis', 'pinch'],
        ['žiupsnelio', 'pinch'],
        ['pundelis', 'bunch'],
        ['ryšulėlio', 'bunch'],
        ['stiklinės', 'glass'],
        ['šakelių', 'sprig'],
        ['stiebas', 'stalk'],
        ['šlakelių', 'drop'],
        ['riekės', 'slice'],
        ['lapelių', 'sheet'],
        ['centimetrai', 'cm'],
        // English forms
        ['tsp', 'tsp'],
        ['teaspoons', 'tsp'],
        ['tbsp', 'tbsp'],
        ['tablespoon', 'tbsp'],
        ['cups', 'cup'],
        ['oz', 'oz'],
        ['ounce', 'oz'],
        ['lbs', 'lb'],
        ['pound', 'lb'],
        ['fl oz', 'floz'],
        ['fluid ounces', 'floz'],
        ['pint', 'pint'],
        ['quarts', 'quart'],
        ['cloves', 'clove'],
        ['tin', 'can'],
        ['jar', 'can'],
        ['punnet', 'pack'],
        ['packet', 'pack'],
        ['ribs', 'stalk'],
        ['handfuls', 'handful'],
        ['pieces', 'pcs'],
    ];

    it.each(cases)('%s → %s', (phrase, unit) => {
        expect(lookupUnit(phrase)).toBe(unit);
    });

    it('tolerates trailing periods, whitespace and case', () => {
        expect(lookupUnit('tsp.')).toBe('tsp');
        expect(lookupUnit('vnt.')).toBe('pcs');
        expect(lookupUnit('  TBSP  ')).toBe('tbsp');
        expect(lookupUnit('Šaukštas')).toBe('tbsp');
        expect(lookupUnit('fl. oz.')).toBe('floz');
        expect(lookupUnit('v. š.')).toBe('tbsp');
    });

    it('resolves diacritic-free typing', () => {
        expect(lookupUnit('sauksteliu')).toBe('tsp');
        expect(lookupUnit('ziupsneliai')).toBe('pinch');
        expect(lookupUnit('saukstas')).toBe('tbsp');
        expect(lookupUnit('valgomuju saukstu')).toBe('tbsp');
        expect(lookupUnit('stikline')).toBe('glass');
        expect(lookupUnit('sakeliu')).toBe('sprig');
    });

    it('returns null for non-units', () => {
        expect(lookupUnit('druskos')).toBeNull();
        expect(lookupUnit('vištienos')).toBeNull();
        expect(lookupUnit('chicken')).toBeNull();
        expect(lookupUnit('')).toBeNull();
        expect(lookupUnit('   ')).toBeNull();
        // deliberately unmapped: lowercase kills the t=tsp / T=tbsp distinction
        expect(lookupUnit('t')).toBeNull();
        expect(lookupUnit('T')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Size constants — the numbers ARE the product; pin them exactly
// ---------------------------------------------------------------------------

describe('MASS_G', () => {
    it('holds exactly the audited masses', () => {
        expect(MASS_G.g).toBe(1);
        expect(MASS_G.kg).toBe(1000);
        expect(MASS_G.oz).toBeCloseTo(28.3495, 4);
        expect(MASS_G.lb).toBeCloseTo(453.592, 3);
        expect(Object.keys(MASS_G).length).toBe(4);
    });
});

describe('VOLUME_ML', () => {
    it('holds exactly the audited volumes', () => {
        expect(VOLUME_ML.ml).toBe(1);
        expect(VOLUME_ML.l).toBe(1000);
        expect(VOLUME_ML.tsp).toBe(5);
        expect(VOLUME_ML.tbsp).toBe(15);
        expect(VOLUME_ML.cup).toBe(240);          // US cup — the EN sites are US
        expect(VOLUME_ML.floz).toBeCloseTo(29.5735, 4);
        expect(VOLUME_ML.pint).toBeCloseTo(473.176, 3);
        expect(VOLUME_ML.quart).toBeCloseTo(946.353, 3);
        expect(VOLUME_ML.glass).toBe(250);        // stiklinė ≠ cup, on purpose
        expect(VOLUME_ML.pinch).toBeCloseTo(0.4, 5);
        expect(VOLUME_ML.drop).toBeCloseTo(0.05, 5);
        expect(VOLUME_ML.handful).toBe(120);
        expect(Object.keys(VOLUME_ML).length).toBe(12);
    });
});

// ---------------------------------------------------------------------------
// unitDimension — total over the union, consistent with the tables
// ---------------------------------------------------------------------------

describe('unitDimension', () => {
    it('classifies every Unit member', () => {
        for (const u of ALL_UNITS) {
            expect(['mass', 'volume', 'count']).toContain(unitDimension(u));
        }
    });

    it('mass units and ONLY mass units appear in MASS_G', () => {
        for (const u of ALL_UNITS) {
            expect(u in MASS_G).toBe(unitDimension(u) === 'mass');
        }
    });

    it('volume units and ONLY volume units appear in VOLUME_ML', () => {
        for (const u of ALL_UNITS) {
            expect(u in VOLUME_ML).toBe(unitDimension(u) === 'volume');
        }
    });

    it('count units carry no size at all', () => {
        for (const u of ALL_UNITS.filter(x => unitDimension(x) === 'count')) {
            expect(u in MASS_G).toBe(false);
            expect(u in VOLUME_ML).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// isVagueUnit
// ---------------------------------------------------------------------------

describe('isVagueUnit', () => {
    const vague: Unit[] = [
        'pinch', 'handful', 'bunch', 'sprig', 'can', 'pack', 'slice',
        'head', 'stalk', 'cm', 'drop', 'sheet', 'glass',
    ];

    it('flags exactly the documented vague set', () => {
        for (const u of ALL_UNITS) {
            expect(isVagueUnit(u)).toBe(vague.includes(u));
        }
    });

    it('measured units are never vague', () => {
        expect(isVagueUnit('g')).toBe(false);
        expect(isVagueUnit('tsp')).toBe(false);
        expect(isVagueUnit('pcs')).toBe(false);
        expect(isVagueUnit('clove')).toBe(false);
    });
});
