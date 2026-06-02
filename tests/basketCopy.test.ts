import { copiedSourceTemplateId } from '../src/util/basketCopy.js';

describe('copiedSourceTemplateId', () => {
    it('keeps the template link when the basket was NOT edited', () => {
        expect(copiedSourceTemplateId(42, false)).toBe(42);
    });

    it('strips the template link when the basket WAS edited (copy becomes plain)', () => {
        expect(copiedSourceTemplateId(42, true)).toBeNull();
    });

    it('null source template stays null regardless of edit state', () => {
        expect(copiedSourceTemplateId(null, false)).toBeNull();
        expect(copiedSourceTemplateId(null, true)).toBeNull();
    });
});
