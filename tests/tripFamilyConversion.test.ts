import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { createHousehold, joinHousehold, markMemberLeaving } from '../src/models/householdModel.js';
import { createTrip, getTripById } from '../src/models/tripModel.js';
import { getLedgerEvents, getLedgerState, getReceiptRecordedEvent } from '../src/models/householdLedgerModel.js';
import { computeFamilySubtotalCents, replaceReceiptItems } from '../src/models/receiptItemModel.js';
import { convertTripToFamily } from '../src/services/tripFamilyConversion.js';
import { setReceiptItemScope } from '../src/services/receiptFamilyScope.js';

/**
 * FAMILY SHOPPING §7 — "Convert to family shopping", against the real database.
 *
 * The thing under test is a state transition with money attached, so every test
 * here checks BOTH halves: the trip actually became a family trip, and the
 * ledger says something true about it afterwards. Two invariants run through
 * all of them:
 *   §1.2  balances sum to exactly zero — `deriveLedgerState` throws when they
 *         don't, so every `getLedgerState` call is also that assertion.
 *   §4.3  what enters the ledger is the FAMILY SUBTOTAL, never the grand total.
 *
 * And one property the endpoint's whole design rests on: converting is ONE-WAY
 * and AT-MOST-ONCE. Both are tested from the outside (a second convert is
 * refused) and from the inside (the `receipt:<id>` dedupe key holds even when
 * the outer guard is deliberately defeated).
 */

const OWNER = 'tfc-owner-0000-0000-000000000001';
const ALICE = 'tfc-alice-0000-0000-000000000002';
const BOB = 'tfc-bob00-0000-0000-000000000003';
/** In no household at all — the "non-member cannot convert" case. */
const STRANGER = 'tfc-stran-0000-0000-000000000004';
const ALL_USERS = [OWNER, ALICE, BOB, STRANGER];

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const createdHouseholds: number[] = [];
const createdReceipts: number[] = [];
const createdTrips: number[] = [];

const freshHousehold = async (owner: string, others: string[] = []): Promise<number> => {
    const { householdId } = await createHousehold(owner, 'Test');
    createdHouseholds.push(householdId);
    for (const m of others) await joinHousehold(householdId, m);
    return householdId;
};

/** A trip. `householdId: null` = the PERSONAL trip §7 converts. */
const freshTrip = async (creator: string, householdId: number | null = null): Promise<number> => {
    const tripId = await createTrip(creator, { householdId, isAdHoc: true });
    createdTrips.push(tripId);
    return tripId;
};

/** A receipt on `tripId`. `lines` are `[grossEuros, isPersonal]`. */
const freshReceipt = async (args: {
    tripId: number | null;
    uploader: string;
    lines: [number, boolean][];
    /** parsedData.footer.total — the GRAND TOTAL that must never reach a balance. */
    printedTotal?: number;
}): Promise<number> => {
    const parsed = JSON.stringify({
        header: {}, products: [],
        footer: { total: args.printedTotal ?? 99.99, totalSavings: 1.23, comboDiscount: 0 },
    });
    const r = await q(
        `INSERT INTO Receipt (userId, uploaderUserId, tripId, storeId, filePath, fileType,
                              processingStatus, receiptDate, parsedData, savedAmount)
         VALUES (?,?,?,NULL,?, 'jpg', 'done', NOW(), ?, 0)`,
        [args.uploader, args.uploader, args.tripId, `receipts/${Date.now()}-${Math.random()}.jpg`, parsed],
    );
    const receiptId = Number(r.insertId);
    createdReceipts.push(receiptId);
    await replaceReceiptItems(receiptId, args.lines.map(([price, isPersonal], i) => ({
        name: `Item ${i}`, price, quantity: 1, isPersonal,
    })));
    return receiptId;
};

const balances = async (householdId: number) => (await getLedgerState(householdId)).balances;

const expectZeroSum = async (householdId: number): Promise<void> => {
    const b = await balances(householdId);
    expect(Object.values(b).reduce((a, v) => a + v, 0)).toBe(0);
};

const recordedEvents = async (householdId: number) =>
    (await getLedgerEvents(householdId)).filter(e => e.type === 'receipt_recorded');

