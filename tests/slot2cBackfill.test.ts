import { jest } from '@jest/globals';

/**
 * Slot 2c — receipt-scoped orphan backfill for FREE mandatory slots. Pools are
 * mocked at the SQL layer; the trigram-block → Levenshtein → price-bonus composite
 * and the one-card-per-orphan / voted-pair / floor rules run for real.
 */
const mockScope = jest.fn<any>();
jest.unstable_mockModule('../src/services/receiptRelatednessService.js', () => ({
    getReceiptRelatednessScope: mockScope,
    isCardRelated: jest.fn(),
    isCardRelatedByCategory: jest.fn(),
}));
const mockVotedKeys = jest.fn<any>();
jest.unstable_mockModule('../src/models/votedPairsModel.js', () => ({
    fetchVotedPairKeys: mockVotedKeys,
}));
const mockQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockQuery },
}));

const { buildSlot2cBackfill } = await import('../src/services/slot2cBackfillService.js');

const poolRow = (spId: number, productId: number, name: string, o: Record<string, any> = {}) => ({
    spId, productId, name, brandName: null, imageUrl: null, unit: null,
    chainId: 3, chainName: 'IKI', chainLogoUrl: null, categoryId: 50, categoryName: 'Sūriai', ...o,
});

function wireDb(candidates: any[], orphans: any[], prices: Array<{ storeProductId: number; price: number }> = []) {
    mockQuery.mockImplementation(async (sql: string) => {
        if (/FROM ReceiptItem/.test(sql)) return [[]]; // seed query — no receipt-orphan seeds here
        if (/categoryId IN/.test(sql)) return [candidates];
        if (/categoryId = 688/.test(sql)) return [orphans];
        if (/FROM Price WHERE storeProductId IN/.test(sql)) return [prices];
        return [[]];
    });
}

beforeEach(() => {
    mockScope.mockReset();
    mockVotedKeys.mockReset();
    mockQuery.mockReset();
    mockScope.mockResolvedValue({ categoryIds: new Set([50]), lineNames: [], chainIds: new Set([3]) });
    mockVotedKeys.mockResolvedValue(new Set());
});

