import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { listTripsForUser, countActiveTripsForUser } from '../src/services/tripListService.js';

/**
 * Perf audit #6 — the tab-badge `trips` number is now a direct SQL COUNT
 * (countActiveTripsForUser) instead of the full listTripsForUser assembly
 * filtered in JS. This suite proves the COUNT reproduces the old filter
 * (`archivedAt == null && stage < 5`) across every stage/visibility rule:
 * each scenario mutates state and re-asserts JS-filter === COUNT, so any
 * future drift between the two implementations fails loudly.
 */

const USER = 'badgeq-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FRIEND = 'badgeq-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHAIN_ID = 9976;
const STORE_ID = 99761;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const cleanup = async () => {
    await q('DELETE FROM Receipt WHERE userId IN (?,?)', [USER, FRIEND]);
    await q('DELETE FROM ShoppingList WHERE userId IN (?,?)', [USER, FRIEND]);
    await q('DELETE FROM TripMember WHERE userId IN (?,?)', [USER, FRIEND]);
    await q('DELETE FROM Trip WHERE createdByUserId IN (?,?)', [USER, FRIEND]);
};

beforeAll(async () => {
    await primeTokens(USER, FRIEND);
    await cleanup();
    for (const u of [USER, FRIEND]) await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'BadgeQ Chain']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_ID, CHAIN_ID, 'BadgeQ Store', 'Test St. 9']);
});

afterAll(async () => {
    await cleanup();
    await q('DELETE FROM Store WHERE id = ?', [STORE_ID]);
    await q('DELETE FROM StoreChain WHERE id = ?', [CHAIN_ID]);
    await (pool as any).end();
});

const mkTrip = async (owner: string, opts: { isAdHoc?: boolean; archived?: boolean } = {}): Promise<number> => {
    const [r]: any = await pool.query(
        'INSERT INTO Trip (createdByUserId, isAdHoc, archivedAt) VALUES (?,?,?)',
        [owner, opts.isAdHoc ? 1 : 0, opts.archived ? '2026-03-01 00:00:00' : null]);
    await q('INSERT INTO TripMember (tripId, userId, role) VALUES (?,?,?)', [r.insertId, owner, 'owner']);
    return r.insertId;
};

const mkList = async (tripId: number, owner: string, status: string, skipped = false): Promise<number> => {
    const [r]: any = await pool.query(
        'INSERT INTO ShoppingList (userId, storeId, tripId, status, receiptSkippedAt) VALUES (?,?,?,?,?)',
        [owner, STORE_ID, tripId, status, skipped ? '2026-03-01 00:00:00' : null]);
    return r.insertId;
};

const mkReceipt = async (tripId: number, listId: number, uploader: string, swipesRequired = 0, swipesDone = 0): Promise<number> => {
    const [r]: any = await pool.query(
        `INSERT INTO Receipt (userId, uploaderUserId, storeId, shoppingListId, tripId, filePath, fileType,
                              processingStatus, mandatorySwipesRequired, mandatorySwipesCompleted)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uploader, uploader, STORE_ID, listId, tripId, 'badgeq.jpg', 'image/jpeg', 'completed', swipesRequired, swipesDone]);
    return r.insertId;
};

/** The OLD implementation, verbatim, vs the new COUNT — must always agree. */
const assertEquivalent = async (userId: string, expected: number) => {
    const trips = await listTripsForUser(userId);
    const oldCount = trips.filter(t => t.archivedAt == null && t.stage < 5).length;
    const newCount = await countActiveTripsForUser(userId);
    expect(newCount).toBe(oldCount);
    expect(newCount).toBe(expected);
};

describe('countActiveTripsForUser ≡ listTripsForUser filter', () => {
    it('empty state → 0/0, endpoint shape unchanged', async () => {
        await assertEquivalent(USER, 0);
        const r = await asUser(app, USER).get(`/api/users/${USER}/tab-badges`);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ trips: 0, pendingSwipes: 0 });
    });

    it('slotless trip (stage 1/2) counts; ad-hoc and archived do not', async () => {
        await mkTrip(USER);                        // stage 1 → active
        await mkTrip(USER, { isAdHoc: true });     // stage 5 by definition
        await mkTrip(USER, { archived: true });    // archived → excluded
        await assertEquivalent(USER, 1);
    });

    it('active list → stage 3 counts', async () => {
        const t = await mkTrip(USER);
        await mkList(t, USER, 'active');
        await assertEquivalent(USER, 2);
    });

    it('all lists completed, slot unclosed → stage 4 counts; skip closes it → stage 5', async () => {
        const t = await mkTrip(USER);
        const l = await mkList(t, USER, 'completed');
        await assertEquivalent(USER, 3);           // stage 4
        await q('UPDATE ShoppingList SET receiptSkippedAt = NOW() WHERE id = ?', [l]);
        await assertEquivalent(USER, 2);           // stage 5 — dropped
    });

    it('own receipt closes the slot regardless of pending mandatory swipes', async () => {
        const t = await mkTrip(USER);
        const l = await mkList(t, USER, 'completed');
        await assertEquivalent(USER, 3);
        await mkReceipt(t, l, USER, 5, 0);         // own → always visible
        await assertEquivalent(USER, 2);
    });

    it("a member's un-swiped receipt does NOT close the slot until its swipes finish", async () => {
        const t = await mkTrip(USER);
        const l = await mkList(t, USER, 'completed');
        await q('INSERT INTO TripMember (tripId, userId, role) VALUES (?,?,?)', [t, FRIEND, 'member']);
        const rid = await mkReceipt(t, l, FRIEND, 3, 0); // foreign + pending → invisible to USER
        await assertEquivalent(USER, 3);           // still stage 4 for USER
        await assertEquivalent(FRIEND, 0);         // own receipt visible → stage 5 for FRIEND
        await q('UPDATE Receipt SET mandatorySwipesCompleted = mandatorySwipesRequired WHERE id = ?', [rid]);
        await assertEquivalent(USER, 2);           // published → stage 5 for USER too
    });

    it('a soft-deleted receipt reopens the slot', async () => {
        const t = await mkTrip(USER);
        const l = await mkList(t, USER, 'completed');
        const rid = await mkReceipt(t, l, USER);
        await assertEquivalent(USER, 2);
        await q('UPDATE Receipt SET userDeletedAt = NOW() WHERE id = ?', [rid]);
        await assertEquivalent(USER, 3);           // back to stage 4
    });

    it('membership scope: the badge counts trips the user is a MEMBER of', async () => {
        const t = await mkTrip(FRIEND);            // FRIEND's slotless trip
        await assertEquivalent(FRIEND, 1);
        await assertEquivalent(USER, 3);           // not a member yet
        await q('INSERT INTO TripMember (tripId, userId, role) VALUES (?,?,?)', [t, USER, 'member']);
        await assertEquivalent(USER, 4);
    });
});
