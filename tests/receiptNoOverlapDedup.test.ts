import pool from '../src/config/db.js';
import { getReceiptByAnyReceiptNoAndUser, isDistinctiveReceiptNo } from '../src/models/receiptModel.js';

/**
 * Overlap-based duplicate detection: a re-scan of the same physical receipt must be
 * caught when ANY distinctive identifier matches — not only the canonical. The IKI
 * paper prints "Kvito Nr. 168/645/104148" AND the VMI "Kvito numeris 104148"; if the
 * canonical garbles differently across two scans, the clean secondary id is the witness.
 * Short low-entropy ids ("Kvitas 3157" — a per-register counter that recurs across days)
 * must NEVER witness a duplicate on their own.
 */

const USER = 'dedup-test-user-000000000000000000';
const OTHER = 'dedup-test-user-bbbbbbbbbbbbbbbbbb';
let receiptId: number;

beforeAll(async () => {
    for (const u of [USER, OTHER]) {
        await pool.query('INSERT INTO User (id, isAdmin, points) VALUES (?, 0, 0) ON DUPLICATE KEY UPDATE points = 0', [u]);
    }
    const [r]: any = await pool.query(
        `INSERT INTO Receipt (userId, storeId, filePath, fileType, processingStatus, receiptNos)
         VALUES (?, NULL, '', 'image/jpeg', 'completed', ?)`,
        [USER, JSON.stringify(['168/645/104148', '104148', '3157'])],
    );
    receiptId = r.insertId;
});

afterAll(async () => {
    await pool.query('DELETE FROM Receipt WHERE userId IN (?, ?)', [USER, OTHER]);
    await pool.query('DELETE FROM User WHERE id IN (?, ?)', [USER, OTHER]);
    await (pool as any).end();
});

describe('isDistinctiveReceiptNo', () => {
    it('accepts slashed ids and ≥6-digit ids; rejects short bare ids', () => {
        expect(isDistinctiveReceiptNo('168/645/104148')).toBe(true);
        expect(isDistinctiveReceiptNo('104148')).toBe(true);
        expect(isDistinctiveReceiptNo('20260629-1040-235-iki-receipt')).toBe(true);
        expect(isDistinctiveReceiptNo('3157')).toBe(false);
        expect(isDistinctiveReceiptNo('')).toBe(false);
    });
});

describe('getReceiptByAnyReceiptNoAndUser', () => {
    it('matches on the canonical id (baseline)', async () => {
        const hit = await getReceiptByAnyReceiptNoAndUser(['168/645/104148'], USER);
        expect(hit?.id).toBe(receiptId);
    });

    it('catches a duplicate whose canonical got garbled, via a clean secondary id', async () => {
        // Re-scan read "Kvito Nr." as 168/645/704148 (1→7 garble) but the VMI copy clean.
        const hit = await getReceiptByAnyReceiptNoAndUser(['168/645/704148', '704148', '104148'], USER);
        expect(hit?.id).toBe(receiptId);
    });

    it('a short low-entropy id alone can never witness a duplicate', async () => {
        expect(await getReceiptByAnyReceiptNoAndUser(['3157'], USER)).toBeNull();
    });

    it('scoped to the user', async () => {
        expect(await getReceiptByAnyReceiptNoAndUser(['168/645/104148'], OTHER)).toBeNull();
    });

    it('excludeReceiptId skips the receipt itself (autosave self-check)', async () => {
        expect(await getReceiptByAnyReceiptNoAndUser(['104148'], USER, receiptId)).toBeNull();
    });
});
