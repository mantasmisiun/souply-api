import { buildMandatorySequence, type SeqLine } from '../src/services/mandatoryQueueBuilder.js';

const L = (lineIdx: number, band: SeqLine['band'], needsHuman: number, lineTotalEur = 5): SeqLine =>
    ({ lineIdx, band, needsHuman, lineTotalEur });

describe('buildMandatorySequence', () => {
    it('serves the 2 highest needs-human uncertain lines as receipt cards + 1 cross-store = 3', () => {
        const lines = [L(0, 'S3', 0.9), L(1, 'S2', 0.5), L(2, 'S3', 0.7), L(3, 'S1', 0)];
        const seq = buildMandatorySequence(lines, new Set(), [3, 1]);
        expect(seq.filter((c) => c.kind === 'receipt').map((c) => c.lineIdx)).toEqual([0, 2]); // top-2 needs-human
        expect(seq.filter((c) => c.kind === 'crossStore').length).toBe(1);
        expect(seq.length).toBe(3);
    });

    it('S1 (confident) lines are never carded', () => {
        const seq = buildMandatorySequence([L(0, 'S1', 0), L(1, 'S1', 0)], new Set(), []);
        expect(seq.length).toBe(0);
    });

    it('already asked/resolved lines are suppressed (one shot)', () => {
        const lines = [L(0, 'S3', 0.9), L(1, 'S3', 0.8)];
        const seq = buildMandatorySequence(lines, new Set([0]), []);
        expect(seq.map((c) => c.lineIdx)).toEqual([1]); // line 0 suppressed
    });

    it('a clean receipt (no uncertain lines) fills up to 3 from cross-store, most-expensive first', () => {
        const lines = [L(5, 'S1', 0, 20), L(6, 'S1', 0, 8), L(7, 'S1', 0, 15), L(8, 'S1', 0, 2)];
        const seq = buildMandatorySequence(lines, new Set(), [6, 5, 7, 8]);
        expect(seq.every((c) => c.kind === 'crossStore')).toBe(true);
        expect(seq.map((c) => c.lineIdx)).toEqual([5, 7, 6]); // €20, €15, €8 — cheapest (€2) dropped at the cap
    });

    it('a line is carded at most once — its receipt card wins over its cross-store card', () => {
        const lines = [L(0, 'S3', 0.9, 30)];
        const seq = buildMandatorySequence(lines, new Set(), [0]); // line 0 is both eligible AND a cross-store anchor
        expect(seq).toEqual([{ kind: 'receipt', lineIdx: 0 }]);
    });

    it('never exceeds 3 cards, and never more than 2 receipt cards', () => {
        const lines = [L(0, 'S3', 0.9), L(1, 'S3', 0.8), L(2, 'S3', 0.7), L(3, 'S2', 0.6)];
        const seq = buildMandatorySequence(lines, new Set(), [10, 11]);
        expect(seq.length).toBe(3);
        expect(seq.filter((c) => c.kind === 'receipt').length).toBe(2);
    });
});
