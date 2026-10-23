import pool from '../config/db.js';
import { getTripById } from '../models/tripModel.js';
import { getEligibleParticipantIds, getMembership } from '../models/householdModel.js';
import { getReceiptRecordedEvent } from '../models/householdLedgerModel.js';
import { HouseholdActionError, recordFamilyReceipt } from './householdMembership.js';
import type { MemberId, ReceiptRecordedEvent } from './householdLedger.js';

/**
 * FAMILY SHOPPING §7 — "Convert to family shopping" (server half).
 *
 * §7's menu action turns an EXISTING personal trip into a family one. Until
 * this file there was no endpoint for it, so the app shipped the action as
 * device-local AsyncStorage state: the pink "Family items" section appeared,
 * the toggles worked, and nothing whatsoever reached the ledger or any other
 * member — the feature LOOKED like it worked, which is worse than it being
 * absent. This is the real thing.
 *
 * Converting is exactly two statements:
 *   1. `Trip.householdId` is set, which is what every other family read path
 *      already keys on (receiptFamilyScope resolves Receipt.tripId →
 *      Trip.householdId; §4.4's lock, §4.5's member view and §8's deletion gate
 *      all follow from it).
 *   2. Every receipt already on the trip enters the ledger at its FAMILY
 *      SUBTOTAL (§4.3), via `recordFamilyReceipt` — the one door into
 *      `receipt_recorded`, so the §3.2.2 eligibility rule is applied at the
 *      same instant the participant set is captured.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * · It does NOT make a trip family because of the CALLER'S MEMBERSHIP in the
 *   automatic path. `ensureTripForBasket`'s rule — a trip is family because of
 *   the BASKET it grew from — is untouched and must stay untouched: it is what
 *   stops every solo shop by a household member landing in the family ledger.
 *   This is the deliberate, user-initiated exception §7 asks for, and it is the
 *   ONLY place a caller's membership decides a trip's household.
 * · It does NOT add TripMember rows for the other household members. A trip
 *   born from the shared basket does not get them either (`createTrip` seeds
 *   the creator alone); members reach a family trip's receipts through §4.5's
 *   `GET /receipts/:id/family`, which is household-gated, or through a trip
 *   invite. Inventing membership here would diverge from the household-born
 *   trip this is supposed to become indistinguishable from.
 * · It does NOT notify. `receipt_recorded` surfaces in the §5.2 history feed on
 *   its own; §3.4's notification duty is about departures.
 *
 *
 * THE PARTICIPANT SET IS THE HOUSEHOLD AS OF **NOW**, NOT AS OF THE SHOP.
 *
 * This is a real decision, so here is the argument rather than the assertion.
 *
 * · §3.5 settles it almost literally: "A new member starts at balance 0 and
 *   participates only in receipts recorded AFTER member_joined." The verb is
 *   RECORDED, not shopped. A converted receipt is recorded now — this is the
 *   instant it enters the ledger, and before it there was no ledger position
 *   for anyone to be in or out of.
 * · §1.1's "captured at upload time" is the same instant read from the other
 *   end: the moment the receipt reaches the ledger. For an ordinary family
 *   upload the two coincide; conversion is the case where they don't, and §3.5
 *   says which one wins.
 * · The alternative — membership as of the receipt's DATE — would mean
 *   reconstructing a past member set out of `member_joined`/`member_left` and
 *   handing shares to people who have since LEFT. §3.1 lets nobody leave with a
 *   non-zero balance, so a departed member is settled and gone at exactly zero;
 *   giving them a share now would move a balance for someone no longer in the
 *   household to settle it, with no path back to zero. That breaks the very
 *   gate §3.1 exists to hold.
 * · §1.1's "nothing is ever retroactively re-split" cuts the same way: a
 *   historical set would have to be re-derived, and re-derivation is precisely
 *   the mechanism the spec bans.
 * · §3.2.2 then falls out for free. `recordFamilyReceipt` filters the set
 *   through `getEligibleParticipantIds`, so a member who has requested to leave
 *   accrues no share from a conversion either — coherent only if "now" is the
 *   reference instant.
 * · And it matches what the act MEANS. "Convert to family shopping" is a
 *   statement made today, by today's family, that this shop was really theirs.
 *   The people who share it are the people who are in it.
 *
 *
 * CONVERTING IS NOT REVERSIBLE, and there is deliberately no endpoint that
 * undoes it.
 *
 * Un-converting would have to unwind every `receipt_recorded` this wrote. The
 * ledger is append-only (§1.1) and has no delete; the only correction mechanism
 * is `adjustment` (§4.4), which moves balances with an audit trail rather than
 * erasing them — and members may already have SETTLED against those balances,
 * at which point there is nothing left to reverse without inventing a debt.
 * §8 says the same thing about the receipts themselves: once counted, a receipt
 * cannot be deleted, only corrected. An un-convert is that forbidden deletion
 * applied to a whole trip at once.
 *
 * The enforcement is structural, not a flag:
 *   · this module only ever SETS `Trip.householdId`, never clears it, and
 *     nothing else in the codebase writes that column outside trip creation;
 *   · the UPDATE is guarded by `householdId IS NULL`, so a trip that already
 *     has a household — converted or born family — cannot be re-pointed;
 *   · an already-family trip is refused outright (409), so a second convert can
 *     neither move the trip to another household nor re-record anything.
 *
 * The escape hatch a user actually needs is the one the spec already gives
 * them: toggle the items to PERSONAL (§4.1/§4.2). That drains the family
 * subtotal to zero through the sanctioned path, visibly, with the balances
 * moving in the open — the honest version of "actually, this wasn't ours", and
 * reversible in a way that deleting history never is.
 */