const cleanAll = async () => {
    if (createdReceipts.length) {
        await q('DELETE FROM ReceiptItem WHERE receiptId IN (?)', [createdReceipts]);
        await q('DELETE FROM Receipt WHERE id IN (?)', [createdReceipts]);
        createdReceipts.length = 0;
    }
    if (createdTrips.length) {
        await q('DELETE FROM TripMember WHERE tripId IN (?)', [createdTrips]);
        await q('DELETE FROM Trip WHERE id IN (?)', [createdTrips]);
        createdTrips.length = 0;
    }
    for (const u of ALL_USERS) {
        await q('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
        await q('DELETE FROM BasketItem WHERE basketId IN (SELECT id FROM Basket WHERE userId = ?)', [u]);
        await q('DELETE FROM Basket WHERE userId = ?', [u]);
        await q('DELETE FROM Notification WHERE userId = ?', [u]);
    }
    await q('DELETE FROM Household WHERE createdByUserId IN (?)', [ALL_USERS]);
};

beforeAll(async () => {
    await primeTokens(...ALL_USERS);
    for (const u of ALL_USERS) {
        await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    }
    await cleanAll();
});

afterEach(cleanAll);

afterAll(async () => {
    await cleanAll();
    if (createdHouseholds.length) {
        await q('DELETE FROM HouseholdLedgerEvent WHERE householdId IN (?)', [createdHouseholds]);
    }
    for (const u of ALL_USERS) await q('DELETE FROM User WHERE id = ?', [u]);
    await (pool as any).end();
});

// ---------------------------------------------------------------------------
// The conversion itself
// ---------------------------------------------------------------------------

describe('§7 convert — the state transition', () => {
    it('sets Trip.householdId and records the trip\'s receipts at their FAMILY subtotal', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        // €10.00 + €5.50 family, €4.20 personal; printed grand total €19.70.
        const rid = await freshReceipt({
            tripId, uploader: OWNER,
            lines: [[10.00, false], [5.50, false], [4.20, true]],
            printedTotal: 19.70,
        });

        const out = await convertTripToFamily(tripId, OWNER);

        expect((await getTripById(tripId))!.householdId).toBe(hh);
        expect(out.householdId).toBe(hh);
        expect(out.recorded).toEqual([
            { receiptId: rid, payer: OWNER, amountCents: 1550, alreadyRecorded: false },
        ]);
        expect(out.skipped).toEqual([]);
        // 1550, NOT 1970: the personal €4.20 never reaches a balance (§4.3).
        expect((await getReceiptRecordedEvent(hh, rid))!.amountCents).toBe(1550);
        // Payer overpaid their own share: 1550 − 775.
        expect(await balances(hh)).toEqual({ [OWNER]: 775, [ALICE]: -775 });
        await expectZeroSum(hh);
    });

    it('records EVERY receipt already on the trip, each to its own uploader', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const mine = await freshReceipt({ tripId, uploader: OWNER, lines: [[12.00, false]] });
        // ALICE is in the household, so her receipt is countable too — the payer
        // is the RECEIPT'S uploader, never the converter.
        const hers = await freshReceipt({ tripId, uploader: ALICE, lines: [[6.00, false]] });

        const out = await convertTripToFamily(tripId, OWNER);

        expect(out.recorded.map(r => [r.receiptId, r.payer, r.amountCents]))
            .toEqual([[mine, OWNER, 1200], [hers, ALICE, 600]]);
        // OWNER: 1200 − 600 − 300 = +300. ALICE: 600 − 600 − 300 = −300.
        expect(await balances(hh)).toEqual({ [OWNER]: 300, [ALICE]: -300 });
        await expectZeroSum(hh);
    });

    it('records a receipt whose family subtotal is ZERO, so a later toggle still has something to restate', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({ tripId, uploader: OWNER, lines: [[9.00, true]] });

        const out = await convertTripToFamily(tripId, OWNER);
        expect(out.recorded).toEqual([
            { receiptId: rid, payer: OWNER, amountCents: 0, alreadyRecorded: false },
        ]);
        expect(await balances(hh)).toEqual({ [OWNER]: 0, [ALICE]: 0 });

        // The point of recording zero: the §4.1 toggle now reconciles instead of
        // answering `ledger: 'none'` and losing the money forever.
        const res = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [0], isPersonal: false,
        });
        expect(res.ledger).toBe('restated');
        expect(res.familySubtotalCents).toBe(900);
        expect(await balances(hh)).toEqual({ [OWNER]: 450, [ALICE]: -450 });
        await expectZeroSum(hh);
    });

    it('converts a trip with no receipts at all — the trip is family, the ledger is untouched', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);

        const out = await convertTripToFamily(tripId, OWNER);
        expect(out.recorded).toEqual([]);
        expect((await getTripById(tripId))!.householdId).toBe(hh);
        expect(await recordedEvents(hh)).toHaveLength(0);
        await expectZeroSum(hh);
    });

    it('ignores a user-deleted receipt — counting it would make it retroactively undeletable (§8)', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const live = await freshReceipt({ tripId, uploader: OWNER, lines: [[4.00, false]] });
        const gone = await freshReceipt({ tripId, uploader: OWNER, lines: [[8.00, false]] });
        await q('UPDATE Receipt SET userDeletedAt = NOW() WHERE id = ?', [gone]);

        const out = await convertTripToFamily(tripId, OWNER);
        expect(out.recorded.map(r => r.receiptId)).toEqual([live]);
        expect(await getReceiptRecordedEvent(hh, gone)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// At-most-once / one-way
// ---------------------------------------------------------------------------

describe('§7 convert — idempotence and irreversibility', () => {
    it('refuses a SECOND convert and leaves the ledger exactly as it was', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        await freshReceipt({ tripId, uploader: OWNER, lines: [[10.00, false]] });

        await convertTripToFamily(tripId, OWNER);
        const before = await balances(hh);
        const eventsBefore = await getLedgerEvents(hh);

        await expect(convertTripToFamily(tripId, OWNER)).rejects.toMatchObject({ status: 409, code: 'already-family' });

        expect(await balances(hh)).toEqual(before);
        expect((await getLedgerEvents(hh)).map(e => e.id)).toEqual(eventsBefore.map(e => e.id));
        await expectZeroSum(hh);
    });

    it('cannot be run twice even with the trip guard defeated — the receipt:<id> dedupe key holds', async () => {
        // The inner layer, tested on its own: if the outer `householdId IS NULL`
        // predicate were ever bypassed (a race, a future path), no receipt may
        // be counted twice.
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({ tripId, uploader: OWNER, lines: [[10.00, false]] });

        await convertTripToFamily(tripId, OWNER);
        const before = await balances(hh);
        await q('UPDATE Trip SET householdId = NULL WHERE id = ?', [tripId]);

        const out = await convertTripToFamily(tripId, OWNER);
        expect(out.recorded).toEqual([
            { receiptId: rid, payer: OWNER, amountCents: 1000, alreadyRecorded: true },
        ]);
        expect(await recordedEvents(hh)).toHaveLength(1);
        expect(await balances(hh)).toEqual(before);
        await expectZeroSum(hh);
    });

    it('a trip that is ALREADY family (born from the shared basket) is refused', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER, hh);
        await expect(convertTripToFamily(tripId, OWNER)).rejects.toMatchObject({ status: 409, code: 'already-family' });
    });

    it('cannot re-point a family trip at a DIFFERENT household', async () => {
        const theirs = await freshHousehold(ALICE);
        const mine = await freshHousehold(OWNER);
        const tripId = await freshTrip(OWNER, theirs);
        await expect(convertTripToFamily(tripId, OWNER)).rejects.toMatchObject({ status: 409 });
        expect((await getTripById(tripId))!.householdId).toBe(theirs);
        expect(await recordedEvents(mine)).toHaveLength(0);
    });

    it('exposes NO route that un-converts a trip', async () => {
        // Irreversibility is structural: there is no inverse endpoint, so the
        // only reachable verbs on this path are the one that converts and the
        // ones that already existed.
        const hh = await freshHousehold(OWNER);
        const tripId = await freshTrip(OWNER);
        await convertTripToFamily(tripId, OWNER);
        const api = asUser(app, OWNER);
        await api.delete(`/api/trips/${tripId}/convert-to-family`).expect(404);
        await api.post(`/api/trips/${tripId}/convert-to-personal`).expect(404);
        expect((await getTripById(tripId))!.householdId).toBe(hh);
    });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('§7 convert — who may do it', () => {
    it('a NON-MEMBER (no household at all) cannot convert', async () => {
        const tripId = await freshTrip(STRANGER);
        await expect(convertTripToFamily(tripId, STRANGER))
            .rejects.toMatchObject({ status: 403, code: 'not-a-household-member' });
        expect((await getTripById(tripId))!.householdId).toBeNull();
    });

    it('SOMEONE ELSE\'S trip cannot be converted, even by a fellow trip member', async () => {
        await freshHousehold(ALICE);
        const tripId = await freshTrip(OWNER);
        // ALICE is on the trip but did not create it.
        await q("INSERT INTO TripMember (tripId, userId, role) VALUES (?,?,'member')", [tripId, ALICE]);
        await expect(convertTripToFamily(tripId, ALICE))
            .rejects.toMatchObject({ status: 403, code: 'not-trip-owner' });
        expect((await getTripById(tripId))!.householdId).toBeNull();
    });

    it('a stranger to the trip gets 404, not 403 — a bare trip id stays unprobeable', async () => {
        await freshHousehold(BOB);
        const tripId = await freshTrip(OWNER);
        await asUser(app, BOB).post(`/api/trips/${tripId}/convert-to-family`).expect(404);
        expect((await getTripById(tripId))!.householdId).toBeNull();
    });

    it('a member in the §3.2.2 LEAVING state cannot convert', async () => {
        const hh = await freshHousehold(BOB, [OWNER]);
        const tripId = await freshTrip(OWNER);
        await markMemberLeaving(hh, OWNER, OWNER);
        await expect(convertTripToFamily(tripId, OWNER))
            .rejects.toMatchObject({ status: 403, code: 'member-leaving' });
        expect((await getTripById(tripId))!.householdId).toBeNull();
    });

    it('a missing trip is 404', async () => {
        await freshHousehold(OWNER);
        await expect(convertTripToFamily(2147483647, OWNER)).rejects.toMatchObject({ status: 404 });
    });
});

// ---------------------------------------------------------------------------
// §1.1 / §3.5 the participant set
// ---------------------------------------------------------------------------

describe('§7 convert — the participant set is the household as of NOW', () => {
    it('INCLUDES a member who joined after the shopping happened (§3.5: "recorded AFTER member_joined")', async () => {
        const hh = await freshHousehold(OWNER);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({ tripId, uploader: OWNER, lines: [[9.00, false]] });
        // The shop, and its receipt, predate ALICE entirely.
        await q('UPDATE Receipt SET uploadedAt = DATE_SUB(NOW(), INTERVAL 10 DAY), receiptDate = DATE_SUB(NOW(), INTERVAL 10 DAY) WHERE id = ?', [rid]);
        await joinHousehold(hh, ALICE);

        const out = await convertTripToFamily(tripId, OWNER);
        expect(out.participants.sort()).toEqual([ALICE, OWNER].sort());
        expect(Object.keys((await getReceiptRecordedEvent(hh, rid))!.shares).sort())
            .toEqual([ALICE, OWNER].sort());
        expect(await balances(hh)).toEqual({ [OWNER]: 450, [ALICE]: -450 });
        await expectZeroSum(hh);
    });

    it('EXCLUDES a member who has requested to leave (§3.2.2 freezes their balance)', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({ tripId, uploader: OWNER, lines: [[9.00, false]] });
        await markMemberLeaving(hh, BOB, OWNER);

        const out = await convertTripToFamily(tripId, OWNER);
        expect(out.participants).not.toContain(BOB);
        expect(Object.keys((await getReceiptRecordedEvent(hh, rid))!.shares).sort())
            .toEqual([ALICE, OWNER].sort());
        const b = await balances(hh);
        expect(b[BOB] ?? 0).toBe(0);
        await expectZeroSum(hh);
    });

    it('freezes ONE set across the whole conversion, shared by every receipt it records', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        const tripId = await freshTrip(OWNER);
        const a = await freshReceipt({ tripId, uploader: OWNER, lines: [[3.00, false]] });
        const b = await freshReceipt({ tripId, uploader: ALICE, lines: [[6.00, false]] });

        await convertTripToFamily(tripId, OWNER);
        const shareSets = [a, b].map(async id => Object.keys((await getReceiptRecordedEvent(hh, id))!.shares).sort());
        const [sa, sb] = await Promise.all(shareSets);
        expect(sa).toEqual(sb);
        expect(sa).toEqual([ALICE, BOB, OWNER].sort());
        await expectZeroSum(hh);
    });

    it('does NOT retroactively re-split when someone joins after the conversion (§1.1)', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({ tripId, uploader: OWNER, lines: [[10.00, false]] });
        await convertTripToFamily(tripId, OWNER);

        await joinHousehold(hh, BOB);
        expect(Object.keys((await getReceiptRecordedEvent(hh, rid))!.shares).sort())
            .toEqual([ALICE, OWNER].sort());
        const b = await balances(hh);
        expect(b[BOB] ?? 0).toBe(0);
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// Never fabricate a payer
// ---------------------------------------------------------------------------

describe('§7 convert — a receipt with no payer in this ledger', () => {
    it('SKIPS a receipt uploaded by someone outside the household, and says so', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const mine = await freshReceipt({ tripId, uploader: OWNER, lines: [[10.00, false]] });
        const theirs = await freshReceipt({ tripId, uploader: STRANGER, lines: [[30.00, false]] });

        const out = await convertTripToFamily(tripId, OWNER);

        expect(out.recorded.map(r => r.receiptId)).toEqual([mine]);
        expect(out.skipped).toEqual([{ receiptId: theirs, reason: 'payer-not-eligible' }]);
        // The stranger's €30 is nowhere in the ledger, and above all it was NOT
        // credited to the converter.
        expect(await getReceiptRecordedEvent(hh, theirs)).toBeNull();
        expect(await balances(hh)).toEqual({ [OWNER]: 500, [ALICE]: -500 });
        await expectZeroSum(hh);
    });

    it('skips a receipt uploaded by a member who is LEAVING (they cannot be a payer)', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const hers = await freshReceipt({ tripId, uploader: ALICE, lines: [[8.00, false]] });
        await markMemberLeaving(hh, ALICE, ALICE);

        const out = await convertTripToFamily(tripId, OWNER);
        expect(out.skipped).toEqual([{ receiptId: hers, reason: 'payer-not-eligible' }]);
        expect(await getReceiptRecordedEvent(hh, hers)).toBeNull();
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// What the conversion makes true afterwards
// ---------------------------------------------------------------------------

describe('§7 convert — the trip behaves like a household-born family trip', () => {
    it('the §4.1 toggle now reaches the ledger (it did nothing before the conversion)', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({ tripId, uploader: OWNER, lines: [[10.00, false], [4.00, false]] });

        // Before: a personal trip has no ledger to reconcile with.
        const pre = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [1], isPersonal: true,
        });
        expect(pre.ledger).toBe('none');

        await convertTripToFamily(tripId, OWNER);
        expect(await computeFamilySubtotalCents(rid)).toBe(1000);
        expect((await getReceiptRecordedEvent(hh, rid))!.amountCents).toBe(1000);

        // After: the same toggle restates the family subtotal (§4.4, pre-lock).
        const post = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [0], isPersonal: true,
        });
        expect(post.ledger).toBe('restated');
        expect((await getReceiptRecordedEvent(hh, rid))!.amountCents).toBe(0);
        await expectZeroSum(hh);
    });

    it('§8 — a counted receipt can no longer be DETACHED from the trip', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({ tripId, uploader: OWNER, lines: [[10.00, false]] });
        await convertTripToFamily(tripId, OWNER);

        // Detach → delete used to be a two-step way around §8's "a receipt
        // counted into the ledger cannot be deleted".
        await asUser(app, OWNER).delete(`/api/trips/${tripId}/receipts/${rid}`).expect(423);
        const [row]: any = await q('SELECT tripId FROM Receipt WHERE id = ?', [rid]);
        expect(Number(row.tripId)).toBe(tripId);
        expect((await getReceiptRecordedEvent(hh, rid))!.amountCents).toBe(1000);
    });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

