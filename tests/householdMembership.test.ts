import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import {
    createHousehold, getMembership, getHouseholdMembers, joinHousehold,
} from '../src/models/householdModel.js';
import {
    appendSettlementProposed, getLedgerEvents, getLedgerState,
} from '../src/models/householdLedgerModel.js';
import {
    AUTO_CONFIRM_ACTOR, deriveLedgerState,
} from '../src/services/householdLedger.js';
import type { LedgerEvent } from '../src/services/householdLedger.js';
import {
    finalizeDeparture, getHouseholdLedgerView, recordFamilyReceipt,
    requestLeaveHousehold, requestRemoveMember, settleDeparturesIfCleared,
} from '../src/services/householdMembership.js';
import {
    confirmSettlement, proposeSettlement, sweepLapsedSettlements,
} from '../src/services/householdSettlements.js';

/**
 * FAMILY SHOPPING §3 — MEMBERSHIP, end to end against the real database.
 *
 * The through-line of every test here is the §1.2 INVARIANT: the balances of a
 * household sum to exactly zero, after every event, on every path. `state()`
 * below folds the log via deriveLedgerState, which THROWS when the sum drifts —
 * so every single assertion in this file is implicitly also a zero-sum check,
 * and `expectZeroSum` makes it explicit at the ends of the interesting paths.
 */

const OWNER = 'hhm-owner-0000-0000-000000000001';
const ALICE = 'hhm-alice-0000-0000-000000000002';
const BOB = 'hhm-bob00-0000-0000-000000000003';
const CARL = 'hhm-carl0-0000-0000-000000000004';
// A parallel household, for the auto-confirm-vs-manual-confirm comparison.
const OWNER2 = 'hhm-owner2-000-0000-000000000005';
const ALICE2 = 'hhm-alice2-000-0000-000000000006';
const BOB2 = 'hhm-bob002-000-0000-000000000007';

const ALL_USERS = [OWNER, ALICE, BOB, CARL, OWNER2, ALICE2, BOB2];
const DAY_MS = 24 * 60 * 60 * 1000;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const createdHouseholds: number[] = [];

/** A fresh household with `members[0]` as owner. Each call gets a new id, so
 *  the ledger log of one test can never leak into another. */
const freshHousehold = async (owner: string, others: string[] = []): Promise<number> => {
    const { householdId } = await createHousehold(owner, 'Test');
    createdHouseholds.push(householdId);
    for (const m of others) await joinHousehold(householdId, m);
    return householdId;
};

const state = (householdId: number) => getLedgerState(householdId);

const expectZeroSum = async (householdId: number): Promise<void> => {
    const s = await state(householdId);
    const total = Object.values(s.balances).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
};

const balanceOf = async (householdId: number, member: string): Promise<number> =>
    (await state(householdId)).balances[member] ?? 0;

const eventsOfType = async (householdId: number, type: string): Promise<LedgerEvent[]> =>
    (await getLedgerEvents(householdId)).filter(e => e.type === type);

const cleanUsers = async () => {
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
    await cleanUsers();
});

afterEach(async () => {
    await cleanUsers();
});

afterAll(async () => {
    await cleanUsers();
    if (createdHouseholds.length) {
        await q('DELETE FROM HouseholdLedgerEvent WHERE householdId IN (?)', [createdHouseholds]);
    }
    for (const u of ALL_USERS) await q('DELETE FROM User WHERE id = ?', [u]);
    await (pool as any).end();
});

// ---------------------------------------------------------------------------
// §3.1 — the balance gate on leaving and being removed
// ---------------------------------------------------------------------------

