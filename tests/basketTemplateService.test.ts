import {
    isAbandoned,
    isResumable,
    decideInstantiation,
    type BasketSnapshot,
} from '../src/services/basketTemplateService.js';

function snap(overrides: Partial<BasketSnapshot> & { id: number }): BasketSnapshot {
    return {
        status: 'draft',
        hasBeenCalculated: 0,
        userEditedAfterCreation: 0,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// isAbandoned
// ---------------------------------------------------------------------------

describe('isAbandoned', () => {
    it('returns true for a fresh draft basket with both flags off', () => {
        expect(isAbandoned(snap({ id: 1 }))).toBe(true);
    });

    it('returns false once the basket was calculated', () => {
        expect(isAbandoned(snap({ id: 1, hasBeenCalculated: 1 }))).toBe(false);
    });

    it('returns false once the user has edited it', () => {
        expect(isAbandoned(snap({ id: 1, userEditedAfterCreation: 1 }))).toBe(false);
    });

    it('returns false for completed baskets regardless of flags', () => {
        expect(isAbandoned(snap({ id: 1, status: 'completed' }))).toBe(false);
    });

    it('treats boolean true the same as numeric 1', () => {
        expect(isAbandoned(snap({ id: 1, hasBeenCalculated: true }))).toBe(false);
        expect(isAbandoned(snap({ id: 1, userEditedAfterCreation: true }))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// isResumable
// ---------------------------------------------------------------------------

describe('isResumable', () => {
    it('returns false for an abandoned draft', () => {
        expect(isResumable(snap({ id: 1 }))).toBe(false);
    });

    it('returns true after calculation', () => {
        expect(isResumable(snap({ id: 1, hasBeenCalculated: 1 }))).toBe(true);
    });

    it('returns true after user edit', () => {
        expect(isResumable(snap({ id: 1, userEditedAfterCreation: 1 }))).toBe(true);
    });

    it('returns false for completed baskets', () => {
        expect(isResumable(snap({ id: 1, status: 'completed', hasBeenCalculated: 1 }))).toBe(false);
    });

    it('returns true for inProgress (calculated)', () => {
        expect(isResumable(snap({ id: 1, status: 'inProgress', hasBeenCalculated: 1 }))).toBe(true);
    });

    it('returns true for compared status', () => {
        expect(isResumable(snap({ id: 1, status: 'compared', hasBeenCalculated: 1 }))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// decideInstantiation
// ---------------------------------------------------------------------------

describe('decideInstantiation', () => {
    it('returns createFresh with no abandoned ids when the user has no prior baskets', () => {
        expect(decideInstantiation([])).toEqual({
            kind: 'createFresh',
            deleteAbandonedIds: [],
        });
    });

    it('returns createFresh and prunes abandoned siblings', () => {
        const out = decideInstantiation([
            snap({ id: 10 }),
            snap({ id: 11 }),
        ]);
        expect(out.kind).toBe('createFresh');
        expect(out.deleteAbandonedIds.sort()).toEqual([10, 11]);
    });

    it('returns resumeExisting when a calculated basket exists', () => {
        const out = decideInstantiation([
            snap({ id: 7, hasBeenCalculated: 1 }),
        ]);
        expect(out).toEqual({
            kind: 'resumeExisting',
            basketId: 7,
            deleteAbandonedIds: [],
        });
    });

    it('returns resumeExisting when a user-edited basket exists', () => {
        const out = decideInstantiation([
            snap({ id: 5, userEditedAfterCreation: 1 }),
        ]);
        expect(out).toEqual({
            kind: 'resumeExisting',
            basketId: 5,
            deleteAbandonedIds: [],
        });
    });

    it('picks the highest-id resumable when multiple exist', () => {
        const out = decideInstantiation([
            snap({ id: 3, hasBeenCalculated: 1 }),
            snap({ id: 9, userEditedAfterCreation: 1 }),
            snap({ id: 5, hasBeenCalculated: 1 }),
        ]);
        expect(out.kind).toBe('resumeExisting');
        if (out.kind === 'resumeExisting') expect(out.basketId).toBe(9);
    });

    it('returns resumeExisting AND lists abandoned siblings to delete', () => {
        const out = decideInstantiation([
            snap({ id: 1 }),                                    // abandoned
            snap({ id: 2 }),                                    // abandoned
            snap({ id: 3, hasBeenCalculated: 1 }),              // resumable
        ]);
        expect(out.kind).toBe('resumeExisting');
        if (out.kind === 'resumeExisting') {
            expect(out.basketId).toBe(3);
            expect(out.deleteAbandonedIds.sort()).toEqual([1, 2]);
        }
    });

    it('ignores completed baskets entirely', () => {
        // Completed siblings should not block a fresh instantiation and
        // should not appear in the delete list.
        const out = decideInstantiation([
            snap({ id: 1, status: 'completed', hasBeenCalculated: 1 }),
            snap({ id: 2, status: 'completed', userEditedAfterCreation: 1 }),
        ]);
        expect(out).toEqual({
            kind: 'createFresh',
            deleteAbandonedIds: [],
        });
    });

    it('correctly mixes completed + abandoned + resumable', () => {
        const out = decideInstantiation([
            snap({ id: 100, status: 'completed', hasBeenCalculated: 1 }),  // ignored
            snap({ id: 200 }),                                              // abandoned
            snap({ id: 300, hasBeenCalculated: 1 }),                        // resumable
            snap({ id: 400 }),                                              // abandoned
        ]);
        expect(out.kind).toBe('resumeExisting');
        if (out.kind === 'resumeExisting') {
            expect(out.basketId).toBe(300);
            expect(out.deleteAbandonedIds.sort((a, b) => a - b)).toEqual([200, 400]);
        }
    });
});
