import { jest } from '@jest/globals';
import { buildReceiptResolveCards } from '../src/services/receiptResolveQueueService.js';

/**
 * PROPOSED Card-B (receipt-237 salmon dead end): an UNLINKED S2/S3 line whose
 * altMatches hold candidates must produce a card proposing the best one —
 * previously `SKIP no-match` fired before anything else and the "needs human"
 * line could never reach a human (no link → no card → no vocabulary learning).
 * Ranking: confidence + fishPriceBonus for price-anchored (viaPrice) entries.
 * Cross-chain candidates never propose (the chain-price invariant).
 */
function makeConn(parsedData: any, spRows: Record<number, { name: string; imageUrl: string | null; chainId: number }> = {}, resolvedRows: any[] = []) {
    const db: any = {
        query: jest.fn(async (sql: string, params?: any[]) => {
            if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsedData) }]];
            if (/storeProductName, imageUrl, chainId FROM StoreProduct/.test(sql)) {
                const row = spRows[Number(params?.[0])];
                return [row ? [{ storeProductName: row.name, imageUrl: row.imageUrl, chainId: row.chainId }] : []];
            }
            if (/FROM ReceiptItem/.test(sql)) return [[]]; // fall back to blob products
            if (/SELECT receiptLineIdx/.test(sql)) return [resolvedRows];
            return [{ affectedRows: 1 }];
        }),
    };
    return db;
}

const unlinked = (o: Record<string, any> = {}) => ({
    name: 'ATLATINES LAŠISOSs BE GAL',
    storeProductId: null,
    matchedName: null,
    price: 16.99,
    promoPrice: 9.99,
    quantity: 1.068,
    itemConfidence: { band: 'S2' },
    needsHuman: 0.7,
    ...o,
});

describe('buildReceiptResolveCards — proposed cards for unlinked lines', () => {
    it('cards an unlinked S2 line with its best altMatch as a proposal', async () => {
        const parsed = { header: { chainId: 3 }, products: [unlinked({
            altMatches: [
                { storeProductId: 58876, confidence: 0.69, name: 'Atšaldytos skrostos atlantinės lašišos 4/6' },
                { storeProductId: 58972, confidence: 0.69, name: 'Skrostos atvėsintos atlantinės lašišos su galva' },
            ],
        })] };
        const { cards } = await buildReceiptResolveCards(237, makeConn(parsed, {
            58876: { name: 'Atšaldytos skrostos atlantinės lašišos 4/6', imageUrl: 'salmon.jpg', chainId: 3 },
        }));
        expect(cards).toHaveLength(1);
        expect(cards[0].proposed).toBe(true);
        expect(cards[0].matched.spId).toBe(58876);
        expect(cards[0].matched.name).toBe('Atšaldytos skrostos atlantinės lašišos 4/6');
        expect(cards[0].matched.imageUrl).toBe('salmon.jpg');
    });

    it('price-anchored (viaPrice) candidates outrank name-only ties via the fishing bonus', async () => {
        const parsed = { header: { chainId: 3 }, products: [unlinked({
            altMatches: [
                { storeProductId: 58876, confidence: 0.69, name: 'name-only' },
                { storeProductId: 97839, confidence: 0.58, name: 'fished', viaPrice: true },
            ],
        })] };
        // 0.58 + 0.2 = 0.78 > 0.69 → the fished candidate proposes.
        const { cards } = await buildReceiptResolveCards(237, makeConn(parsed, {
            58876: { name: 'name-only', imageUrl: null, chainId: 3 },
            97839: { name: 'fished', imageUrl: null, chainId: 3 },
        }));
        expect(cards[0].proposed).toBe(true);
        expect(cards[0].matched.spId).toBe(97839);
    });

    it('cross-chain candidates never propose; falls through to the next same-chain one', async () => {
        const parsed = { header: { chainId: 3 }, products: [unlinked({
            altMatches: [
                { storeProductId: 900, confidence: 0.8, name: 'maxima product' },
                { storeProductId: 901, confidence: 0.6, name: 'iki product' },
            ],
        })] };
        const { cards } = await buildReceiptResolveCards(237, makeConn(parsed, {
            900: { name: 'maxima product', imageUrl: null, chainId: 1 },
            901: { name: 'iki product', imageUrl: null, chainId: 3 },
        }));
        expect(cards[0].matched.spId).toBe(901);
    });

    it('unlinked line with NO candidates still produces no card (the honest dead end)', async () => {
        const parsed = { header: { chainId: 3 }, products: [unlinked({ altMatches: [] })] };
        const { cards } = await buildReceiptResolveCards(237, makeConn(parsed));
        expect(cards).toEqual([]);
    });

    it('linked lines keep the original (non-proposed) card shape', async () => {
        const parsed = { header: { chainId: 3 }, products: [unlinked({
            storeProductId: 61591, matchedName: 'Colgate', storeProductImageUrl: 'c.jpg',
        })] };
        const { cards } = await buildReceiptResolveCards(237, makeConn(parsed));
        expect(cards).toHaveLength(1);
        expect(cards[0].proposed).toBeUndefined();
        expect(cards[0].matched.spId).toBe(61591);
    });

    it('proposed lines respect the resolution ledger (ask once)', async () => {
        const parsed = { header: { chainId: 3 }, products: [unlinked({
            altMatches: [{ storeProductId: 58876, confidence: 0.69, name: 'x' }],
        })] };
        const { cards } = await buildReceiptResolveCards(237, makeConn(parsed, {
            58876: { name: 'x', imageUrl: null, chainId: 3 },
        }, [{ receiptLineIdx: 0 }]));
        expect(cards).toEqual([]);
    });
});