describe('§3.1 a member cannot leave or be removed with a non-zero balance', () => {
    it('leaves immediately when the balance is zero', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);

        const outcome = await requestLeaveHousehold(BOB);
        expect(outcome).toMatchObject({ status: 'departed', member: BOB, balanceCents: 0 });
        expect(await getMembership(BOB)).toBeNull();
        expect((await eventsOfType(hh, 'member_left')).length).toBe(1);
        expect((await state(hh)).activeMembers).toEqual(expect.not.arrayContaining([BOB]));
        await expectZeroSum(hh);
    });

    it('blocks the departure into the "leaving" state when the balance is non-zero', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        // OWNER pays €30 for all three → ALICE and BOB owe €10 each.
        await recordFamilyReceipt({ householdId: hh, receiptId: 71001, payer: OWNER, amountCents: 3000 });
        expect(await balanceOf(hh, ALICE)).toBe(-1000);

        const outcome = await requestLeaveHousehold(ALICE);
        expect(outcome).toMatchObject({
            status: 'leaving', member: ALICE, balanceCents: -1000, blockedBy: 'own-balance',
        });
        expect(outcome!.transfers).toEqual([{ from: ALICE, to: OWNER, amountCents: 1000 }]);

        // Still a member — the request is accepted, not completed.
        const membership = await getMembership(ALICE);
        expect(membership).not.toBeNull();
        expect(membership!.leavingRequestedAt).not.toBeNull();
        expect(membership!.leavingRequestedBy).toBe(ALICE);
        // And NO member_left was written: they have not left.
        expect(await eventsOfType(hh, 'member_left')).toHaveLength(0);
        await expectZeroSum(hh);
    });

    it('blocks an owner-initiated removal of an indebted member the same way', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 71002, payer: OWNER, amountCents: 3000 });

        const outcome = await requestRemoveMember(OWNER, ALICE);
        expect(outcome).toMatchObject({ status: 'leaving', member: ALICE, blockedBy: 'own-balance' });
        const membership = await getMembership(ALICE);
        expect(membership!.leavingRequestedAt).not.toBeNull();
        // leavingRequestedBy distinguishes a removal from a self-request.
        expect(membership!.leavingRequestedBy).toBe(OWNER);
        await expectZeroSum(hh);
    });

    it('lets the owner remove a settled member outright', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        const outcome = await requestRemoveMember(OWNER, BOB);
        expect(outcome!.status).toBe('departed');
        expect(await getMembership(BOB)).toBeNull();
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// §3.3 — permissions
// ---------------------------------------------------------------------------

describe('§3.3 permissions', () => {
    it('the owner cannot remove themselves', async () => {
        await freshHousehold(OWNER, [ALICE]);
        expect(await requestRemoveMember(OWNER, OWNER)).toBeNull();
        expect(await getMembership(OWNER)).not.toBeNull();
    });

    it('a non-owner cannot remove another member', async () => {
        await freshHousehold(OWNER, [ALICE, BOB]);
        expect(await requestRemoveMember(ALICE, BOB)).toBeNull();
        expect(await getMembership(BOB)).not.toBeNull();
    });

    it('a non-owner cannot remove the owner', async () => {
        await freshHousehold(OWNER, [ALICE]);
        expect(await requestRemoveMember(ALICE, OWNER)).toBeNull();
        expect(await getMembership(OWNER)).not.toBeNull();
    });

    it('the owner cannot remove someone in a different household', async () => {
        await freshHousehold(OWNER, [ALICE]);
        await freshHousehold(OWNER2, [BOB2]);
        expect(await requestRemoveMember(OWNER, BOB2)).toBeNull();
        expect(await getMembership(BOB2)).not.toBeNull();
    });

    it('a user with no household gets nothing to act on', async () => {
        expect(await requestLeaveHousehold(CARL)).toBeNull();
    });

    it('any member may remove THEMSELVES', async () => {
        await freshHousehold(OWNER, [ALICE]);
        expect((await requestLeaveHousehold(ALICE))!.status).toBe('departed');
        expect(await getMembership(ALICE)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// §3.2.2 — the leaving state freezes the balance
// ---------------------------------------------------------------------------

describe('§3.2.2 a leaving member is excluded from new trips immediately', () => {
    it('accrues NO share on a receipt recorded after the leave request', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 72001, payer: OWNER, amountCents: 3000 });
        await requestLeaveHousehold(ALICE);
        const frozen = await balanceOf(hh, ALICE);
        expect(frozen).toBe(-1000);

        // A new trip, recorded AFTER the request. Participants default to the
        // eligible members, which no longer include ALICE.
        const ev: any = await recordFamilyReceipt({
            householdId: hh, receiptId: 72002, payer: OWNER, amountCents: 1000,
        });
        expect(Object.keys(ev.shares).sort()).toEqual([BOB, OWNER].sort());
        expect(ev.shares[ALICE]).toBeUndefined();

        // Frozen: unchanged by a receipt she was not part of.
        expect(await balanceOf(hh, ALICE)).toBe(frozen);
        expect(await balanceOf(hh, BOB)).toBe(-1500);
        await expectZeroSum(hh);
    });

    it('drops a leaving member even when explicitly named as a participant', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await requestLeaveHousehold(ALICE); // zero balance → departs outright
        expect(await getMembership(ALICE)).toBeNull();

        // Now the indebted case: BOB is leaving but still a member.
        await recordFamilyReceipt({ householdId: hh, receiptId: 72003, payer: OWNER, amountCents: 1000 });
        await requestLeaveHousehold(BOB);
        const ev: any = await recordFamilyReceipt({
            householdId: hh, receiptId: 72004, payer: OWNER, amountCents: 500,
            participants: [OWNER, BOB],
        });
        expect(Object.keys(ev.shares)).toEqual([OWNER]);
        expect(ev.shares[OWNER]).toBe(500);
        await expectZeroSum(hh);
    });

    it('refuses a family receipt uploaded BY a leaving member', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 72005, payer: OWNER, amountCents: 3000 });
        await requestLeaveHousehold(ALICE);

        await expect(recordFamilyReceipt({
            householdId: hh, receiptId: 72006, payer: ALICE, amountCents: 500,
        })).rejects.toMatchObject({ status: 403, code: 'payer-not-eligible' });
        await expectZeroSum(hh);
    });

    it('never re-splits a historical receipt when someone leaves', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 72007, payer: OWNER, amountCents: 1000 });
        const before: any = (await eventsOfType(hh, 'receipt_recorded'))[0];
        const sharesBefore = { ...before.shares };

        await requestLeaveHousehold(ALICE);
        await recordFamilyReceipt({ householdId: hh, receiptId: 72008, payer: OWNER, amountCents: 1000 });

        const after: any = (await eventsOfType(hh, 'receipt_recorded'))[0];
        expect(after.shares).toEqual(sharesBefore);
        await expectZeroSum(hh);
    });

    it('marks "leaving" once — a second request does not overwrite the request time', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 72009, payer: OWNER, amountCents: 3000 });
        await requestLeaveHousehold(ALICE);
        const first = (await getMembership(ALICE))!.leavingRequestedAt;
        await requestLeaveHousehold(ALICE);
        expect((await getMembership(ALICE))!.leavingRequestedAt).toEqual(first);
    });

    it('is visible to everyone on the roster', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 72010, payer: OWNER, amountCents: 3000 });
        await requestLeaveHousehold(ALICE);
        const seenByOwner = await asUser(app, OWNER).get('/api/households/mine');
        expect(seenByOwner.status).toBe(200);
        const alice = seenByOwner.body.members.find((m: any) => m.userId === ALICE);
        expect(alice.leaving).toBe(true);
        expect(seenByOwner.body.members.find((m: any) => m.userId === BOB).leaving).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// §3.2 / §3.2.1 — proposing and confirming
