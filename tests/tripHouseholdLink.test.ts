import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { createHousehold } from '../src/models/householdModel.js';
import { ensureTripForBasket } from '../src/services/tripLinkService.js';
import { createBasket } from '../src/models/basketModel.js';
import { listTripsForUser } from '../src/services/tripListService.js';
import { getReceiptScopeContext } from '../src/services/receiptFamilyScope.js';

/**
 * `Trip.householdId` — the column that existed and was never written.
 *
 * sql/trip_foundation.sql has carried `householdId` (and idx_trip_household)
 * since Phase 1a, but no code path ever set it: every trip in the database was
 * personal by omission. That is load-bearing, not cosmetic —
 * `receiptFamilyScope` resolves Receipt.tripId → Trip.householdId and reads
 * NULL as "an ordinary personal receipt", so the whole family half of §4 could
 * never engage on a real trip. These tests pin both halves: the trip is written
 * with its basket's household, and the API surfaces it.
 */

const OWNER = 'thl-owner-0000-0000-000000000001';
const SOLO = 'thl-solo0-0000-0000-000000000002';
const ALL_USERS = [OWNER, SOLO];

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const clean = async () => {
    for (const u of ALL_USERS) {
        await q('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
        await q('DELETE FROM Receipt WHERE userId = ?', [u]);
        await q('DELETE FROM TripMember WHERE userId = ?', [u]);
        await q('DELETE FROM Trip WHERE createdByUserId = ?', [u]);
        await q('DELETE FROM BasketItem WHERE basketId IN (SELECT id FROM Basket WHERE userId = ?)', [u]);
        await q('DELETE FROM Basket WHERE userId = ?', [u]);
    }
    await q('DELETE FROM Household WHERE createdByUserId IN (?)', [ALL_USERS]);
};

beforeAll(async () => {
    await primeTokens(...ALL_USERS);
    for (const u of ALL_USERS) {
        await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    }
    await clean();
});

afterEach(clean);

afterAll(async () => {
    await clean();
    await q('DELETE FROM HouseholdLedgerEvent WHERE actorUserId IN (?)', [ALL_USERS]);
    for (const u of ALL_USERS) await q('DELETE FROM User WHERE id = ?', [u]);
    await (pool as any).end();
});

const householdIdOfTrip = async (tripId: number): Promise<number | null> => {
    const rows = await q('SELECT householdId FROM Trip WHERE id = ?', [tripId]);
    return rows[0]?.householdId ?? null;
};

describe('a trip inherits its basket\'s household', () => {
    it('the trip born from the SHARED basket carries householdId', async () => {
        const { householdId, sharedBasketId } = await createHousehold(OWNER, 'Šeima');
        const tripId = await ensureTripForBasket(sharedBasketId, OWNER);
        expect(await householdIdOfTrip(tripId)).toBe(householdId);
    });

    it('a PERSONAL basket stays personal even for a household member', async () => {
        // The whole family/personal split (§4) depends on this: if membership
        // alone made a trip family, every solo shop would land in the ledger.
        await createHousehold(OWNER, 'Šeima');
        const personal = await createBasket(OWNER, null);
        const tripId = await ensureTripForBasket(personal, OWNER);
        expect(await householdIdOfTrip(tripId)).toBeNull();
    });

    it('is idempotent — a second call returns the same trip, not a second one', async () => {
        const { householdId, sharedBasketId } = await createHousehold(OWNER, 'Šeima');
        const first = await ensureTripForBasket(sharedBasketId, OWNER);
        const second = await ensureTripForBasket(sharedBasketId, OWNER);
        expect(second).toBe(first);
        expect(await householdIdOfTrip(first)).toBe(householdId);
    });

    it('makes a receipt on that trip resolvable as a FAMILY receipt', async () => {
        // The end the column exists for: receiptFamilyScope's whole chain is
        // Receipt.tripId → Trip.householdId, and it was dead while nothing
        // populated it.
        const { householdId, sharedBasketId } = await createHousehold(OWNER, 'Šeima');
        const tripId = await ensureTripForBasket(sharedBasketId, OWNER);
        const r = await q(
            `INSERT INTO Receipt (userId, uploaderUserId, tripId, filePath, fileType, processingStatus)
             VALUES (?,?,?,?, 'jpg', 'done')`,
            [OWNER, OWNER, tripId, `receipts/thl-${Date.now()}.jpg`]);
        const ctx = await getReceiptScopeContext(Number(r.insertId));
        expect(ctx?.householdId).toBe(householdId);
    });
});

describe('TripSummary surfaces householdId', () => {
    it('GET /api/trips carries it, so the client never infers family-ness from the basket', async () => {
        const { householdId, sharedBasketId } = await createHousehold(OWNER, 'Šeima');
        const familyTrip = await ensureTripForBasket(sharedBasketId, OWNER);
        const personalTrip = await ensureTripForBasket(await createBasket(OWNER, null), OWNER);

        const res = await asUser(app, OWNER).get('/api/trips');
        expect(res.status).toBe(200);
        const byId = new Map<number, any>(res.body.map((t: any) => [t.id, t]));
        expect(byId.get(familyTrip).householdId).toBe(householdId);
        expect(byId.get(personalTrip).householdId).toBeNull();
    });

    it('is null on every trip of a user with no household', async () => {
        await ensureTripForBasket(await createBasket(SOLO, null), SOLO);
        const trips = await listTripsForUser(SOLO);
        expect(trips.length).toBeGreaterThan(0);
        for (const t of trips) expect(t.householdId).toBeNull();
    });
});