describe('POST /api/trips/:id/convert-to-family', () => {
    it('returns the conversion result and flips the trip', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const tripId = await freshTrip(OWNER);
        const rid = await freshReceipt({
            tripId, uploader: OWNER, lines: [[10.00, false], [4.20, true]], printedTotal: 14.20,
        });

        const res = await asUser(app, OWNER).post(`/api/trips/${tripId}/convert-to-family`).expect(200);
        expect(res.body).toMatchObject({
            tripId, householdId: hh,
            recorded: [{ receiptId: rid, payer: OWNER, amountCents: 1000, alreadyRecorded: false }],
            skipped: [],
        });
        expect(res.body.participants.sort()).toEqual([ALICE, OWNER].sort());
        // §4.5's rule holds through the new endpoint too: no grand total anywhere.
        expect(JSON.stringify(res.body)).not.toContain('1420');
        await expectZeroSum(hh);
    });

    it('answers 409 on the second call', async () => {
        await freshHousehold(OWNER);
        const tripId = await freshTrip(OWNER);
        const api = asUser(app, OWNER);
        await api.post(`/api/trips/${tripId}/convert-to-family`).expect(200);
        const res = await api.post(`/api/trips/${tripId}/convert-to-family`).expect(409);
        expect(res.body.error).toBe('already-family');
    });

    it('answers 403 when the caller has no household', async () => {
        const tripId = await freshTrip(STRANGER);
        const res = await asUser(app, STRANGER).post(`/api/trips/${tripId}/convert-to-family`).expect(403);
        expect(res.body.error).toBe('not-a-household-member');
    });

    it('rejects a non-numeric trip id', async () => {
        await freshHousehold(OWNER);
        await asUser(app, OWNER).post('/api/trips/abc/convert-to-family').expect(400);
    });
});