// ---------------------------------------------------------------------------

describe('§3.2.1 both parties must confirm a settlement', () => {
    const setup = async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 73001, payer: OWNER, amountCents: 3000 });
        return hh;
    };

    it('a proposal moves nothing until it is confirmed', async () => {
        const hh = await setup();
        const before = await balanceOf(hh, ALICE);
        const proposal = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000 });
        expect(await balanceOf(hh, ALICE)).toBe(before);
        expect((await state(hh)).pendingSettlements.map(p => p.settlementId)).toEqual([proposal.settlementId]);
        await expectZeroSum(hh);
    });

    it('the PROPOSER cannot confirm their own proposal', async () => {
        const hh = await setup();
        const { settlementId } = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000 });
        await expect(confirmSettlement(ALICE, settlementId))
            .rejects.toMatchObject({ status: 403, code: 'proposer-cannot-confirm' });
        // Nothing moved.
        expect(await balanceOf(hh, ALICE)).toBe(-1000);
        expect(await eventsOfType(hh, 'settlement_confirmed')).toHaveLength(0);
        await expectZeroSum(hh);
    });

    it('the COUNTERPARTY can confirm, and the balance moves exactly then', async () => {
        const hh = await setup();
        const { settlementId } = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000 });
        const result = await confirmSettlement(OWNER, settlementId);
        expect(result.settlementId).toBe(settlementId);
        expect(await balanceOf(hh, ALICE)).toBe(0);
        expect(await balanceOf(hh, OWNER)).toBe(1000);
        await expectZeroSum(hh);
    });

    it('works identically when the CREDITOR proposes and the debtor confirms', async () => {
        const hh = await setup();
        const { settlementId } = await proposeSettlement({ proposer: OWNER, from: ALICE, to: OWNER, amountCents: 1000 });
        await expect(confirmSettlement(OWNER, settlementId))
            .rejects.toMatchObject({ code: 'proposer-cannot-confirm' });
        await confirmSettlement(ALICE, settlementId);
        expect(await balanceOf(hh, ALICE)).toBe(0);
        await expectZeroSum(hh);
    });

    it('a third party may neither propose nor confirm', async () => {
        const hh = await setup();
        await expect(proposeSettlement({ proposer: BOB, from: ALICE, to: OWNER, amountCents: 1000 }))
            .rejects.toMatchObject({ status: 403, code: 'not-a-party' });
        const { settlementId } = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000 });
        await expect(confirmSettlement(BOB, settlementId))
            .rejects.toMatchObject({ status: 403, code: 'not-a-party' });
        await expectZeroSum(hh);
    });

    it('rejects a proposal whose direction or size contradicts the ledger', async () => {
        const hh = await setup();
        // Wrong direction: OWNER is the creditor, so OWNER cannot be `from`.
        await expect(proposeSettlement({ proposer: OWNER, from: OWNER, to: ALICE, amountCents: 500 }))
            .rejects.toMatchObject({ status: 409, code: 'direction-invalid' });
        // Too big: ALICE only owes €10.
        await expect(proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1001 }))
            .rejects.toMatchObject({ status: 409, code: 'amount-exceeds-balance' });
        await expect(proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 0 }))
            .rejects.toMatchObject({ status: 400, code: 'amount-invalid' });
        await expectZeroSum(hh);
    });

    it('confirming twice is rejected and moves the money only once', async () => {
        const hh = await setup();
        const { settlementId } = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000 });
        await confirmSettlement(OWNER, settlementId);
        await expect(confirmSettlement(OWNER, settlementId))
            .rejects.toMatchObject({ status: 409, code: 'already-confirmed' });
        expect(await balanceOf(hh, OWNER)).toBe(1000);
        await expectZeroSum(hh);
    });

    it('completes a pending departure the moment the settlement clears', async () => {
        const hh = await setup();
        await requestLeaveHousehold(ALICE);
        expect(await getMembership(ALICE)).not.toBeNull();

        const { settlementId } = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000 });
        const result = await confirmSettlement(OWNER, settlementId);

        expect(result.departed).toEqual([ALICE]);
        expect(await getMembership(ALICE)).toBeNull();
        expect((await eventsOfType(hh, 'member_left')).map((e: any) => e.member)).toEqual([ALICE]);
        expect((await state(hh)).activeMembers.sort()).toEqual([BOB, OWNER].sort());
        await expectZeroSum(hh);
    });

    it('a PARTIAL settlement does not complete the departure', async () => {
        const hh = await setup();
        await requestLeaveHousehold(ALICE);
        const { settlementId } = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 400 });
        const result = await confirmSettlement(OWNER, settlementId);
        expect(result.departed).toEqual([]);
        expect(await balanceOf(hh, ALICE)).toBe(-600);
        expect(await getMembership(ALICE)).not.toBeNull();
        await expectZeroSum(hh);
    });

    it('lets a leaving member settle — that is the one thing they must be able to do', async () => {
        const hh = await setup();
        await requestLeaveHousehold(ALICE);
        const proposal = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000 });
        expect(proposal.settlementId).toBeTruthy();
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// §3.2 — the "what do I owe / who owes me" read
// ---------------------------------------------------------------------------