describe('buildSlot2cBackfill', () => {
    it('pairs a name-similar orphan with a categorised candidate as a slot-2 card (source 2c)', async () => {
        wireDb(
            [poolRow(100, 1000, 'Puskietis fermentinis sūris LILIPUTAS, 50 % rieb.', { chainId: 1, chainName: 'Maxima' })],
            [poolRow(200, 2000, 'Puskietis sūris "Liliputas" 50%, r.s.m.', { categoryId: 688, categoryName: 'Nepriskirta' })],
        );
        const items = await buildSlot2cBackfill('u1', 237, 2);
        expect(items).toHaveLength(1);
        expect(items[0].source).toBe('2c');
        expect(items[0].slot).toBe(2);
        expect(items[0].orphanSpId).toBe(200);
        expect(items[0].candidateSpId).toBe(100);
        expect(items[0].cardId).toBe('100-200'); // canonical min-max — dedups vs 2a/2b client-side
        expect(items[0].sameChain).toBe(false);
    });

    it('price agreement adds the corroboration bonus', async () => {
        const cand = poolRow(100, 1000, 'Varškės sūrelis MAGIJA vanilinis');
        const orph = poolRow(200, 2000, 'Varškės sūrelis MAGIJA vaniliniss', { categoryId: 688 });
        wireDb([cand], [orph]);
        const noPriceScore = (await buildSlot2cBackfill('u1', 237, 2))[0].score;
        wireDb([cand], [orph], [{ storeProductId: 100, price: 1.19 }, { storeProductId: 200, price: 1.19 }]);
        const withPriceScore = (await buildSlot2cBackfill('u1', 237, 2))[0].score;
        expect(withPriceScore).toBeGreaterThan(noPriceScore);
    });

    it('unrelated names never pair (floor), and already-voted pairs are suppressed', async () => {
        wireDb(
            [poolRow(100, 1000, 'Šampūnas su kofeinu ALPECIN')],
            [poolRow(200, 2000, 'Puskietis sūris "Liliputas" 50%', { categoryId: 688 })],
        );
        expect(await buildSlot2cBackfill('u1', 237, 2)).toEqual([]);

        wireDb(
            [poolRow(100, 1000, 'Puskietis fermentinis sūris LILIPUTAS 50%')],
            [poolRow(200, 2000, 'Puskietis sūris Liliputas 50%', { categoryId: 688 })],
        );
        mockVotedKeys.mockResolvedValue(new Set(['100-200']));
        expect(await buildSlot2cBackfill('u1', 237, 2)).toEqual([]);
    });

    it('serves ONE card per orphan — its best candidate wins', async () => {
        wireDb(
            [
                poolRow(100, 1000, 'Puskietis sūris Liliputas 50% rieb'),
                poolRow(101, 1001, 'Puskietis sūris Liliputas 50%'),
            ],
            [poolRow(200, 2000, 'Puskietis sūris Liliputas 50%', { categoryId: 688 })],
        );
        const items = await buildSlot2cBackfill('u1', 237, 3);
        expect(items).toHaveLength(1);
        expect(items[0].candidateSpId).toBe(101); // the closer name
    });

    it('no matched categories on the receipt → no backfill (never pads with junk)', async () => {
        mockScope.mockResolvedValue({ categoryIds: new Set(), lineNames: [], chainIds: new Set([3]) });
        expect(await buildSlot2cBackfill('u1', 237, 2)).toEqual([]);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('respects k', async () => {
        wireDb(
            [
                poolRow(100, 1000, 'Puskietis sūris Liliputas 50%'),
                poolRow(101, 1001, 'Pieno gėrimas MULLERMILCH bananų'),
            ],
            [
                poolRow(200, 2000, 'Puskietis sūris Liliputass 50%', { categoryId: 688 }),
                poolRow(201, 2001, 'Pieno gėrimas MULLERMILCH bananu', { categoryId: 688 }),
            ],
        );
        expect(await buildSlot2cBackfill('u1', 237, 1)).toHaveLength(1);
        expect(await buildSlot2cBackfill('u1', 237, 0)).toEqual([]);
    });
});

/**
 * TARGETED SEED CANDIDATE rescue — the coverage fix. The scope candidate pool is a
 * bounded LIMIT sample of a large sibling-broadened family, so it routinely EXCLUDES
 * the exact categorised sibling a receipt's OWN orphan (688 seed) needs — leaving the
 * seed with no pair. For each seed we fish its counterpart from the WHOLE catalog by a
 * significant-token name search (the `categoryId <> 688` query below), merge it into the
 * pool, and let the existing floor/pairing gates decide.
 */
function wireSeeded(opts: {
    seeds: Array<{ spId: number }>;
    scopeCandidates: any[];
    orphans: any[];
    targeted: any[];
    aliases?: any[];
    prices?: Array<{ storeProductId: number; price: number }>;
}) {
    const { seeds, scopeCandidates, orphans, targeted, aliases = [], prices = [] } = opts;
    mockQuery.mockImplementation(async (sql: string) => {
        if (/FROM ReceiptItem/.test(sql)) return [seeds];
        if (/FROM OrphanSwipeCandidate/.test(sql)) return [[]];          // skip the precomputed fast path
        if (/FROM StoreProductReceiptAlias/.test(sql)) return [aliases];
        if (/categoryId <> 688/.test(sql)) return [targeted];           // the targeted seed search
        if (/categoryId IN/.test(sql)) return [scopeCandidates];        // scope pool (excludes the sibling)
        if (/categoryId = 688/.test(sql)) return [orphans];
        if (/FROM Price WHERE storeProductId IN/.test(sql)) return [prices];
        return [[]];
    });
}

describe('buildSlot2cBackfill — targeted seed candidate rescue', () => {
    it('rescues a seed whose categorised sibling was sampled OUT of the scope pool', async () => {
        mockScope.mockResolvedValue({ categoryIds: new Set([5]), lineNames: [], chainIds: new Set([3]) });
        wireSeeded({
            seeds: [{ spId: 300 }],
            // scope pool holds an unrelated categorised product — the real sibling is NOT here.
            scopeCandidates: [poolRow(100, 1000, 'Šampūnas su kofeinu ALPECIN', { categoryId: 20 })],
            // the receipt's OWN orphan line (688) — the seed.
            orphans: [poolRow(300, 3000, 'Plautos morkos CLEVER', { categoryId: 688, categoryName: 'Nepriskirta' })],
            // its categorised sibling, reachable ONLY via the targeted name search.
            targeted: [poolRow(101, 1001, 'Plautos morkos', { categoryId: 5, categoryName: 'Daržovės' })],
        });
        const items = await buildSlot2cBackfill('u1', 237, 2);
        expect(items).toHaveLength(1);
        expect(items[0].source).toBe('2c');
        expect(items[0].orphanSpId).toBe(300);
        expect(items[0].candidateSpId).toBe(101); // came from the targeted search, not the scope pool
        expect(items[0].cardId).toBe('101-300');
    });

    it('a seed with no floor-clearing counterpart yields no card (search runs, still honest)', async () => {
        mockScope.mockResolvedValue({ categoryIds: new Set([109]), lineNames: [], chainIds: new Set([3]) });
        wireSeeded({
            seeds: [{ spId: 400 }],
            scopeCandidates: [],
            orphans: [poolRow(400, 4000, 'Atlantinė lašiša VICI', { categoryId: 688, categoryName: 'Nepriskirta' })],
            // targeted search returns a token-adjacent but unrelated product — below the name floor.
            targeted: [poolRow(101, 1001, 'Bananai prinokę', { categoryId: 16, categoryName: 'Vaisiai' })],
        });
        expect(await buildSlot2cBackfill('u1', 237, 2)).toEqual([]);
    });
});
