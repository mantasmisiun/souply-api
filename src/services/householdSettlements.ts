import { randomUUID } from 'crypto';
import pool from '../config/db.js';
import { getHouseholdMembers, getMembership } from '../models/householdModel.js';
import {
    appendSettlementConfirmed,
    appendSettlementProposed,
    getLedgerState,
    getPendingProposals,
} from '../models/householdLedgerModel.js';
import type { PendingProposal } from '../models/householdLedgerModel.js';
import { AUTO_CONFIRM_ACTOR } from './householdLedger.js';
import type { MemberId, PendingSettlement } from './householdLedger.js';
import {
    eur,
    getMemberLabels,
    HouseholdActionError,
    SETTLEMENT_AUTOCONFIRM_MS,
    settleDeparturesIfCleared,
} from './householdMembership.js';
import { notifyUser } from './notificationService.js';

/**
 * FAMILY SHOPPING — SETTLEMENTS (spec §3.2, §3.2.1, §3.2.2).
 *
 * The app never moves money. A settlement is an honour-system receipt of
 * payment, and §3.2.1's whole point is that it takes TWO people to assert it:
 *   propose  → writes settlement_proposed. Inert; moves nothing (§1.2).
 *   confirm  → writes settlement_confirmed, and ONLY the counterparty may.
 * If the proposer could confirm their own proposal the mutual-confirmation rule
 * would be decorative — so that check is the load-bearing line in this file.
 *
 * §3.2.2 then stops mutual confirmation becoming a trap: silence for 7 days
 * auto-confirms, which is why `sweepLapsedSettlements` exists.
 *
 * A member in the "leaving" state is deliberately still allowed to propose and
 * confirm. Settling is the one thing they must be able to do — it is what lets
 * them out.
 */

/** §3.2.2 / §9 — reminders at 3 days and 1 day of runway, once each. */
const REMINDER_STAGES: { key: string; withinMs: number }[] = [
    { key: 'final', withinMs: 1 * 24 * 60 * 60 * 1000 },
    { key: 'early', withinMs: 3 * 24 * 60 * 60 * 1000 },
];
const REMINDER_TYPE = 'household_settlement_reminder';

const notifySafely = async (userId: MemberId, type: string, payload: Record<string, unknown> & { title: string; body: string }): Promise<void> => {
    try {
        await notifyUser(userId, type, payload);
    } catch (e: any) {
        console.warn(`[household] notify ${type} failed for ${userId}:`, e?.message);
    }
};

// ---------------------------------------------------------------------------
// §3.2 Propose
// ---------------------------------------------------------------------------

export interface ProposeArgs {
    proposer: MemberId;
    /** Hands the money over — must be the member with the NEGATIVE balance. */
    from: MemberId;
    /** Receives it — must be the member with the POSITIVE balance. */
    to: MemberId;
    amountCents: number;
}