describe('§3.2 the settle-and-leave view', () => {
    it('returns the minimal transfers that clear the caller', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        // ALICE owes €7 in total, split across two creditors: BOB pays €12 for
        // three (each owes €4), OWNER pays €9 for three (each owes €3).
        await recordFamilyReceipt({ householdId: hh, receiptId: 74001, payer: BOB, amountCents: 1200 });
        await recordFamilyReceipt({ householdId: hh, receiptId: 74002, payer: OWNER, amountCents: 900 });

        const view = await getHouseholdLedgerView(ALICE);
        expect(view!.balanceCents).toBe(-700);
        const moved = view!.transfers.reduce((s, t) => s + t.amountCents, 0);
        expect(moved).toBe(700);                       // clears EXACTLY (§1.3)
        expect(view!.transfers.every(t => t.from === ALICE)).toBe(true);
        // Largest creditor first — that is what makes the set minimal.
        expect(view!.transfers[0].to).toBe(BOB);
        expect(view!.leaving).toBe(false);
        await expectZeroSum(hh);
    });

    it('shows the reverse direction to a member who is OWED money', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 74003, payer: OWNER, amountCents: 1000 });
        const view = await getHouseholdLedgerView(OWNER);
        expect(view!.balanceCents).toBe(500);
        expect(view!.transfers).toEqual([{ from: ALICE, to: OWNER, amountCents: 500 }]);
        expect(view!.suggestedNextShopper).toBe(ALICE);
    });

    it('is empty for a settled member and null for a non-member', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        expect((await getHouseholdLedgerView(OWNER))!.transfers).toEqual([]);
        expect(await getHouseholdLedgerView(CARL)).toBeNull();
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// §3.2.2 — the 7-day auto-confirm
// ---------------------------------------------------------------------------

describe('§3.2.2 auto-confirm after 7 days of silence', () => {
    /** Propose with a backdated `at`, the way an old unanswered proposal looks. */
    const backdatedProposal = async (hh: number, from: string, to: string, cents: number, by: string, ageDays: number) => {
        const settlementId = `stl-${hh}-${Math.random().toString(36).slice(2, 10)}`;
        await appendSettlementProposed({
            householdId: hh, settlementId, from, to, amountCents: cents, by,
            at: new Date(Date.now() - ageDays * DAY_MS),
        });
        return settlementId;
    };

    it('confirms a proposal older than 7 days and leaves it alone before that', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 75001, payer: OWNER, amountCents: 3000 });
        const young = await backdatedProposal(hh, ALICE, OWNER, 1000, ALICE, 6);

        let result = await sweepLapsedSettlements();
        expect(result.confirmed).toBe(0);
        expect(await balanceOf(hh, ALICE)).toBe(-1000);

        // Same proposal, now 8 days old.
        await q('UPDATE HouseholdLedgerEvent SET at = ? WHERE settlementId = ? AND type = ?',
            [new Date(Date.now() - 8 * DAY_MS), young, 'settlement_proposed']);
        result = await sweepLapsedSettlements();
        expect(result.confirmed).toBe(1);
        expect(await balanceOf(hh, ALICE)).toBe(0);
        await expectZeroSum(hh);
    });

    it('produces the state IDENTICAL to a manual confirm', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 75002, payer: OWNER, amountCents: 3000 });
        const settlementId = await backdatedProposal(hh, ALICE, OWNER, 1000, ALICE, 8);

        // What a MANUAL confirm by the counterparty would fold to, computed
        // from the same log with the manual event appended (pure core).
        const events = await getLedgerEvents(hh);
        const manual = deriveLedgerState([
            ...events,
            { id: 10 ** 9, at: new Date().toISOString(), type: 'settlement_confirmed', settlementId, by: OWNER },
        ]);

        await sweepLapsedSettlements();
        const auto = await state(hh);

        expect(auto.balances).toEqual(manual.balances);
        expect(auto.activeMembers).toEqual(manual.activeMembers);
        expect(auto.pendingSettlements).toEqual(manual.pendingSettlements);
        expect(auto.confirmedSettlementIds).toEqual(manual.confirmedSettlementIds);
        // The LOGS differ — only in `by`, which the fold ignores. That is the
        // whole reason the two end states can be identical.
        const confirmed: any = (await eventsOfType(hh, 'settlement_confirmed'))[0];
        expect(confirmed.by).toBe(AUTO_CONFIRM_ACTOR);
        await expectZeroSum(hh);
    });

    it('two households, one manual and one auto, end with the same balances', async () => {
        const a = await freshHousehold(OWNER, [ALICE, BOB]);
        const b = await freshHousehold(OWNER2, [ALICE2, BOB2]);
        for (const [hh, payer] of [[a, OWNER], [b, OWNER2]] as const) {
            await recordFamilyReceipt({ householdId: hh, receiptId: 75003, payer, amountCents: 3000 });
        }
        const manualId = `stl-manual-${a}`;
        await appendSettlementProposed({
            householdId: a, settlementId: manualId, from: ALICE, to: OWNER, amountCents: 1000, by: ALICE,
        });
        await confirmSettlement(OWNER, manualId);

        await appendSettlementProposed({
            householdId: b, settlementId: `stl-auto-${b}`, from: ALICE2, to: OWNER2, amountCents: 1000, by: ALICE2,
            at: new Date(Date.now() - 8 * DAY_MS),
        });
        await sweepLapsedSettlements();

        const sa = await state(a);
        const sb = await state(b);
        expect([sa.balances[OWNER], sa.balances[ALICE], sa.balances[BOB]])
            .toEqual([sb.balances[OWNER2], sb.balances[ALICE2], sb.balances[BOB2]]);
        await expectZeroSum(a);
        await expectZeroSum(b);
    });

    it('is idempotent, and safe when a manual confirm lands at the same moment', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 75004, payer: OWNER, amountCents: 3000 });
        await requestLeaveHousehold(ALICE);
        const settlementId = await backdatedProposal(hh, ALICE, OWNER, 1000, ALICE, 8);

        // The race: the counterparty taps "confirm" exactly as the sweeper runs.
        const [manual, swept] = await Promise.allSettled([
            confirmSettlement(OWNER, settlementId),
            sweepLapsedSettlements(),
        ]);
        expect([manual.status, swept.status]).not.toContain('rejected');

        // dedupeKey `confirm:<settlementId>` — exactly ONE confirmation row.
        const rows = await q(
            "SELECT COUNT(*) AS n FROM HouseholdLedgerEvent WHERE householdId = ? AND settlementId = ? AND type = 'settlement_confirmed'",
            [hh, settlementId]);
        expect(Number(rows[0].n)).toBe(1);
        // The money moved exactly once...
        expect(await balanceOf(hh, ALICE)).toBe(0);
        expect(await balanceOf(hh, OWNER)).toBe(1000);
        // ...and the departure completed exactly once.
        expect(await getMembership(ALICE)).toBeNull();
        // AT LEAST one — not exactly one. `finalizeDeparture` appends member_left
        // BEFORE the DELETE that gates side effects, deliberately: a duplicate is
        // inert to the fold (householdMembership.ts:323), whereas a missing one
        // would leave a departed member active forever. Under this genuine race
        // both callers can append before either deletes, so asserting exactly one
        // was stricter than the contract and failed ~1 run in 3. What must hold is
        // asserted above and below: the money moved once (dedupeKey guarantees a
        // single settlement_confirmed), the membership is gone, and zero-sum holds.
        expect(
            (await eventsOfType(hh, 'member_left')).filter((e: any) => e.member === ALICE).length,
        ).toBeGreaterThanOrEqual(1);
        await expectZeroSum(hh);

        // A second sweep changes nothing at all.
        const again = await sweepLapsedSettlements();
        expect(again.confirmed).toBe(0);
        await expectZeroSum(hh);
    });

    it('writes member_left when the lapse clears a leaving member', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 75005, payer: OWNER, amountCents: 3000 });
        await requestLeaveHousehold(ALICE);
        await backdatedProposal(hh, ALICE, OWNER, 1000, ALICE, 8);

        const result = await sweepLapsedSettlements();
        expect(result.confirmed).toBe(1);
        expect(result.departed).toEqual([ALICE]);
        expect(await getMembership(ALICE)).toBeNull();
        expect((await state(hh)).activeMembers.sort()).toEqual([BOB, OWNER].sort());
        await expectZeroSum(hh);
    });

    it('reminds the COUNTERPARTY before the lapse, once per stage', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 75006, payer: OWNER, amountCents: 3000 });
        // 5 days old → 2 days of runway → inside the 3-day reminder stage.
        await backdatedProposal(hh, ALICE, OWNER, 1000, ALICE, 5);

        const first = await sweepLapsedSettlements();
        expect(first.reminded).toBe(1);
        expect(first.confirmed).toBe(0);
        // Repeated hourly sweeps must not re-send the same reminder.
        expect((await sweepLapsedSettlements()).reminded).toBe(0);

        // It went to the counterparty (OWNER), NOT to the proposer (ALICE).
        const toOwner = await q(
            "SELECT COUNT(*) AS n FROM Notification WHERE userId = ? AND type = 'household_settlement_reminder'", [OWNER]);
        const toAlice = await q(
            "SELECT COUNT(*) AS n FROM Notification WHERE userId = ? AND type = 'household_settlement_reminder'", [ALICE]);
        expect(Number(toOwner[0].n)).toBe(1);
        expect(Number(toAlice[0].n)).toBe(0);
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// §3.3 — dissolution (and the outstanding-balance case the spec does not cover)
// ---------------------------------------------------------------------------

