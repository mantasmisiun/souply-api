import { normalizeCoverColor, normalizeCoverImage } from '../src/util/coverIdentity.js';

describe('normalizeCoverColor', () => {
    it('accepts valid hex colours and trims whitespace', () => {
        expect(normalizeCoverColor('#EB6784')).toBe('#EB6784');
        expect(normalizeCoverColor('  #fff  ')).toBe('#fff');
        expect(normalizeCoverColor('#11223344')).toBe('#11223344'); // 8-digit (alpha)
    });
    it('rejects non-hex / malformed / non-string', () => {
        expect(normalizeCoverColor('EB6784')).toBeNull();   // missing #
        expect(normalizeCoverColor('#xyz')).toBeNull();      // non-hex
        expect(normalizeCoverColor('#12')).toBeNull();       // too short
        expect(normalizeCoverColor('red')).toBeNull();
        expect(normalizeCoverColor(123 as unknown)).toBeNull();
        expect(normalizeCoverColor(null)).toBeNull();
        expect(normalizeCoverColor(undefined)).toBeNull();
    });
});

describe('normalizeCoverImage', () => {
    it('accepts a preset image', () => {
        expect(normalizeCoverImage({ kind: 'preset', iconKey: 'salad' })).toEqual({ kind: 'preset', iconKey: 'salad' });
    });
    it('accepts an emoji image', () => {
        expect(normalizeCoverImage({ kind: 'emoji', emoji: '🫜' })).toEqual({ kind: 'emoji', emoji: '🫜' });
    });
    it('strips unknown fields, keeping only the shape', () => {
        expect(normalizeCoverImage({ kind: 'emoji', emoji: '🥑', evil: 1 })).toEqual({ kind: 'emoji', emoji: '🥑' });
    });
    it('rejects malformed payloads', () => {
        expect(normalizeCoverImage({ kind: 'preset' })).toBeNull();          // missing iconKey
        expect(normalizeCoverImage({ kind: 'emoji', emoji: 5 })).toBeNull(); // non-string
        expect(normalizeCoverImage({ kind: 'other' })).toBeNull();
        expect(normalizeCoverImage('🫜')).toBeNull();
        expect(normalizeCoverImage(null)).toBeNull();
    });
});
