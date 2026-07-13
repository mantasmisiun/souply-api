import { jest } from '@jest/globals';
import {
    markLineAsked,
    markLineResolved,
    getResolvedLineIdxSet,
} from '../src/models/receiptLineResolutionModel.js';

function makeDb(selectRows: any[] = []) {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const db: any = {
        _calls: calls,
        query: jest.fn(async (sql: string, params: any[]) => {
            calls.push({ sql, params });
            if (/SELECT receiptLineIdx/.test(sql)) return [selectRows];
            return [{ affectedRows: 1 }];
        }),
    };
    return db;
}

describe('receiptLineResolutionModel', () => {
    it('markLineAsked uses INSERT IGNORE with status=asked (never downgrades a resolved row)', async () => {
        const db = makeDb();
        await markLineAsked(108, 3, db);
        const c = db._calls[0];
        expect(c.sql).toMatch(/INSERT IGNORE INTO ReceiptLineResolution/);
        expect(c.params).toEqual([108, 3, 'asked']);
    });

    it('markLineResolved (user) upserts status=resolved_user with the reason', async () => {
        const db = makeDb();
        await markLineResolved(108, 3, 'user', 'reject_orphan', db);
        const c = db._calls[0];
        expect(c.sql).toMatch(/ON DUPLICATE KEY UPDATE/);
        expect(c.params).toEqual([108, 3, 'resolved_user', 'reject_orphan']);
    });

    it('markLineResolved (system) records resolved_system', async () => {
        const db = makeDb();
        await markLineResolved(108, 7, 'system', 'auto_repick', db);
        expect(db._calls[0].params).toEqual([108, 7, 'resolved_system', 'auto_repick']);
    });

    it('getResolvedLineIdxSet returns the set of already-handled line indices', async () => {
        const db = makeDb([{ receiptLineIdx: 2 }, { receiptLineIdx: 5 }, { receiptLineIdx: 2 }]);
        const set = await getResolvedLineIdxSet(108, db);
        expect(set.has(2)).toBe(true);
        expect(set.has(5)).toBe(true);
        expect(set.has(9)).toBe(false);
        expect(set.size).toBe(2);
    });

    it('getResolvedLineIdxSet is empty for a receipt with no ledger rows', async () => {
        const set = await getResolvedLineIdxSet(999, makeDb([]));
        expect(set.size).toBe(0);
    });
});
