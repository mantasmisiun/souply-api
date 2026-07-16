import pool from '../src/config/db.js';
import { createTrip } from '../src/models/tripModel.js';
import { sweepTripAutoArchive } from '../src/services/tripArchiveService.js';

/**
 * Trip auto-archive sweep: 48 h for list-less (stage 1-2) trips, 7 d for
 * planned (stage 3-4) trips with an open slot, NEVER for closed (stage 5)
 * trips or ad-hoc history.
 */

const USER = 'trarch-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAIN_ID = 9965;
const STORE_ID = 99651;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];
const setUpdated = (tripId: number, hoursAgo: number) =>
    q('UPDATE Trip SET updatedAt = DATE_SUB(NOW(), INTERVAL ? HOUR) WHERE id = ?', [hoursAgo, tripId]);
const archivedAt = async (tripId: number) =>
    (await q('SELECT archivedAt FROM Trip WHERE id = ?', [tripId]))[0]?.archivedAt ?? null;

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'TrArch Chain']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_ID, CHAIN_ID, 'TrArch Store', 'Test St. 4']);
});

afterAll(async () => {
    await q('DELETE FROM Receipt WHERE userId = ?', [USER]);
    await q('DELETE FROM ShoppingList WHERE userId = ?', [USER]);
    await q('DELETE FROM TripMember WHERE userId = ?', [USER]);
    await q('DELETE FROM Trip WHERE createdByUserId = ?', [USER]);
    await (pool as any).end();
});

describe('sweepTripAutoArchive', () => {
    it('archives idle forming trips after 48h but not fresh ones', async () => {
        const oldForming = await createTrip(USER);
        const freshForming = await createTrip(USER);
        await setUpdated(oldForming, 49);
        await setUpdated(freshForming, 47);

        await sweepTripAutoArchive();

        expect(await archivedAt(oldForming)).not.toBeNull();
        expect(await archivedAt(freshForming)).toBeNull();
    });

    it('archives planned trips at 7d, keeps them at 48h, never touches closed or ad-hoc', async () => {
        const mk = async (hoursIdle: number, closeSlot: boolean) => {
            const tripId = await createTrip(USER);
            await q('INSERT INTO ShoppingList (userId, storeId, status, tripId) VALUES (?,?,"completed",?)', [USER, STORE_ID, tripId]);
            if (closeSlot) {
                await q('UPDATE ShoppingList SET receiptSkippedAt = NOW() WHERE tripId = ?', [tripId]);
            }
            await setUpdated(tripId, hoursIdle);
            return tripId;
        };

        const plannedOld = await mk(7 * 24 + 1, false);   // stage 4, idle > 7d → archive
        const plannedFresh = await mk(49, false);         // stage 4, idle 49h → keep (48h rule is stages 1-2 only)
        const closedOld = await mk(7 * 24 + 1, true);     // stage 5 → never
        const adHocOld = await createTrip(USER, { isAdHoc: true });
        await setUpdated(adHocOld, 7 * 24 + 1);           // ad-hoc → never

        await sweepTripAutoArchive();

        expect(await archivedAt(plannedOld)).not.toBeNull();
        expect(await archivedAt(plannedFresh)).toBeNull();
        expect(await archivedAt(closedOld)).toBeNull();
        expect(await archivedAt(adHocOld)).toBeNull();
    });
});
