import { jest } from '@jest/globals';

// The model imports the db pool as default; mock it so no real pool opens. We only test
// the pure mapping functions here (no queries).
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: jest.fn() },
}));

let lineToItem: any;
let itemToLine: any;

beforeAll(async () => {
    const mod = await import('../src/models/receiptItemModel.js');
    lineToItem = mod.lineToItem;
    itemToLine = mod.itemToLine;
});

// JSON-normalise (drops undefined, the same transform res.json applies on the wire).
const norm = (x: any) => JSON.parse(JSON.stringify(x));
// Assert reconstruction lost NO data: every key present on the original line round-trips.
function assertNoDataLoss(original: any, reconstructed: any) {
    for (const k of Object.keys(original)) {
        if (original[k] === undefined) continue;
        expect(norm(reconstructed[k])).toEqual(norm(original[k]));
    }
}
const roundTrip = (line: any) => itemToLine(lineToItem(1, 0, line));

describe('ReceiptItem mapping — lineToItem / itemToLine', () => {
    it('round-trips a fully-matched S1 line with no data loss', () => {
        const line = {
            name: 'IKI PIENAS 2.5%',
            price: 1.29, promoPrice: null, quantity: 2, unit: 'vnt',
            amount: 1, sizeUnit: 'l', isWeighable: false, pricePerUnit: null, brandName: 'IKI',
            storeProductId: 60946, matchedName: 'Pienas 2,5% IKI', storeProductImageUrl: 'https://x/y.jpg',
            matchConfidence: 0.97, matchConfirmed: true, priceVerified: true, variantUncertain: false,
            categoryId: 45, categoryName: 'Pienas', categoryL2Name: 'Pieno gaminiai',
            needsHuman: 0,
            itemConfidence: { band: 'S1', score: 0.95, vetoes: [] },
            altMatches: [{ storeProductId: 60946, productId: 5, storeProductName: 'Pienas', confidence: 0.97 }],
            region: { yTop: 100, yBottom: 140, xLeft: 0, xRight: 500 },
            rawLines: ['IKI PIENAS 2.5%', '1,29'],
        };
        assertNoDataLoss(line, roundTrip(line));
    });

    it('renames storeProductId <-> matchedSpId and derives band from itemConfidence', () => {
        const line = { name: 'X', price: 1, storeProductId: 777, itemConfidence: { band: 'S2', score: 0.7 } };
        const row = lineToItem(1, 3, line);
        expect(row.matchedSpId).toBe(777);
        expect(row.band).toBe('S2');
        expect(row.lineIdx).toBe(3);
        expect(itemToLine(row).storeProductId).toBe(777);
    });

    it('round-trips an UNMATCHED line (no SP) — matchedSpId NULL', () => {
        const line = {
            name: 'KAŽKOKS NEATPAŽINTAS', price: 3.49, promoPrice: null, quantity: 1, unit: 'vnt',
            storeProductId: null, matchedName: null, storeProductImageUrl: null,
            matchConfidence: null, matchConfirmed: false, priceVerified: false,
            itemConfidence: { band: 'S3', score: 0.1 }, altMatches: [],
        };
        const row = lineToItem(1, 0, line);
        expect(row.matchedSpId).toBeNull();
        assertNoDataLoss(line, roundTrip(line));
    });

    it('round-trips a promo + weighable line', () => {
        const line = {
            name: 'BANANAI', price: 1.79, promoPrice: 1.29, quantity: 0.236, unit: 'kg',
            amount: null, sizeUnit: null, isWeighable: true, pricePerUnit: 5.47,
            storeProductId: 123, matchConfirmed: true, priceVerified: false,
            itemConfidence: { band: 'S1', score: 0.9 },
        };
        assertNoDataLoss(line, roundTrip(line));
    });

    it('preserves UNKNOWN / future keys via the `extra` catch-all (lossless)', () => {
        const line = {
            name: 'Y', price: 2, storeProductId: 1,
            wordsDump: ['Y', '2,00'], imageUrl: 'crop://line0', priceImplausible: true,
            someFutureFlag: { nested: [1, 2, 3] },
        };
        const row = lineToItem(1, 0, line);
        // priceImplausible is a real column; the rest live in extra.
        expect(row.priceImplausible).toBe(true);
        expect(row.extra).toMatchObject({ wordsDump: ['Y', '2,00'], imageUrl: 'crop://line0', someFutureFlag: { nested: [1, 2, 3] } });
        assertNoDataLoss(line, roundTrip(line));
    });

    it('round-trips a skew region (per-corner Y)', () => {
        const line = {
            name: 'Z', price: 1, storeProductId: 5,
            region: { yTop: 10, yBottom: 40, xLeft: 0, xRight: 600, yLeftTop: 8, yRightTop: 12, yLeftBottom: 38, yRightBottom: 42 },
        };
        assertNoDataLoss(line, roundTrip(line));
    });

    it('coerces DB-style row values (DECIMAL strings, TINYINT 0/1, JSON strings)', () => {
        // Simulate a row as mysql2 returns it.
        const dbRow = {
            receiptId: 1, lineIdx: 0, name: 'DB', price: '1.29', promoPrice: null, quantity: '2.000',
            unit: 'vnt', isWeighable: 1, matchedSpId: 60946, matchConfirmed: 1, priceVerified: 0,
            band: 'S1', itemConfidence: '{"band":"S1","score":0.95}', altMatches: '[]',
            region: null, rawLines: null, extra: '{"imageUrl":"crop://0"}',
        };
        const line = itemToLine(dbRow);
        expect(line.price).toBe(1.29);
        expect(line.quantity).toBe(2);
        expect(line.isWeighable).toBe(true);
        expect(line.matchConfirmed).toBe(true);
        expect(line.priceVerified).toBe(false);
        expect(line.storeProductId).toBe(60946);
        expect(line.itemConfidence).toEqual({ band: 'S1', score: 0.95 });
        expect(line.imageUrl).toBe('crop://0'); // from extra
    });
});
