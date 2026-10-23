import pool from '../config/db.js';
import {
    countHouseholdMembers,
    deleteMembershipRow,
    dissolveHousehold,
    getEligibleParticipantIds,
    getHouseholdMembers,
    getLeavingMembers,
    getMembership,
    markMemberLeaving,
} from '../models/householdModel.js';
import {
    appendMemberLeft,
    appendReceiptRecorded,
    getLedgerEvents,
    getLedgerState,
} from '../models/householdLedgerModel.js';
import { computeFamilySubtotalCents } from '../models/receiptItemModel.js';
import { deriveLedgerState, simplifyDebts, suggestNextShopper } from './householdLedger.js';
import type { LedgerEvent, LedgerState, MemberId, Transfer } from './householdLedger.js';
import { notifyUser } from './notificationService.js';

/**
 * FAMILY SHOPPING — MEMBERSHIP (spec §3).
 *
 * The gate this file exists to enforce is §3.1: a member cannot leave or be
 * removed while their balance is non-zero. Everything else here follows from
 * that one rule plus §3.2.2's answer to the hostage problem it creates:
 *
 *   balance zero      → they leave IMMEDIATELY (member_left, membership gone)
 *   balance non-zero  → they enter the "leaving" state: still a member, but
 *                       excluded from new trips from this instant, so their
 *                       balance is FROZEN while settlement runs its course.
 *
 * The departure is then completed by whatever clears the balance — a manual
 * confirm (§3.2.1) or the 7-day auto-confirm (§3.2.2) — both of which call
 * `settleDeparturesIfCleared`. That is why departure is written as a function
 * of the CURRENT ledger state rather than as a step in the leave request: the
 * request and the departure are separated by up to a week and by other people's
 * actions.
 *
 * Nothing in here ever writes a balance. Balances are derived (§1.1); the only
 * thing that moves them is an appended event.
 */

/** Thrown by the service, mapped to a status code by the controller. */
export class HouseholdActionError extends Error {
    constructor(public readonly status: number, public readonly code: string) {
        super(code);
        this.name = 'HouseholdActionError';
    }
}

export type DepartureStatus =
    /** Gone: member_left written, membership row deleted. */
    | 'departed'
    /** §3.2.2 — request accepted, excluded from new trips, waiting on settlement. */
    | 'leaving'
    /** The owner left a fully settled household: it and its shared basket are gone. */
    | 'dissolved';