export interface TripConversionRecord {
    receiptId: number;
    /** Who paid — the receipt's uploader, never the converter (see below). */
    payer: MemberId;
    /** §4.3 — the FAMILY subtotal now standing against this receipt. */
    amountCents: number;
    /** True when this receipt was already in the ledger and the append deduped. */
    alreadyRecorded: boolean;
}

export interface TripConversionSkip {
    receiptId: number;
    /**
     * The uploader is not an ELIGIBLE member of the converting household —
     * they never joined, they already left, or they are in the §3.2.2 leaving
     * state. There is nobody in this ledger to credit the money to.
     */
    reason: 'payer-not-eligible';
}

export interface TripConversionResult {
    tripId: number;
    householdId: number;
    /**
     * §1.1 — the participant set frozen onto every receipt this conversion
     * recorded. Captured ONCE, before the loop, so a departure landing
     * mid-conversion cannot split one trip across two different sets.
     */
    participants: MemberId[];
    recorded: TripConversionRecord[];
    skipped: TripConversionSkip[];
}

/**
 * §7 — convert a personal trip to a family trip.
 *
 * Authorization, in order (all before any write):
 *   · the trip must exist                        → 404
 *   · the caller must be its OWNER                → 403 (a trip member who did
 *     not create it may not hand someone else's shopping to their own family)
 *   · the trip must not already be a family trip  → 409
 *   · the caller must be a household member       → 403
 *   · ... and not in the §3.2.2 leaving state     → 403 (they are excluded from
 *     new trips the instant they request to leave; a conversion is a new set of
 *     receipts entering the ledger, and `recordFamilyReceipt` would refuse them
 *     as payer anyway — refusing here says so plainly instead of converting the
 *     trip and then recording nothing)
 *
 * IDEMPOTENCE has two independent layers, guarding different things. The
 * `householdId IS NULL` predicate on the UPDATE is the outer one: it makes the
 * state transition happen exactly once. The ledger's `receipt:<id>` dedupe key
 * is the inner one: even if two requests raced past the guard, no receipt can
 * be counted twice — the append returns the ALREADY-STORED event instead of
 * writing a second. Neither is redundant: the first cannot protect receipts
 * attached after the conversion, the second cannot stop a trip changing
 * households.
 */
