import { detectUnitConflict } from '../src/utils/unitConflict.js';

describe('detectUnitConflict', () => {
    it('g vs kg → no conflict (same mass class)', () => {
        expect(detectUnitConflict('g', 'kg')).toBe(false);
    });

    it('ml vs l → no conflict (same volume class)', () => {
        expect(detectUnitConflict('ml', 'l')).toBe(false);
    });

    it('vnt vs vnt → no conflict (same piece class)', () => {
        expect(detectUnitConflict('vnt', 'vnt')).toBe(false);
    });

    it('g vs ml → conflict (mass vs volume)', () => {
        expect(detectUnitConflict('g', 'ml')).toBe(true);
    });

    it('kg vs l → conflict (mass vs volume)', () => {
        expect(detectUnitConflict('kg', 'l')).toBe(true);
    });

    it('g vs vnt → conflict (mass vs piece)', () => {
        expect(detectUnitConflict('g', 'vnt')).toBe(true);
    });

    it('ml vs vnt → conflict (volume vs piece)', () => {
        expect(detectUnitConflict('ml', 'vnt')).toBe(true);
    });

    it('ml vs g → conflict (symmetric)', () => {
        expect(detectUnitConflict('ml', 'g')).toBe(true);
    });

    it('null vs g → no conflict (unknown side)', () => {
        expect(detectUnitConflict(null, 'g')).toBe(false);
    });

    it('g vs null → no conflict (unknown side)', () => {
        expect(detectUnitConflict('g', null)).toBe(false);
    });

    it('null vs null → no conflict', () => {
        expect(detectUnitConflict(null, null)).toBe(false);
    });

    it('undefined vs ml → no conflict', () => {
        expect(detectUnitConflict(undefined, 'ml')).toBe(false);
    });

    it("'unknown-unit' vs 'g' → no conflict (unrecognised treated as unknown)", () => {
        expect(detectUnitConflict('unknown-unit', 'g')).toBe(false);
    });

    it("'vnt.' vs 'vnt' → no conflict (piece variants)", () => {
        expect(detectUnitConflict('vnt.', 'vnt')).toBe(false);
    });
});
