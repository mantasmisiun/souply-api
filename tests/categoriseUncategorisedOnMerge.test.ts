import { jest } from '@jest/globals';
import { categoriseUncategorisedOnMerge, type MergeDecision } from '../src/services/storeProductMergeService.js';

// A confirmed "same" vote on a [688-with-photo, categorised] slot3 pair must categorise the
// 688 item by adopting the categorised side's category onto its OWN row — regardless of which
// product won the (name-length) merge, so a categorised product is NEVER de-categorised.
const NEPRISKIRTA = 688;

function makeConn(cats: Record<number, number>) {
    const updates: { newCat: number; id: number; guard: number }[] = [];
    const conn: any = {
        updates,
        query: jest.fn(async (sql: string, params: any[]) => {
            if (/SELECT id, categoryId FROM Product/.test(sql)) {
                const [a, b] = params;
                return [[{ id: a, categoryId: cats[a] }, { id: b, categoryId: cats[b] }]];
            }
            if (/UPDATE Product SET categoryId/.test(sql)) {
                updates.push({ newCat: params[0], id: params[1], guard: params[2] });
                return [{ affectedRows: 1 }];
            }
            return [{}];
        }),
    };
    return conn;
}
const promoted = (winner: number, loser: number): MergeDecision => ({ action: 'promoted', winnerProductId: winner, loserProductId: loser });

describe('categoriseUncategorisedOnMerge', () => {
    it('688 LOSER → rescued to the categorised WINNER category', async () => {
        const conn = makeConn({ 10: 5 /* winner categorised */, 20: NEPRISKIRTA /* loser 688 */ });
        await categoriseUncategorisedOnMerge(promoted(10, 20), conn);
        expect(conn.updates).toEqual([{ newCat: 5, id: 20, guard: NEPRISKIRTA }]);
    });

    it('688 WINNER → its OWN row is rescued (no de-categorisation when 688 wins the merge)', async () => {
        const conn = makeConn({ 10: NEPRISKIRTA /* winner 688 */, 20: 7 /* loser categorised */ });
        await categoriseUncategorisedOnMerge(promoted(10, 20), conn);
        expect(conn.updates).toEqual([{ newCat: 7, id: 10, guard: NEPRISKIRTA }]);
    });

    it('neither side 688 → no write (a normal categorised merge is untouched)', async () => {
        const conn = makeConn({ 10: 5, 20: 7 });
        await categoriseUncategorisedOnMerge(promoted(10, 20), conn);
        expect(conn.updates).toEqual([]);
    });

    it('BOTH sides 688 → no write (nothing to adopt)', async () => {
        const conn = makeConn({ 10: NEPRISKIRTA, 20: NEPRISKIRTA });
        await categoriseUncategorisedOnMerge(promoted(10, 20), conn);
        expect(conn.updates).toEqual([]);
    });

    it('non-promoted decision (noop / demoted) → no query at all', async () => {
        const conn = makeConn({});
        await categoriseUncategorisedOnMerge({ action: 'noop' }, conn);
        await categoriseUncategorisedOnMerge({ action: 'demoted', winnerProductId: 1, loserProductId: 2 }, conn);
        expect(conn.query).not.toHaveBeenCalled();
    });

    it('the UPDATE carries a WHERE categoryId=688 guard → idempotent / never overwrites a real category', async () => {
        const conn = makeConn({ 10: 5, 20: NEPRISKIRTA });
        await categoriseUncategorisedOnMerge(promoted(10, 20), conn);
        expect(conn.updates[0].guard).toBe(NEPRISKIRTA);
    });
});