export const proposeSettlement = async (args: ProposeArgs): Promise<PendingSettlement> => {
    const membership = await getMembership(args.proposer);
    if (!membership) throw new HouseholdActionError(404, 'not-found');
    const householdId = membership.householdId;

    if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) {
        throw new HouseholdActionError(400, 'amount-invalid');
    }
    if (args.from === args.to) throw new HouseholdActionError(400, 'same-party');
    // §3.2.1 — "only the two parties involved may propose".
    if (args.proposer !== args.from && args.proposer !== args.to) {
        throw new HouseholdActionError(403, 'not-a-party');
    }

    const members = await getHouseholdMembers(householdId);
    const ids = new Set(members.map(m => m.userId));
    if (!ids.has(args.from) || !ids.has(args.to)) throw new HouseholdActionError(404, 'not-found');

    // Direction and size must match the ledger. Without this a proposal could
    // push a settled member into debt — and since a confirm moves money without
    // re-deriving anything, a nonsense proposal would become a real balance.
    const state = await getLedgerState(householdId);
    const fromBalance = state.balances[args.from] ?? 0;
    const toBalance = state.balances[args.to] ?? 0;
    if (fromBalance >= 0 || toBalance <= 0) throw new HouseholdActionError(409, 'direction-invalid');
    if (args.amountCents > Math.min(-fromBalance, toBalance)) {
        throw new HouseholdActionError(409, 'amount-exceeds-balance');
    }

    const settlementId = randomUUID();
    await appendSettlementProposed({
        householdId, settlementId, from: args.from, to: args.to,
        amountCents: args.amountCents, by: args.proposer,
    });

    // §3.2.1 — the COUNTERPARTY is the one who has to act.
    const counterparty = args.proposer === args.from ? args.to : args.from;
    const labels = await getMemberLabels([args.from, args.to]);
    await notifySafely(counterparty, 'household_settlement_proposed', {
        title: 'Patvirtink atsiskaitymą',
        body: args.proposer === args.from
            ? `${labels.get(args.from)} nurodė, kad tau atidavė ${eur(args.amountCents)}. Patvirtink.`
            : `${labels.get(args.to)} nurodė, kad iš tavęs gavo ${eur(args.amountCents)}. Patvirtink.`,
        route: '/(tabs)/basket',
        householdId,
        settlementId,
        amountCents: args.amountCents,
    });

    return {
        settlementId, from: args.from, to: args.to,
        amountCents: args.amountCents, by: args.proposer, proposedAt: new Date().toISOString(),
    };
};

// ---------------------------------------------------------------------------
// §3.2.1 Confirm — COUNTERPARTY ONLY
// ---------------------------------------------------------------------------

export const confirmSettlement = async (actor: MemberId, settlementId: string): Promise<{
    settlementId: string; householdId: number; departed: MemberId[];
}> => {
    const membership = await getMembership(actor);
    if (!membership) throw new HouseholdActionError(404, 'not-found');
    const householdId = membership.householdId;

    const state = await getLedgerState(householdId);
    const proposal = state.pendingSettlements.find(p => p.settlementId === settlementId);
    if (!proposal) {
        if (state.confirmedSettlementIds.includes(settlementId)) {
            throw new HouseholdActionError(409, 'already-confirmed');
        }
        throw new HouseholdActionError(404, 'not-found');
    }
    if (actor !== proposal.from && actor !== proposal.to) {
        throw new HouseholdActionError(403, 'not-a-party');
    }
    // THE rule of §3.2.1: one member cannot clear their own debt unilaterally.
    if (actor === proposal.by) throw new HouseholdActionError(403, 'proposer-cannot-confirm');

    await appendSettlementConfirmed({ householdId, settlementId, by: actor });
    await announceConfirmed(householdId, proposal, actor);
    const departed = await settleDeparturesIfCleared(householdId);
    return { settlementId, householdId, departed };
};

const announceConfirmed = async (
    householdId: number,
    proposal: { from: MemberId; to: MemberId; amountCents: number },
    by: MemberId,
): Promise<void> => {
    const labels = await getMemberLabels([proposal.from, proposal.to]);
    const auto = by === AUTO_CONFIRM_ACTOR;
    for (const party of [proposal.from, proposal.to]) {
        const other = party === proposal.from ? proposal.to : proposal.from;
        await notifySafely(party, 'household_settlement_confirmed', {
            title: auto ? 'Atsiskaitymas patvirtintas automatiškai' : 'Atsiskaitymas patvirtintas',
            body: `${eur(proposal.amountCents)} su ${labels.get(other) ?? 'nariu'}${auto ? ' — po 7 dienų be atsakymo' : ''}.`,
            route: '/(tabs)/basket',
            householdId,
            amountCents: proposal.amountCents,
            auto,
        });
    }
};

// ---------------------------------------------------------------------------
// §3.2.2 The 7-day auto-confirm sweep
// ---------------------------------------------------------------------------

/**
 * Has this exact reminder already gone out? Read off the Notification inbox
 * rather than a new column: the inbox is already the durable record of what was
 * sent, and a `remindedAt` column would be a second source of truth that can
 * disagree with it. One indexed-by-user lookup per pending proposal, and there
 * are only ever a handful of those in flight.
 */
