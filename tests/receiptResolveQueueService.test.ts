import { jest } from '@jest/globals';
import { buildReceiptResolveCards, markServedResolveLinesAsked } from '../src/services/receiptResolveQueueService.js';

// Mock conn: SELECT parsedData returns the blob; SELECT receiptLineIdx returns the
// ledger (already-asked lines); any other query is a no-op.
function makeConn(parsedData: any, resolvedRows: any[] = []) {
    const db: any = {
        query: jest.fn(async (sql: string) => {
            if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsedData) }]];
            if (/FROM ReceiptItem/.test(sql)) return [[]]; // no rows → fall back to blob products
            if (/SELECT receiptLineIdx/.test(sql)) return [resolvedRows];
            return [{ affectedRows: 1 }];
        }),
    };
    return db;
}

const line = (o: Record<string, any>) => ({
    name: 'OCR NAME',
    storeProductId: 100,
    matchedName: 'Matched Product',
    storeProductImageUrl: 'img.jpg',
    price: 2,
    quantity: 1,
    promoPrice: null,
    itemConfidence: { band: 'S3' },
    needsHuman: 0.5,
    ...o,
});

describe('buildReceiptResolveCards', () => {
    it('cards the top-2 uncertain matched lines as Card-B, highest needs-human first', async () => {
        const parsed = { header: { chainId: 3 }, products: [
            line({ storeProductId: 10, needsHuman: 0.9, band: undefined, itemConfidence: { band: 'S3' } }),
            line({ storeProductId: 11, needsHuman: 0.3, itemConfidence: { band: 'S2' } }),
            line({ storeProductId: 12, needsHuman: 0.7, itemConfidence: { band: 'S3' } }),
        ]};
        const { cards } = await buildReceiptResolveCards(108, makeConn(parsed));
        expect(cards.map((c) => c.receiptLineIdx)).toEqual([0, 2]); // 0.9 then 0.7; the 0.3 drops at the 2-card cap
        expect(cards[0].cardKind).toBe('receipt');
        expect(cards[0].cardId).toBe('rcpt:108:0');
        expect(cards[0].ocr.cropUrl).toBe('/api/receipts/108/lines/0/crop');
        expect(cards[0].matched.spId).toBe(10);
    });

    it('exposes the per-line band region + parsed.image dims for the client crop', async () => {
        const region = { xLeft: 50, xRight: 900, yTop: 100, yBottom: 160, yLeftTop: 100, yRightTop: 110, yLeftBottom: 160, yRightBottom: 170 };
        const parsed = {
            image: { width: 953, height: 3223 },
            products: [line({ storeProductId: 10, needsHuman: 0.9, itemConfidence: { band: 'S3' }, region })],
        };
        const { cards, image } = await buildReceiptResolveCards(108, makeConn(parsed));
        expect(image).toEqual({ width: 953, height: 3223 });
        expect(cards[0].region).toEqual(region);
    });

    it('region is null when the line has no usable geometry; image null when dims absent', async () => {
        const parsed = { products: [line({ storeProductId: 10, needsHuman: 0.9, itemConfidence: { band: 'S3' }, region: undefined })] };
        const { cards, image } = await buildReceiptResolveCards(108, makeConn(parsed));
        expect(cards[0].region).toBeNull();
        expect(image).toBeNull();
    });

    it('skips confident (S1) lines and unmatched (no SP) lines', async () => {
        const parsed = { products: [
            line({ storeProductId: 10, itemConfidence: { band: 'S1' }, needsHuman: 0 }),
            line({ storeProductId: null, itemConfidence: { band: 'S3' }, needsHuman: 0.9 }),
        ]};
        const { cards } = await buildReceiptResolveCards(108, makeConn(parsed));
        expect(cards).toEqual([]);
    });

    it('suppresses lines already in the ledger (one shot)', async () => {
        const parsed = { products: [
            line({ storeProductId: 10, needsHuman: 0.9, itemConfidence: { band: 'S3' } }),
            line({ storeProductId: 11, needsHuman: 0.8, itemConfidence: { band: 'S3' } }),
        ]};
        const { cards } = await buildReceiptResolveCards(108, makeConn(parsed, [{ receiptLineIdx: 0 }]));
        expect(cards.map((c) => c.receiptLineIdx)).toEqual([1]);
    });

    it('older receipts with no needsHuman produce no cards (graceful absence)', async () => {
        const parsed = { products: [line({ needsHuman: undefined, itemConfidence: { band: 'S3' } })] };
        const { cards } = await buildReceiptResolveCards(108, makeConn(parsed));
        expect(cards).toEqual([]);
    });

    it('no parsedData → no cards', async () => {
        const db: any = { query: jest.fn(async () => [[{ parsedData: null }]]) };
        expect(await buildReceiptResolveCards(108, db)).toEqual({ cards: [], image: null });
    });

    // ── Idempotent serve (the "cards not showing up" instability fix) ──
    // Serving the resolve queue must NOT mutate the ledger. The client's loadQueue
    // re-fetches on [sessionNum, receiptIdx], on remount, and twice under StrictMode;
    // if serving marked lines 'asked', the SECOND fetch would return an empty queue and
    // the user's own cards would vanish mid-session. The terminal 'asked' write now lives
    // in markServedResolveLinesAsked (called from POST /complete-swipes) only.
    it('serving is a PURE READ — buildReceiptResolveCards never writes the ledger', async () => {
        const parsed = { products: [line({ storeProductId: 10, needsHuman: 0.9, itemConfidence: { band: 'S3' } })] };
        const conn = makeConn(parsed);
        const first = await buildReceiptResolveCards(108, conn);
        const second = await buildReceiptResolveCards(108, conn);
        expect(second.cards.map((c) => c.receiptLineIdx)).toEqual(first.cards.map((c) => c.receiptLineIdx));
        const wrote = (conn.query as any).mock.calls.some(
            ([sql]: any[]) => /INSERT|UPDATE|DELETE/i.test(sql) && /ReceiptLineResolution/i.test(sql),
        );
        expect(wrote).toBe(false);
    });

    it('markServedResolveLinesAsked marks EXACTLY the served indices asked (never a recompute)', async () => {
        const conn = makeConn({ products: [] }); // no recompute → parsedData is irrelevant
        const n = await markServedResolveLinesAsked(108, conn, [0, 2, 2]); // dedups the repeat
        expect(n).toBe(2);
        const asked = (conn.query as any).mock.calls
            .filter(([sql]: any[]) => /INSERT IGNORE INTO ReceiptLineResolution/.test(sql))
            .map(([, params]: any[]) => params[1])
            .sort();
        expect(asked).toEqual([0, 2]);
    });

    it('markServedResolveLinesAsked ignores invalid indices and an empty set', async () => {
        const conn = makeConn({ products: [] });
        expect(await markServedResolveLinesAsked(108, conn, [])).toBe(0);
        expect(await markServedResolveLinesAsked(108, conn, [-1, NaN, 1.5] as any)).toBe(0);
        const wrote = (conn.query as any).mock.calls.some(([sql]: any[]) => /INSERT IGNORE/.test(sql));
        expect(wrote).toBe(false);
    });

    // GAP 2 REGRESSION: completion must mark ONLY the served lines, never a fresh
    // recompute. Repro: 3 uncertain lines; the mandatory session served the top-2
    // (idx 0,1) and the user resolved them. The OLD body recomputed at completion,
    // which — with 0,1 now resolved+excluded — picked the NEXT line (idx 2, NEVER
    // shown) and marked it asked, hiding it forever. The fix marks only [0,1], so the
    // unseen line 2 stays cardable in a later (voluntary) session.
    it('completion marks only the SERVED set; an unseen unresolved line stays cardable', async () => {
        const ledger = new Set<number>([0, 1]); // 0,1 resolved by votes during the session
        const parsed = { products: [
            line({ storeProductId: 10, needsHuman: 0.9, itemConfidence: { band: 'S3' } }),
            line({ storeProductId: 11, needsHuman: 0.7, itemConfidence: { band: 'S3' } }),
            line({ storeProductId: 12, needsHuman: 0.5, itemConfidence: { band: 'S3' } }),
        ]};
        const conn: any = {
            query: jest.fn(async (sql: string, params: any[]) => {
                if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsed) }]];
                if (/FROM ReceiptItem/.test(sql)) return [[]];
                if (/SELECT receiptLineIdx/.test(sql)) return [[...ledger].map((i) => ({ receiptLineIdx: i }))];
                if (/INSERT IGNORE INTO ReceiptLineResolution/.test(sql)) { ledger.add(Number(params[1])); return [{ affectedRows: 1 }]; }
                return [{ affectedRows: 1 }];
            }),
        };
        // Complete-swipes marks ONLY the served indices [0,1] (already resolved → no-ops).
        const n = await markServedResolveLinesAsked(108, conn, [0, 1]);
        expect(n).toBe(2);
        // The never-served line 2 is NOT in the ledger and is still cardable.
        expect(ledger.has(2)).toBe(false);
        const later = await buildReceiptResolveCards(108, conn, 5);
        expect(later.cards.map((c) => c.receiptLineIdx)).toEqual([2]);
    });

    it('full flow: serve is stable across re-fetches, then complete-swipes marks the served line so a LATER serve is empty', async () => {
        const ledger = new Set<number>();
        const parsed = { products: [line({ storeProductId: 10, needsHuman: 0.9, itemConfidence: { band: 'S3' } })] };
        const conn: any = {
            query: jest.fn(async (sql: string, params: any[]) => {
                if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsed) }]];
                if (/FROM ReceiptItem/.test(sql)) return [[]]; // no rows → fall back to blob products
                if (/SELECT receiptLineIdx/.test(sql)) return [[...ledger].map((i) => ({ receiptLineIdx: i }))];
                if (/INSERT IGNORE INTO ReceiptLineResolution/.test(sql)) { ledger.add(Number(params[1])); return [{ affectedRows: 1 }]; }
                return [{ affectedRows: 1 }];
            }),
        };
        // Serve twice within a session — the second fetch is NOT emptied by the first.
        expect((await buildReceiptResolveCards(108, conn)).cards.length).toBe(1);
        expect((await buildReceiptResolveCards(108, conn)).cards.length).toBe(1);
        // Session completes → terminal ask-once marking of the served line (idx 0).
        await markServedResolveLinesAsked(108, conn, [0]);
        // A later session no longer re-nags the (unresolved-but-asked) line.
        expect((await buildReceiptResolveCards(108, conn)).cards.length).toBe(0);
    });
});
