import pool from '../src/config/db.js';
import { createTrip, isTripMember } from '../src/models/tripModel.js';
import { getReceiptByAnyReceiptNoStoreDate } from '../src/models/receiptModel.js';

/**
 * Souply 2.0 same-trip duplicate exemption (shared trips: "either can upload").
 * The witness lookup must surface the OTHER member's receipt WITH its tripId,
 * and membership decides exemption vs crossAccount — the controller branch is
 * exactly `other.tripId != null && isTripMember(other.tripId, uploader)`.
 */

const OWNER = 'stdup-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER = 'stdup-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STRANGER = 'stdup-cccc-cccc-cccc-cccccccccccc';
const CHAIN_ID = 9966;
const STORE_ID = 99661;
const RECEIPT_NO = '123456/9966';
const DATE = '2026-07-16';

let tripId: number;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    for (const u of [OWNER, MEMBER, STRANGER]) {
        await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    }
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'StDup Chain']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_ID, CHAIN_ID, 'StDup Store', 'Test St. 5']);

    tripId = await createTrip(OWNER);
    await q('INSERT INTO TripMember (tripId, userId, role) VALUES (?,?,"member")', [tripId, MEMBER]);

    await q(
        `INSERT INTO Receipt (userId, storeId, filePath, receiptDate, receiptNos, processingStatus, tripId, uploaderUserId)
         VALUES (?,?,?,?,JSON_ARRAY(?),"completed",?,?)`,
        [OWNER, STORE_ID, 'test/stdup.jpg', `${DATE} 12:00:00`, RECEIPT_NO, tripId, OWNER],
    );
});

afterAll(async () => {
    await q('DELETE FROM Receipt WHERE userId = ?', [OWNER]);
    await q('DELETE FROM TripMember WHERE tripId = ?', [tripId]);
    await q('DELETE FROM Trip WHERE id = ?', [tripId]);
    await (pool as any).end();
});

describe('same-trip duplicate exemption', () => {
    it('the witness lookup surfaces the other receipt with its tripId', async () => {
        const other = await getReceiptByAnyReceiptNoStoreDate([RECEIPT_NO], STORE_ID, DATE, MEMBER);
        expect(other).not.toBeNull();
        expect(Number(other.tripId)).toBe(tripId);
    });

    it('a fellow member is exempt; a stranger stays crossAccount', async () => {
        const other = await getReceiptByAnyReceiptNoStoreDate([RECEIPT_NO], STORE_ID, DATE, MEMBER);
        expect(await isTripMember(Number(other.tripId), MEMBER)).toBe(true);     // → sameTrip response
        expect(await isTripMember(Number(other.tripId), STRANGER)).toBe(false);  // → crossAccount 409
    });

    it('trips without membership rows behave like today (tripId null path)', async () => {
        // A legacy receipt with no trip: exemption cannot apply.
        await q('UPDATE Receipt SET tripId = NULL WHERE userId = ?', [OWNER]);
        const other = await getReceiptByAnyReceiptNoStoreDate([RECEIPT_NO], STORE_ID, DATE, MEMBER);
        expect(other.tripId).toBeNull();
        await q('UPDATE Receipt SET tripId = ? WHERE userId = ?', [tripId, OWNER]);
    });
});