const reminderAlreadySent = async (userId: MemberId, settlementId: string, stage: string): Promise<boolean> => {
    const [rows]: any = await pool.query(
        `SELECT 1 FROM Notification
          WHERE userId = ? AND type = ?
            AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.settlementId')) = ?
            AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.stage')) = ?
          LIMIT 1`,
        [userId, REMINDER_TYPE, settlementId, stage],
    );
    return rows.length > 0;
};

const sendReminder = async (p: PendingProposal, stage: string, remainingMs: number): Promise<boolean> => {
    // The counterparty is whoever did NOT propose — they are the one whose
    // silence would otherwise lapse into an auto-confirm.
    const counterparty = p.by === p.from ? p.to : p.from;
    if (await reminderAlreadySent(counterparty, p.settlementId, stage)) return false;
    const labels = await getMemberLabels([p.from, p.to]);
    const other = counterparty === p.from ? p.to : p.from;
    const days = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
    await notifySafely(counterparty, REMINDER_TYPE, {
        title: 'Nepatvirtintas atsiskaitymas',
        body: `${eur(p.amountCents)} su ${labels.get(other) ?? 'nariu'} laukia patvirtinimo. `
            + `Po ${days} d. bus patvirtinta automatiškai.`,
        route: '/(tabs)/basket',
        householdId: p.householdId,
        settlementId: p.settlementId,
        stage,
        amountCents: p.amountCents,
    });
    return true;
};

export interface SweepResult {
    confirmed: number;
    reminded: number;
    departed: MemberId[];
}

/**
 * §3.2.2 — auto-confirm every proposal that has sat unanswered for 7 days, and
 * remind the counterparty before that happens, so silence is a choice rather
 * than a trap. Writes `member_left` at the same moment if the settlement was
 * what a leaving member was waiting on.
 *
 * IDEMPOTENT AND CONCURRENCY-SAFE, by construction rather than by locking:
 *   · The confirm carries dedupeKey `confirm:<settlementId>`, so a manual
 *     confirm landing in the same second makes the auto-confirm a no-op that
 *     returns the already-stored event (householdLedgerModel.append).
 *   · The fold ignores `settlement_confirmed.by` entirely, so an auto-confirm
 *     and a manual confirm produce the IDENTICAL state — there is no "which one
 *     won" to reconcile.
 *   · Departure completion is gated on the DELETE of the membership row, so
 *     only one caller ever notifies.
 * Running it twice, or alongside a user, changes nothing.
 */
export const sweepLapsedSettlements = async (now: Date = new Date()): Promise<SweepResult> => {
    // Only proposals already inside the reminder window are of any interest.
    const windowStart = new Date(now.getTime() - (SETTLEMENT_AUTOCONFIRM_MS - REMINDER_STAGES[1].withinMs));
    const pending = await getPendingProposals(windowStart);

    let confirmed = 0;
    let reminded = 0;
    const touched = new Set<number>();

    for (const p of pending) {
        const ageMs = now.getTime() - new Date(p.proposedAt).getTime();
        const remainingMs = SETTLEMENT_AUTOCONFIRM_MS - ageMs;
        if (remainingMs <= 0) {
            await appendSettlementConfirmed({
                householdId: p.householdId, settlementId: p.settlementId, by: AUTO_CONFIRM_ACTOR, at: now,
            });
            await announceConfirmed(p.householdId, p, AUTO_CONFIRM_ACTOR);
            confirmed++;
            touched.add(p.householdId);
            continue;
        }
        const stage = REMINDER_STAGES.find(s => remainingMs <= s.withinMs);
        if (stage && await sendReminder(p, stage.key, remainingMs)) reminded++;
    }

    const departed: MemberId[] = [];
    for (const householdId of touched) {
        departed.push(...await settleDeparturesIfCleared(householdId));
    }
    return { confirmed, reminded, departed };
};
