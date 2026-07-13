import { sharesRequiredAnchor, significantTokens } from '../src/utils/nameMatchGate.js';

describe('significantTokens', () => {
    it('keeps words ≥4 chars, drops units / numbers / short fragments', () => {
        expect(significantTokens('ILZENBERGO DVARO airanas, 1 % rieb., 500 ml'))
            .toEqual(expect.arrayContaining(['ilzenbergo', 'dvaro', 'airanas']));
        expect(significantTokens('Pienas 2,5 % 1 l')).toEqual(['pienas']);
    });

    it('folds diacritics so š→s', () => {
        expect(significantTokens('Šafranas KOTANYI')).toEqual(['safranas', 'kotanyi']);
    });
});

describe('sharesRequiredAnchor', () => {
    it('rejects a single-significant-token name with no exact shared token (the incident)', () => {
        expect(sharesRequiredAnchor('Airanas', 'Šafranas KOTANYI')).toBe(false);
    });

    it('accepts the real airanas products — they contain the exact token "airanas"', () => {
        expect(sharesRequiredAnchor('Airanas', 'ILZENBERGO DVARO airanas, 1 % rieb., 500 ml')).toBe(true);
        expect(sharesRequiredAnchor(
            'Airanas',
            'Rytietiškas rauginto pieno gėrimas AIRANAS 2 LIFE., 1 % rieb., 500 ml',
        )).toBe(true);
    });

    it('rejects two different single-word names that only rhyme', () => {
        expect(sharesRequiredAnchor('Airanas', 'Šafranas')).toBe(false);
        expect(sharesRequiredAnchor('Sviestas', 'Sviestuvas')).toBe(false);
    });

    it('defers (true) when both names have ≥2 significant tokens — the pienas merge', () => {
        expect(sharesRequiredAnchor('Rokiškio Naminis pienas 2.5%', 'Naminis 2.5% pienas')).toBe(true);
    });

    it('accepts an exact single-token match against a longer name', () => {
        expect(sharesRequiredAnchor('Bananai', 'Bananai Chiquita')).toBe(true);
    });

    it('is permissive when a side has no significant tokens (cannot judge)', () => {
        expect(sharesRequiredAnchor('2 l', 'Pienas')).toBe(true);
    });
});
