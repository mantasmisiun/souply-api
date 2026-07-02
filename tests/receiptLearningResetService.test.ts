import { jest } from '@jest/globals';
import { resetReceiptLearning } from '../src/services/receiptLearningResetService.js';

// Scriptable mock connection: each test supplies handlers keyed by a SQL matcher (first
// match wins). resetReceiptLearning is pure SQL orchestration, so we assert on the exact
// queries it fires (delete scope, alias GC, aggregate recompute, equivalence clear).
function makeConn(handlers: Array<{ match: RegExp; resp: (params: any[]) => any }>) {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const conn: any = {
        _calls: calls,
        query: jest.fn(async (sql: string, params: any[] = []) => {
            calls.push({ sql, params });
            for (const h of handlers) if (h.match.test(sql)) return h.resp(params);
            return [{ affectedRows: 0 }];
        }),
    };
    return conn;
}
const calls = (conn: any, re: RegExp) => conn._calls.filter((c: any) => re.test(c.sql));

describe('resetReceiptLearning', () => {
    it('deletes the receipt vocab votes, GCs a now-vote-less alias, recomputes the match aggregate to zero, clears equivalences', async () => {
        const conn = makeConn([
            { match: /SELECT DISTINCT aliasId FROM StoreProductReceiptAliasVote/, resp: () => [[{ aliasId: 7 }]] },
            { match: /DELETE FROM StoreProductReceiptAliasVote/, resp: () => [{ affectedRows: 2 }] },
            // recompute alias 7 → no votes remain
            { match: /SELECT vote, COUNT\(DISTINCT userId\)/, resp: () => [[]] },
            { match: /SELECT adminVerdict FROM StoreProductReceiptAlias/, resp: () => [[{ adminVerdict: null }]] },
            { match: /DELETE FROM StoreProductReceiptAlias WHERE id/, resp: () => [{ affectedRows: 1 }] },
            { match: /UPDATE StoreProductReceiptAlias SET sampleReceiptId/, resp: () => [{ affectedRows: 1 }] },
            // match votes for one pair (10,11)
            { match: /SELECT userId, spIdA, spIdB FROM StoreProductMatchVote/, resp: () => [[{ userId: 'u1', spIdA: 10, spIdB: 11 }]] },
            { match: /DELETE FROM StoreProductMatchVote/, resp: () => [{ affectedRows: 1 }] },
            { match: /SELECT vote, COUNT\(\*\)/, resp: () => [[]] }, // no remaining votes for the pair
            { match: /UPDATE StoreProductMatch SET/, resp: () => [{ affectedRows: 1 }] },
            { match: /DELETE FROM UserStoreProductEquivalence/, resp: () => [{ affectedRows: 1 }] },
        ]);

        const res = await resetReceiptLearning(206, conn);
        expect(res).toEqual({ aliasVotesDeleted: 2, aliasesDeleted: 1, matchVotesDeleted: 1, equivalencesDeleted: 1 });

        // The alias-vote delete + match-vote delete are scoped by receiptId=206.
        expect(calls(conn, /DELETE FROM StoreProductReceiptAliasVote WHERE receiptId/)[0].params).toEqual([206]);
        expect(calls(conn, /DELETE FROM StoreProductMatchVote WHERE receiptId/)[0].params).toEqual([206]);
        // The vote-less alias was garbage-collected, not left dangling.
        expect(calls(conn, /DELETE FROM StoreProductReceiptAlias WHERE id/).length).toBe(1);
        // The aggregate was recomputed to zero (no votes left back it).
        expect(calls(conn, /UPDATE StoreProductMatch SET/)[0].params.slice(0, 3)).toEqual([0, 0, 0]);
        // The pair's personal equivalence was cleared (ordered pair, from the vote row).
        expect(calls(conn, /DELETE FROM UserStoreProductEquivalence/)[0].params).toEqual(['u1', 10, 11]);
    });

    it('keeps an alias that still has votes and recomputes the aggregate from remaining NON-burst votes only', async () => {
        const conn = makeConn([
            { match: /SELECT DISTINCT aliasId FROM StoreProductReceiptAliasVote/, resp: () => [[{ aliasId: 9 }]] },
            { match: /DELETE FROM StoreProductReceiptAliasVote/, resp: () => [{ affectedRows: 1 }] },
            // recompute alias 9 → another user's 'identical' vote survives
            { match: /SELECT vote, COUNT\(DISTINCT userId\)/, resp: () => [[{ vote: 'identical', n: 1 }]] },
            { match: /SELECT adminVerdict FROM StoreProductReceiptAlias/, resp: () => [[{ adminVerdict: null }]] },
            { match: /UPDATE StoreProductReceiptAlias SET identicalUsers/, resp: () => [{ affectedRows: 1 }] },
            { match: /UPDATE StoreProductReceiptAlias SET sampleReceiptId/, resp: () => [{ affectedRows: 0 }] },
            { match: /SELECT userId, spIdA, spIdB FROM StoreProductMatchVote/, resp: () => [[{ userId: 'u2', spIdA: 20, spIdB: 21 }]] },
            { match: /DELETE FROM StoreProductMatchVote/, resp: () => [{ affectedRows: 1 }] },
            // one non-burst 'different' vote remains for the pair
            { match: /SELECT vote, COUNT\(\*\)/, resp: () => [[{ vote: 'different', n: 1 }]] },
            { match: /UPDATE StoreProductMatch SET/, resp: () => [{ affectedRows: 1 }] },
            { match: /DELETE FROM UserStoreProductEquivalence/, resp: () => [{ affectedRows: 0 }] },
        ]);

        const res = await resetReceiptLearning(206, conn);
        expect(res.aliasesDeleted).toBe(0); // alias survived (still has a vote)
        expect(calls(conn, /DELETE FROM StoreProductReceiptAlias WHERE id/).length).toBe(0);
        // Aggregate recompute counted the surviving different vote (identical=0, similar=0, different=1).
        expect(calls(conn, /UPDATE StoreProductMatch SET/)[0].params.slice(0, 3)).toEqual([0, 0, 1]);
        // The recompute keys on the row's aggregation provenance, not a dwell heuristic.
        const recompute = calls(conn, /SELECT vote, COUNT\(\*\)/)[0];
        expect(recompute.sql).toContain('aggregated = 1');
    });

    it('is a no-op (all zero) for a receipt with no learning rows', async () => {
        const conn = makeConn([
            { match: /SELECT DISTINCT aliasId/, resp: () => [[]] },
            { match: /SELECT userId, spIdA, spIdB/, resp: () => [[]] },
        ]);
        const res = await resetReceiptLearning(999, conn);
        expect(res).toEqual({ aliasVotesDeleted: 0, aliasesDeleted: 0, matchVotesDeleted: 0, equivalencesDeleted: 0 });
    });
});