describe('§3.3 the owner leaving dissolves the household', () => {
    it('dissolves a settled household, taking the shared basket with it', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const outcome = await requestLeaveHousehold(OWNER);
        expect(outcome!.status).toBe('dissolved');
        expect(await getHouseholdMembers(hh)).toHaveLength(0);
        expect(await q('SELECT id FROM Household WHERE id = ?', [hh])).toHaveLength(0);
        expect(await q('SELECT id FROM Basket WHERE householdId = ?', [hh])).toHaveLength(0);
        // The append-only log SURVIVES the household.
        expect((await getLedgerEvents(hh)).length).toBeGreaterThan(0);
        await expectZeroSum(hh);
    });

    it('DEFERS dissolution while ANY balance is outstanding — my call, see householdMembership.ts', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        // ALICE owes BOB. The OWNER is completely square.
        await recordFamilyReceipt({
            householdId: hh, receiptId: 76001, payer: BOB, amountCents: 1000, participants: [ALICE, BOB],
        });
        expect(await balanceOf(hh, OWNER)).toBe(0);

        const outcome = await requestLeaveHousehold(OWNER);
        expect(outcome).toMatchObject({ status: 'leaving', blockedBy: 'household-balances' });
        // The household is STILL THERE, with everyone in it — a live debt is not
        // deleted out from under the people who are owed.
        expect(await q('SELECT id FROM Household WHERE id = ?', [hh])).toHaveLength(1);
        expect(await getHouseholdMembers(hh)).toHaveLength(3);
        expect((await getMembership(OWNER))!.leavingRequestedAt).not.toBeNull();
        await expectZeroSum(hh);
    });

    it('completes the deferred dissolution once the last debt is settled', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({
            householdId: hh, receiptId: 76002, payer: BOB, amountCents: 1000, participants: [ALICE, BOB],
        });
        await requestLeaveHousehold(OWNER);

        const { settlementId } = await proposeSettlement({ proposer: ALICE, from: ALICE, to: BOB, amountCents: 500 });
        const result = await confirmSettlement(BOB, settlementId);

        expect(result.departed.sort()).toEqual([ALICE, BOB, OWNER].sort());
        expect(await q('SELECT id FROM Household WHERE id = ?', [hh])).toHaveLength(0);
        expect(await getMembership(ALICE)).toBeNull();
        // Everyone got a member_left, so the fold's active set is empty.
        expect((await state(hh)).activeMembers).toEqual([]);
        await expectZeroSum(hh);
    });

    it('an owner who is themselves indebted also waits', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 76003, payer: ALICE, amountCents: 1000 });
        const outcome = await requestLeaveHousehold(OWNER);
        expect(outcome).toMatchObject({ status: 'leaving', blockedBy: 'own-balance', balanceCents: -500 });
        expect(await q('SELECT id FROM Household WHERE id = ?', [hh])).toHaveLength(1);
        await expectZeroSum(hh);
    });

    it('the LAST member leaving still takes the household with them', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        await requestLeaveHousehold(ALICE);
        expect(await q('SELECT id FROM Household WHERE id = ?', [hh])).toHaveLength(1);
        await requestLeaveHousehold(OWNER);
        expect(await q('SELECT id FROM Household WHERE id = ?', [hh])).toHaveLength(0);
        expect(await q('SELECT id FROM Basket WHERE householdId = ?', [hh])).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Idempotency of the departure path itself
// ---------------------------------------------------------------------------

describe('departure completion is idempotent', () => {
    it('finalizeDeparture twice removes the member once', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        expect(await finalizeDeparture(hh, ALICE)).toBe(true);
        expect(await finalizeDeparture(hh, ALICE)).toBe(false);
        expect(await getMembership(ALICE)).toBeNull();
        expect((await eventsOfType(hh, 'member_left')).filter((e: any) => e.member === ALICE)).toHaveLength(1);
        await expectZeroSum(hh);
    });

    it('settleDeparturesIfCleared is a no-op when nobody is leaving', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        expect(await settleDeparturesIfCleared(hh)).toEqual([]);
        expect(await getHouseholdMembers(hh)).toHaveLength(2);
    });

    it('settleDeparturesIfCleared does not release a member who still owes', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 77001, payer: OWNER, amountCents: 3000 });
        await requestLeaveHousehold(ALICE);
        expect(await settleDeparturesIfCleared(hh)).toEqual([]);
        expect(await getMembership(ALICE)).not.toBeNull();
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