export const convertTripToFamily = async (
    tripId: number,
    actorUserId: MemberId,
): Promise<TripConversionResult> => {
    const trip = await getTripById(tripId);
    if (!trip) throw new HouseholdActionError(404, 'not-found');
    // "Only their OWN trip" — the creator, not merely a member of it.
    if (trip.createdByUserId !== actorUserId) {
        throw new HouseholdActionError(403, 'not-trip-owner');
    }
    if (trip.householdId != null) {
        throw new HouseholdActionError(409, 'already-family');
    }

    const membership = await getMembership(actorUserId);
    if (!membership) throw new HouseholdActionError(403, 'not-a-household-member');
    if (membership.leavingRequestedAt != null) {
        throw new HouseholdActionError(403, 'member-leaving');
    }
    const householdId = membership.householdId;

    // Write-once (see above): this predicate IS the reversibility policy.
    const [res]: any = await pool.query(
        'UPDATE Trip SET householdId = ? WHERE id = ? AND householdId IS NULL',
        [householdId, tripId],
    );
    if (res.affectedRows === 0) {
        // Lost a race. Re-read: a concurrent duplicate of THIS request is
        // benign (fall through and let the ledger dedupe do its job); anything
        // else is a trip that now belongs to a different household.
        const fresh = await getTripById(tripId);
        if (fresh?.householdId !== householdId) {
            throw new HouseholdActionError(409, 'already-family');
        }
    }

    const participants = await getEligibleParticipantIds(householdId);
    if (participants.length === 0) {
        // Unreachable for a caller who passed the membership gate above, but
        // recording with an empty set would violate §1.3's sum guarantee.
        throw new HouseholdActionError(400, 'no-eligible-participants');
    }

    // Receipts ALREADY on the trip. A user-deleted receipt is excluded for the
    // same reason §4.5 hides it: it is not part of the shopping any more, and
    // counting it would make it retroactively undeletable (§8).
    const [rows]: any = await pool.query(
        `SELECT id, COALESCE(uploaderUserId, userId) AS uploaderId
           FROM Receipt WHERE tripId = ? AND userDeletedAt IS NULL ORDER BY id ASC`,
        [tripId],
    );

    const recorded: TripConversionRecord[] = [];
    const skipped: TripConversionSkip[] = [];
    for (const r of rows as { id: number; uploaderId: string }[]) {
        const receiptId = Number(r.id);
        const payer = String(r.uploaderId);
        /**
         * NEVER FABRICATE A PAYER. A receipt uploaded by someone who is not an
         * eligible member of this household has no payer in this ledger, and
         * attributing it to the CONVERTER would credit them with money they did
         * not spend — the exact inversion spec §2 calls out as v1's bug. The
         * receipt stays on the trip as an ordinary receipt; it is simply not
         * counted, and the response says so rather than swallowing it.
         */
        if (!participants.includes(payer)) {
            skipped.push({ receiptId, reason: 'payer-not-eligible' });
            continue;
        }
        const existing = await getReceiptRecordedEvent(householdId, receiptId);
        /**
         * A zero family subtotal is RECORDED, not skipped. The receipt sits in
         * the ledger at €0.00 and changes no balance — but it gives the receipt
         * a `receipt_recorded` to restate, and without one every later §4.1
         * toggle would find nothing to reconcile against and answer
         * `ledger: 'none'`, silently leaving that money out of the family
         * balance forever. Recording zero is what keeps the toggle live.
         *
         * The amount is DERIVED by `recordFamilyReceipt` from the receipt's
         * FAMILY items (§4.3) and is never passed in — a caller-supplied number
         * here would be the grand total.
         */
        const event = await recordFamilyReceipt({
            householdId, receiptId, payer, participants,
        }) as ReceiptRecordedEvent;
        recorded.push({
            receiptId,
            payer,
            // On a dedupe the append hands back the STORED event, so this is
            // the amount actually standing in the ledger, not a re-derivation.
            amountCents: event.amountCents,
            alreadyRecorded: existing != null,
        });
    }

    return { tripId, householdId, participants, recorded, skipped };
};
