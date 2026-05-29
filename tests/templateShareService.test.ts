import {
    generateSlug,
    SHARE_SLUG_LENGTH,
    pickSnapshotFromStoreResults,
} from '../src/services/templateShareService.js';

// ---------------------------------------------------------------------------
// generateSlug
// ---------------------------------------------------------------------------

describe('generateSlug', () => {
    it('returns a string of the configured length', () => {
        const s = generateSlug();
        expect(s).toHaveLength(SHARE_SLUG_LENGTH);
    });

    it('only contains lowercase alphanumeric characters', () => {
        for (let i = 0; i < 50; i++) {
            expect(generateSlug()).toMatch(/^[a-z0-9]+$/);
        }
    });

    it('generates distinct values across calls (collision rate is negligible at 36^10)', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) seen.add(generateSlug());
        // Allow a couple of collisions just in case Math.random() somehow
        // produces a dupe, but 200 distinct draws out of 200 attempts is
        // overwhelmingly likely.
        expect(seen.size).toBeGreaterThan(195);
    });
});

// ---------------------------------------------------------------------------
// pickSnapshotFromStoreResults
// ---------------------------------------------------------------------------

function store(chainId: number, total: number, missing = 0) {
    return { chainId, total, missingItemCount: missing };
}

describe('pickSnapshotFromStoreResults', () => {
    it('returns nulls for empty input', () => {
        expect(pickSnapshotFromStoreResults([] as any)).toEqual({
            cheapestChainId: null,
            cheapestTotalEur: null,
            runnerUpTotalEur: null,
            mostExpensiveTotalEur: null,
        });
    });

    it('picks the lowest total when chains have full coverage', () => {
        const out = pickSnapshotFromStoreResults([
            store(1, 30),
            store(2, 25),
            store(3, 40),
        ] as any);
        expect(out).toEqual({
            cheapestChainId: 2,
            cheapestTotalEur: 25,
            runnerUpTotalEur: 30,
            mostExpensiveTotalEur: 40,
        });
    });

    it('groups multiple stores per chain to a single cheapest entry', () => {
        // Two stores in chain 1: one cheaper. Snapshot uses the cheaper.
        const out = pickSnapshotFromStoreResults([
            store(1, 35),
            store(1, 22),
            store(2, 25),
        ] as any);
        expect(out.cheapestChainId).toBe(1);
        expect(out.cheapestTotalEur).toBe(22);
        expect(out.runnerUpTotalEur).toBe(25);
    });

    it('prefers fewer missing items over lower total', () => {
        // Chain 1: total 20 but missing 2 items. Chain 2: total 25 full coverage.
        const out = pickSnapshotFromStoreResults([
            store(1, 20, 2),
            store(2, 25, 0),
        ] as any);
        expect(out.cheapestChainId).toBe(2);
    });

    it('falls back to total when missing counts tie', () => {
        const out = pickSnapshotFromStoreResults([
            store(1, 28, 1),
            store(2, 30, 1),
        ] as any);
        expect(out.cheapestChainId).toBe(1);
    });

    it('omits runner-up when only one chain is in results', () => {
        const out = pickSnapshotFromStoreResults([store(7, 18)] as any);
        expect(out.cheapestChainId).toBe(7);
        expect(out.cheapestTotalEur).toBe(18);
        expect(out.runnerUpTotalEur).toBeNull();
    });

    it('skips rows whose chainId is not finite', () => {
        const out = pickSnapshotFromStoreResults([
            { chainId: NaN, total: 5, missingItemCount: 0 },
            store(1, 12),
        ] as any);
        expect(out.cheapestChainId).toBe(1);
    });
});