describe('HTTP: /households/mine/settlements', () => {
    it('204 on a clean leave, 200 + transfers when settlement is owed', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        const clean = await asUser(app, BOB).delete('/api/households/mine/membership');
        expect(clean.status).toBe(204);

        await recordFamilyReceipt({ householdId: hh, receiptId: 78001, payer: OWNER, amountCents: 1000 });
        const blocked = await asUser(app, ALICE).delete('/api/households/mine/membership');
        expect(blocked.status).toBe(200);
        expect(blocked.body.status).toBe('leaving');
        expect(blocked.body.balanceCents).toBe(-500);
        expect(blocked.body.transfers).toEqual([{ from: ALICE, to: OWNER, amountCents: 500 }]);
        await expectZeroSum(hh);
    });

    it('the whole propose → confirm round trip', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        await recordFamilyReceipt({ householdId: hh, receiptId: 78002, payer: OWNER, amountCents: 1000 });

        const view = await asUser(app, ALICE).get('/api/households/mine/settlements');
        expect(view.status).toBe(200);
        expect(view.body.balanceCents).toBe(-500);
        const transfer = view.body.transfers[0];

        // The client posts a transfer object back verbatim.
        const proposed = await asUser(app, ALICE).post('/api/households/mine/settlements').send(transfer);
        expect(proposed.status).toBe(201);
        const { settlementId } = proposed.body;

        const selfConfirm = await asUser(app, ALICE)
            .post(`/api/households/mine/settlements/${settlementId}/confirm`).send({});
        expect(selfConfirm.status).toBe(403);
        expect(selfConfirm.body.error).toBe('proposer-cannot-confirm');

        const confirmed = await asUser(app, OWNER)
            .post(`/api/households/mine/settlements/${settlementId}/confirm`).send({});
        expect(confirmed.status).toBe(200);
        expect(await balanceOf(hh, ALICE)).toBe(0);
        await expectZeroSum(hh);
    });

    it('requires authentication and a household', async () => {
        const anon = await request(app).get('/api/households/mine/settlements');
        expect(anon.status).toBe(401);
        const homeless = await asUser(app, CARL).get('/api/households/mine/settlements');
        expect(homeless.status).toBe(404);
    });

    it('rejects a malformed proposal body', async () => {
        await freshHousehold(OWNER, [ALICE]);
        const bad = await asUser(app, ALICE).post('/api/households/mine/settlements').send({ amountCents: 100 });
        expect(bad.status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// The invariant, over a whole lifecycle
// ---------------------------------------------------------------------------

describe('§1.2 the zero-sum invariant holds across every membership path', () => {
    it('join → shop → leave-request → partial settle → auto-confirm → depart', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        await expectZeroSum(hh);

        await recordFamilyReceipt({ householdId: hh, receiptId: 79001, payer: OWNER, amountCents: 1700 });
        await expectZeroSum(hh);
        await recordFamilyReceipt({ householdId: hh, receiptId: 79002, payer: BOB, amountCents: 1000 });
        await expectZeroSum(hh);

        // A late joiner is absent from everything above (§3.5).
        await joinHousehold(hh, CARL);
        expect(await balanceOf(hh, CARL)).toBe(0);
        await expectZeroSum(hh);

        const aliceOwed = await balanceOf(hh, ALICE);
        await requestLeaveHousehold(ALICE);
        await expectZeroSum(hh);

        // A trip she is not part of leaves her frozen.
        await recordFamilyReceipt({ householdId: hh, receiptId: 79003, payer: CARL, amountCents: 900 });
        expect(await balanceOf(hh, ALICE)).toBe(aliceOwed);
        await expectZeroSum(hh);

        // Settle her out, one transfer at a time, the last one by lapse.
        const view = await getHouseholdLedgerView(ALICE);
        for (const [i, t] of view!.transfers.entries()) {
            const proposal = await proposeSettlement({
                proposer: ALICE, from: t.from, to: t.to, amountCents: t.amountCents,
            });
            if (i === 0) {
                await confirmSettlement(t.to === ALICE ? t.from : t.to, proposal.settlementId);
            } else {
                await q('UPDATE HouseholdLedgerEvent SET at = ? WHERE settlementId = ? AND type = ?',
                    [new Date(Date.now() - 8 * DAY_MS), proposal.settlementId, 'settlement_proposed']);
                await sweepLapsedSettlements();
            }
            await expectZeroSum(hh);
        }

        expect(await balanceOf(hh, ALICE)).toBe(0);
        expect(await getMembership(ALICE)).toBeNull();
        await expectZeroSum(hh);

        // And the departed member is still carried in the fold at zero — dropping
        // her would be the easiest possible way to break the invariant.
        expect((await state(hh)).balances[ALICE]).toBe(0);
    });
});