export interface DepartureOutcome {
    status: DepartureStatus;
    householdId: number;
    member: MemberId;
    /** The departing member's balance at the moment of the request. */
    balanceCents: number;
    /** §3.2 — the minimal set of transfers that clears THEM. Empty when settled. */
    transfers: Transfer[];
    /**
     * Why the departure could not complete, when status is 'leaving':
     *   'own-balance'        — they owe or are owed money.
     *   'household-balances' — THEY are square but the household is not, and
     *                          they are the owner, so leaving would dissolve a
     *                          household that still has live debts (see
     *                          `assertDissolvable` for why that is blocked).
     */
    blockedBy?: 'own-balance' | 'household-balances';
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** §3.2.2 / §9 — fixed, not configurable. */
export const SETTLEMENT_AUTOCONFIRM_MS = 7 * DAY_MS;

// ---------------------------------------------------------------------------
// Display helpers (notification copy only — never used in arithmetic)
// ---------------------------------------------------------------------------

/** Presentation rounding ONLY (§1.3): the stored integer cents stay the truth. */
export const eur = (cents: number): string =>
    `${(Math.abs(cents) / 100).toFixed(2).replace('.', ',')} €`;

/**
 * Display labels for notification bodies. Two single-table queries rather than
 * a JOIN: HouseholdMember.userId and User.id can carry different collations and
 * joining them throws "illegal mix of collations" (same trap as the roster in
 * joinController).
 */
export const getMemberLabels = async (userIds: MemberId[]): Promise<Map<MemberId, string>> => {
    const out = new Map<MemberId, string>();
    const ids = Array.from(new Set(userIds)).filter(Boolean);
    if (ids.length === 0) return out;
    const [rows]: any = await pool.query(
        'SELECT id, displayName, username, firstName FROM User WHERE id IN (?)', [ids]);
    for (const u of rows as any[]) {
        out.set(u.id, u.displayName ?? (u.username ? `@${u.username}` : null) ?? u.firstName ?? 'Narys');
    }
    for (const id of ids) if (!out.has(id)) out.set(id, 'Narys');
    return out;
};

/** Fire-and-forget: a failed doorbell must never roll back a departure. */
const notifySafely = async (userId: MemberId, type: string, payload: Record<string, unknown> & { title: string; body: string }): Promise<void> => {
    try {
        await notifyUser(userId, type, payload);
    } catch (e: any) {
        console.warn(`[household] notify ${type} failed for ${userId}:`, e?.message);
    }
};

// ---------------------------------------------------------------------------
// Ledger reading helpers
// ---------------------------------------------------------------------------

const householdIsSettled = (state: LedgerState): boolean =>
    Object.values(state.balances).every((v) => v === 0);

/**
 * §3.4 — "what was settled with them": the net CONFIRMED settlement between
 * `member` and each counterparty, positive when the member handed money over.
 * Read from the log rather than tracked in a column, like every other number
 * in this subsystem.
 */
export const summariseSettlements = (
    events: LedgerEvent[], member: MemberId,
): Map<MemberId, number> => {
    const proposals = new Map<string, { from: MemberId; to: MemberId; amountCents: number }>();
    const out = new Map<MemberId, number>();
    const seen = new Set<string>();
    for (const ev of events) {
        if (ev.type === 'settlement_proposed') {
            proposals.set(ev.settlementId, { from: ev.from, to: ev.to, amountCents: ev.amountCents });
        } else if (ev.type === 'settlement_confirmed') {
            if (seen.has(ev.settlementId)) continue;
            seen.add(ev.settlementId);
            const p = proposals.get(ev.settlementId);
            if (!p) continue;
            if (p.from === member) out.set(p.to, (out.get(p.to) ?? 0) + p.amountCents);
            else if (p.to === member) out.set(p.from, (out.get(p.from) ?? 0) - p.amountCents);
        }
    }
    return out;
};

const describeTransfers = (transfers: Transfer[], member: MemberId, labels: Map<MemberId, string>): string => {
    if (transfers.length === 0) return 'Atsiskaitymų nėra.';
    return transfers
        .map((t) => t.from === member
            ? `esi skolingas ${labels.get(t.to) ?? 'nariui'} ${eur(t.amountCents)}`
            : `${labels.get(t.from) ?? 'Narys'} skolingas tau ${eur(t.amountCents)}`)
        .join('; ');
};

// ---------------------------------------------------------------------------
// §3.1 + §3.3 — the leave / remove gate
// ---------------------------------------------------------------------------

/**
 * DISSOLVING WITH OUTSTANDING BALANCES — a case the spec does not cover.
 *
 * §3.3 says "the owner leaving = dissolving the household (existing
 * behaviour)", and §3.1 says nobody leaves with a non-zero balance. The two
 * collide when the OWNER is square but two other members are not: dissolving
 * then deletes the household out from under a live debt.
 *
 * MY CALL: dissolution requires the WHOLE household to be settled, not just the
 * departing owner. Reasoning:
 *   · §3.1 exists, in the spec's own words, to stop "one member's debt being
 *     stranded on everyone else". Dissolving with debts outstanding strands
 *     EVERY debt at once and destroys the context that made them legible — a
 *     strictly worse version of the thing §3.1 forbids.
 *   · It would let one person unilaterally void money other people are owed,
 *     which is exactly the unilateral clearing §3.2.1's mutual confirmation was
 *     added to prevent. Consistency with that rule decides it.
 *   · The zero-sum invariant would technically survive (no balance is rewritten)
 *     — which is why this needed a judgement call rather than an assertion. The
 *     damage is to people, not to the arithmetic.
 *   · It is the reversible choice: blocked members can settle and dissolve a
 *     minute later, whereas a wrongly-dissolved household cannot be rebuilt.
 *
 * Rejected alternatives: (a) dissolve anyway and notify everyone of their final
 * balances — honest, but voids others' claims by one person's tap;
 * (b) transfer ownership to the longest-tenured member so the household
 * survives — genuinely attractive, and what most products do, but it invents an
 * ownership-transfer feature the spec does not have and contradicts §3.3's
 * explicit "owner leaving = dissolve".
 *
 * The hostage risk this creates is bounded by the same machinery as §3.2.2: the
 * owner stops accruing shares the instant they request, everyone is told the
 * household dissolves once balances clear, and any proposal auto-confirms after
 * 7 days.
 */
const dissolutionIsBlocked = (state: LedgerState): boolean => !householdIsSettled(state);

/** §3.3 — any member may remove THEMSELVES. */
export const requestLeaveHousehold = async (userId: MemberId): Promise<DepartureOutcome | null> =>
    requestDeparture(userId, userId);

/**
 * §3.3 — the owner may remove ANY member EXCEPT themselves.
 *
 * The self-target check is here rather than in `requestDeparture`, and it is
 * not redundant: an owner removing themselves would otherwise fall through to
 * the self-leave path and DISSOLVE the household — a very different act from
 * "remove a member", triggered from a UI that does not offer it. Preserves the
 * pre-existing `removeMemberFromHousehold` behaviour (null → 404).
 */
export const requestRemoveMember = async (
    ownerUserId: MemberId, memberUserId: MemberId,
): Promise<DepartureOutcome | null> => {
    if (ownerUserId === memberUserId) return null;
    return requestDeparture(ownerUserId, memberUserId);
};

/**
 * The one path into departure. Returns null for "no such membership" so the
 * controller can answer 404 without leaking whether the target exists.
 */
const requestDeparture = async (actor: MemberId, target: MemberId): Promise<DepartureOutcome | null> => {
    const actorRow = await getMembership(actor);
    if (!actorRow) return null;

    if (actor !== target) {
        // Owner-removal. Non-owners cannot remove anyone, and an owner cannot
        // remove themselves through this door (they leave, which dissolves) —
        // both answer 404 rather than 403, matching the existing membership
        // guard's not-found probing.
        if (actorRow.role !== 'owner') return null;
        const targetRow = await getMembership(target);
        if (!targetRow || targetRow.householdId !== actorRow.householdId) return null;
        if (targetRow.role === 'owner') return null;
    }

    const householdId = actorRow.householdId;
    const targetRow = actor === target ? actorRow : (await getMembership(target))!;
    const state = await getLedgerState(householdId);
    const balanceCents = state.balances[target] ?? 0;
    const transfers = balanceCents === 0 ? [] : simplifyDebts(state.balances, target);

    // The owner departing means dissolution (§3.3), which is gated on the whole
    // household being settled, not just on the owner.
    if (targetRow.role === 'owner') {
        if (dissolutionIsBlocked(state)) {
            await enterLeavingState(householdId, target, actor, transfers, balanceCents, true);
            return {
                status: 'leaving', householdId, member: target, balanceCents, transfers,
                blockedBy: balanceCents === 0 ? 'household-balances' : 'own-balance',
            };
        }
        await dissolveNow(householdId, target);
        return { status: 'dissolved', householdId, member: target, balanceCents: 0, transfers: [] };
    }

    if (balanceCents !== 0) {
        await enterLeavingState(householdId, target, actor, transfers, balanceCents, false);
        return { status: 'leaving', householdId, member: target, balanceCents, transfers, blockedBy: 'own-balance' };
    }

    await finalizeDeparture(householdId, target);
    return { status: 'departed', householdId, member: target, balanceCents: 0, transfers: [] };
};

/**
 * §3.2.2 — mark the member as leaving and tell everyone. The membership row
 * SURVIVES; only `leavingRequestedAt` is set, which is enough to exclude them
 * from `getEligibleParticipantIds` and therefore from every future receipt.
 */
const enterLeavingState = async (
    householdId: number,
    member: MemberId,
    by: MemberId,
    transfers: Transfer[],
    balanceCents: number,
    dissolves: boolean,
): Promise<void> => {
    const freshlyMarked = await markMemberLeaving(householdId, member, by);
    if (!freshlyMarked) return; // already leaving — do not re-notify

    const members = await getHouseholdMembers(householdId);
    const labels = await getMemberLabels([...members.map(m => m.userId), member, by]);
    const who = labels.get(member) ?? 'Narys';

    // §3.4 — the leaver is told what they owed and to whom.
    await notifySafely(member, 'household_leaving_pending', {
        title: by === member ? 'Išeini iš šeimos sąrašo' : 'Esi šalinamas iš šeimos sąrašo',
        body: balanceCents === 0
            ? 'Išeisi, kai visi šeimos atsiskaitymai bus užbaigti.'
            : `${describeTransfers(transfers, member, labels)}. Išeisi, kai atsiskaitymas bus patvirtintas.`,
        route: '/(tabs)/basket',
        householdId,
        balanceCents,
        transfers,
    });

    for (const m of members) {
        if (m.userId === member) continue;
        await notifySafely(m.userId, 'household_member_leaving', {
            title: 'Narys išeina',
            body: dissolves
                ? `${who} išeina — šeimos sąrašas bus uždarytas, kai visi atsiskaitymai bus užbaigti.`
                : `${who} išeina iš šeimos sąrašo ir nebedalyvauja naujuose apsipirkimuose.`,
            route: '/(tabs)/basket',
            householdId,
            member,
        });
    }
};

/**
 * Complete a departure: member_left, then the membership row.
 *
 * ORDER MATTERS. The event is appended BEFORE the row is deleted, because the
 * two failure modes are not symmetric: a duplicate `member_left` is inert (the
 * fold just removes an already-removed member from the active set), whereas a
 * missing one would leave a departed member listed as active in every future
 * fold. The DELETE is then the atomic gate for the side effects — only the
 * caller that actually removed the row sends notifications, so a manual confirm
 * racing the auto-confirm sweeper cannot double-notify.
 *
 * Returns false when the member was already gone.
 */
export const finalizeDeparture = async (householdId: number, member: MemberId): Promise<boolean> => {
    const membersBefore = await getHouseholdMembers(householdId);
    if (!membersBefore.some(m => m.userId === member)) return false;

    const events = await getLedgerEvents(householdId);
    await appendMemberLeft({ householdId, member });

    const removed = await deleteMembershipRow(householdId, member);
    if (!removed) return false;

    const settled = summariseSettlements(events, member);
    const labels = await getMemberLabels([...membersBefore.map(m => m.userId), member]);
    const who = labels.get(member) ?? 'Narys';

    // §3.4 — the leaver is told what they owed and to whom.
    const leaverLines = Array.from(settled.entries())
        .filter(([, cents]) => cents !== 0)
        .map(([other, cents]) => cents > 0
            ? `sumokėjai ${labels.get(other) ?? 'nariui'} ${eur(cents)}`
            : `gavai iš ${labels.get(other) ?? 'nario'} ${eur(cents)}`);
    await notifySafely(member, 'household_left', {
        title: 'Išėjai iš šeimos sąrašo',
        body: leaverLines.length ? `Atsiskaityta: ${leaverLines.join('; ')}.` : 'Visi atsiskaitymai užbaigti.',
        route: '/(tabs)/basket',
        householdId,
    });

    // §3.4 — every remaining member hears who left and what was settled with them.
    for (const m of membersBefore) {
        if (m.userId === member) continue;
        const net = settled.get(m.userId) ?? 0;
        await notifySafely(m.userId, 'household_member_left', {
            title: 'Narys išėjo',
            body: net === 0
                ? `${who} išėjo iš šeimos sąrašo. Tarpusavio atsiskaitymų nebuvo.`
                : net > 0
                    ? `${who} išėjo iš šeimos sąrašo. Atsiskaitė tau ${eur(net)}.`
                    : `${who} išėjo iš šeimos sąrašo. Atsiskaitei jam ${eur(net)}.`,
            route: '/(tabs)/basket',
            householdId,
            member,
            settledCents: net,
        });
    }

    // Existing behaviour: the LAST member leaving takes the household and its
    // shared basket with it.
    if ((await countHouseholdMembers(householdId)) === 0) {
        await dissolveHousehold(householdId);
    }
    return true;
};

/**
 * The owner departs a fully settled household (§3.3). Every remaining member
 * gets a `member_left` so the fold's active set empties, then the household,
 * its shared basket and every membership go. The ledger log is kept.
 */
const dissolveNow = async (householdId: number, by: MemberId): Promise<void> => {
    const members = await getHouseholdMembers(householdId);
    const labels = await getMemberLabels([...members.map(m => m.userId), by]);
    for (const m of members) await appendMemberLeft({ householdId, member: m.userId });
    await dissolveHousehold(householdId);
    for (const m of members) {
        await notifySafely(m.userId, m.userId === by ? 'household_left' : 'household_dissolved', {
            title: 'Šeimos sąrašas uždarytas',
            body: m.userId === by
                ? 'Uždarei šeimos sąrašą. Visi atsiskaitymai buvo užbaigti.'
                : `${labels.get(by) ?? 'Savininkas'} uždarė šeimos sąrašą. Visi atsiskaitymai užbaigti.`,
            route: '/(tabs)/basket',
            householdId,
        });
    }
};

/**
 * Called after ANYTHING that may have moved a balance to zero — a manual
 * confirm (§3.2.1) or the 7-day auto-confirm (§3.2.2). Completes whatever
 * departures are now unblocked.
 *
 * Idempotent and safe to run concurrently: each departure is gated on the
 * DELETE of its membership row, and dissolution is gated on the household still
 * existing. Running it when nothing changed is a no-op.
 */
export const settleDeparturesIfCleared = async (householdId: number): Promise<MemberId[]> => {
    const leaving = await getLeavingMembers(householdId);
    if (leaving.length === 0) return [];
    const state = await getLedgerState(householdId);

    // An owner in the leaving state means a DEFERRED DISSOLUTION: the moment the
    // whole household is square, it closes (see `dissolutionIsBlocked`).
    const owner = leaving.find(m => m.role === 'owner');
    if (owner && householdIsSettled(state)) {
        const members = await getHouseholdMembers(householdId);
        await dissolveNow(householdId, owner.userId);
        return members.map(m => m.userId);
    }

    const departed: MemberId[] = [];
    for (const m of leaving) {
        if (m.role === 'owner') continue; // waits for the whole household
        if ((state.balances[m.userId] ?? 0) !== 0) continue;
        if (await finalizeDeparture(householdId, m.userId)) departed.push(m.userId);
    }
    return departed;
};

// ---------------------------------------------------------------------------
// §3.2.2 — the leaving member is excluded from new trips IMMEDIATELY
// ---------------------------------------------------------------------------

/**
 * Record a family receipt into the ledger (§1.1 / §4.3), with the §3.2.2
 * participant gate applied.
 *
 * This is the ONLY place a `receipt_recorded` should be written from, precisely
 * because the eligibility rule has to be applied at the same instant the
 * participant set is captured. A member in the leaving state:
 *   · cannot be the payer — they cannot upload family receipts at all;
 *   · is silently dropped from `participants`, so they accrue NO share.
 * Their balance is therefore frozen from the moment they request to leave, and
 * an unresponsive counterparty cannot inflate what they owe while they wait.
 *
 * §4.3 — THE AMOUNT IS THE FAMILY SUBTOTAL, DERIVED, NOT PASSED IN.
 * `amountCents` used to be a required argument, i.e. whatever the caller handed
 * over — which for the real upload path would have been the receipt GRAND
 * TOTAL. It now defaults to `computeFamilySubtotalCents(receiptId)`: the sum of
 * the receipt's FAMILY-scoped ReceiptItem rows and nothing else, so personal
 * items cannot reach a balance. The explicit argument survives only as an
 * override for tests and backfills that have no ReceiptItem rows to sum; no
 * production caller passes it.
 */
export const recordFamilyReceipt = async (args: {
    householdId: number;
    receiptId: number;
    payer: MemberId;
    /** OVERRIDE ONLY. Omit it — the family subtotal is derived from the items. */
    amountCents?: number;
    /** Defaults to every eligible member. Ineligible ids are filtered out. */
    participants?: MemberId[];
    at?: Date;
}): Promise<LedgerEvent> => {
    const amountCents = args.amountCents ?? await computeFamilySubtotalCents(args.receiptId);
    const eligible = await getEligibleParticipantIds(args.householdId);
    if (!eligible.includes(args.payer)) {
        throw new HouseholdActionError(403, 'payer-not-eligible');
    }
    const requested = args.participants ?? eligible;
    const participants = requested.filter(p => eligible.includes(p));
    if (participants.length === 0) {
        throw new HouseholdActionError(400, 'no-eligible-participants');
    }
    return appendReceiptRecorded({
        householdId: args.householdId,
        receiptId: args.receiptId,
        payer: args.payer,
        amountCents,
        participants,
        at: args.at,
    });
};

// ---------------------------------------------------------------------------
// The "what do I owe / who owes me" read (§3.2)
// ---------------------------------------------------------------------------

export interface HouseholdLedgerView {
    householdId: number;
    /** The caller's balance. POSITIVE = is owed, NEGATIVE = owes (§1.2). */
    balanceCents: number;
    /** §3.2 — the minimal set of transfers that clears the CALLER. */
    transfers: Transfer[];
    balances: Record<MemberId, number>;
    pendingSettlements: LedgerState['pendingSettlements'];
    suggestedNextShopper: MemberId | null;
    members: { userId: MemberId; role: string; leaving: boolean }[];
    /** True once the caller has requested to leave (§3.2.2). */
    leaving: boolean;
}

export const getHouseholdLedgerView = async (userId: MemberId): Promise<HouseholdLedgerView | null> => {
    const membership = await getMembership(userId);
    if (!membership) return null;
    const householdId = membership.householdId;
    const state = deriveLedgerState(await getLedgerEvents(householdId));
    const members = await getHouseholdMembers(householdId);
    const balanceCents = state.balances[userId] ?? 0;
    return {
        householdId,
        balanceCents,
        transfers: balanceCents === 0 ? [] : simplifyDebts(state.balances, userId),
        balances: state.balances,
        pendingSettlements: state.pendingSettlements,
        suggestedNextShopper: suggestNextShopper(state),
        members: members.map(m => ({
            userId: m.userId,
            role: m.role,
            leaving: m.leavingRequestedAt != null,
        })),
        leaving: membership.leavingRequestedAt != null,
    };
};
