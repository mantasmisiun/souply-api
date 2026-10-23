/**
 * FAMILY SHOPPING LEDGER — the pure core (spec §1 + §3.2).
 *
 * Zero imports, zero I/O, zero clock: every function here is a pure function of
 * its arguments, so the whole money model is unit-testable without a database.
 * The DB half lives in models/householdLedgerModel.ts and does nothing but
 * append rows and hand them back to `deriveLedgerState`.
 *
 * Three rules this file exists to enforce:
 *   1. ALL money is INTEGER CENTS. There is not a single float in here, and
 *      `assertCents` rejects anything that isn't a safe integer at every entry
 *      point — a float that reaches the log poisons every future balance.
 *   2. Shares are computed ONCE, at receipt time, and STORED (§1.3). Nothing
 *      downstream re-divides; the fold only ever adds and subtracts stored
 *      integers, so the zero-sum invariant holds BY CONSTRUCTION.
 *   3. Violations THROW (LedgerError). They are never logged and swallowed:
 *      a ledger that quietly keeps going is a ledger that silently loses money.
 */

export type MemberId = string;

/** Every failure in this module. Thrown, never returned. */
export class LedgerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LedgerError';
    }
}

// ---------------------------------------------------------------------------
// Events (§1.1)
// ---------------------------------------------------------------------------

interface EventBase {
    /** Monotonic log id — the total order. */
    id: number;
    /** Server timestamp, ISO string. */
    at: string;
}

export type ReceiptRecordedEvent = EventBase & {
    type: 'receipt_recorded';
    receiptId: number;
    payer: MemberId;
    /** The FAMILY subtotal (§4.3), not the receipt grand total. */
    amountCents: number;
    /** Materialised at receipt time; sums to amountCents. NEVER re-divided. */
    shares: Record<MemberId, number>;
};

export type MemberJoinedEvent = EventBase & { type: 'member_joined'; member: MemberId };
export type MemberLeftEvent = EventBase & { type: 'member_left'; member: MemberId };

export type SettlementProposedEvent = EventBase & {
    type: 'settlement_proposed';
    settlementId: string;
    /** Hands money over (the one who owed). */
    from: MemberId;
    /** Receives money (the one who was owed). */
    to: MemberId;
    amountCents: number;
    by: MemberId;
};

export type SettlementConfirmedEvent = EventBase & {
    type: 'settlement_confirmed';
    settlementId: string;
    /** The counterparty, or `AUTO_CONFIRM_ACTOR` for the 7-day lapse (§3.2.2). */
    by: MemberId;
};

export type AdjustmentEvent = EventBase & {
    type: 'adjustment';
    receiptId: number;
    reason: string;
    /** Must sum to EXACTLY zero — an adjustment redistributes, never creates. */
    deltaByMember: Record<MemberId, number>;
};

export type LedgerEvent =
    | ReceiptRecordedEvent
    | MemberJoinedEvent
    | MemberLeftEvent
    | SettlementProposedEvent
    | SettlementConfirmedEvent
    | AdjustmentEvent;

export type LedgerEventType = LedgerEvent['type'];

/**
 * `by` on a settlement_confirmed written by the 7-day auto-confirm job
 * (§3.2.2, phase 2). The fold IGNORES `by` entirely, so an auto-confirm and a
 * manual confirm produce byte-identical balances — that equivalence is what
 * makes the job safe to add later.
 */
export const AUTO_CONFIRM_ACTOR = 'system:auto-confirm';

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const assertCents = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isSafeInteger(v)) {
        throw new LedgerError(`${what} must be an integer number of cents, got ${JSON.stringify(v)}`);
    }
    return v;
};

const assertMemberId = (v: unknown, what: string): MemberId => {
    if (typeof v !== 'string' || v.length === 0) {
        throw new LedgerError(`${what} must be a non-empty member id, got ${JSON.stringify(v)}`);
    }
    return v;
};

/** Codepoint order — stable and locale-independent, unlike localeCompare. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sumValues = (rec: Record<string, number>): number => {
    let total = 0;
    for (const k of Object.keys(rec)) total += rec[k];
    return total;
};

// ---------------------------------------------------------------------------
// §1.3 Share computation — MATERIALISE, don't re-divide
// ---------------------------------------------------------------------------

/**
 * Split `amountCents` across `participants`, integer cents only.
 *
 *   base = floor(amountCents / n),  r = amountCents mod n
 *
 * Participants are ordered by member id; the rotation starts at offset
 * `receiptId mod n` and the next `r` members each get ONE extra cent. Fully
 * deterministic (replayable from the log alone) but not biased: unlike v1's
 * "remainder to the payer", the extra cent lands on a different member as the
 * receipt id advances, so the frequent shopper does not absorb it every time.
 *
 * Throws unless `sum(result) === amountCents`. This is THE write-time assertion
 * required by §1.3 — callers cannot opt out of it, because the only way to get
 * shares is to call this function.
 */
export const computeShares = (
    receiptId: number,
    amountCents: number,
    participants: MemberId[],
): Record<MemberId, number> => {
    if (!Number.isInteger(receiptId) || receiptId < 0) {
        throw new LedgerError(`receiptId must be a non-negative integer, got ${JSON.stringify(receiptId)}`);
    }
    assertCents(amountCents, 'amountCents');
    // A receipt total is never negative. Corrections go through `adjustment`
    // (§4.4/§8), which is the ONLY event allowed to move money backwards —
    // receipts are never deleted or negated.
    if (amountCents < 0) throw new LedgerError(`amountCents must be >= 0, got ${amountCents}`);
    if (!Array.isArray(participants)) throw new LedgerError('participants must be an array');

    const ordered = Array.from(new Set(participants.map((p, i) => assertMemberId(p, `participants[${i}]`)))).sort(byId);
    const n = ordered.length;
    if (n === 0) throw new LedgerError('a receipt needs at least one participant');

    const base = Math.floor(amountCents / n);
    const r = amountCents % n;
    const offset = receiptId % n;

    const shares: Record<MemberId, number> = {};
    for (const m of ordered) shares[m] = base;
    for (let k = 0; k < r; k++) shares[ordered[(offset + k) % n]] += 1;

    assertSharesSum(amountCents, shares);
    return shares;
};

/**
 * §1.3's guarantee, as an assertion: `sum(shares.values) === amountCents`.
 * Exported so the model re-checks it immediately before the INSERT — the
 * invariant is asserted on the bytes that actually hit the table, not merely on
 * the bytes computeShares returned.
 */
export const assertSharesSum = (amountCents: number, shares: Record<MemberId, number>): void => {
    assertCents(amountCents, 'amountCents');
    let total = 0;
    for (const m of Object.keys(shares)) {
        total += assertCents(shares[m], `shares[${m}]`);
    }
    if (total !== amountCents) {
        throw new LedgerError(
            `share split does not add up: sum(shares)=${total} but amountCents=${amountCents} ` +
            `(${JSON.stringify(shares)})`,
        );
    }
};

/** An adjustment redistributes; it never creates or destroys money. */
export const assertDeltaSumsToZero = (deltaByMember: Record<MemberId, number>): void => {
    let total = 0;
    for (const m of Object.keys(deltaByMember)) {
        total += assertCents(deltaByMember[m], `deltaByMember[${m}]`);
    }
    if (total !== 0) {
        throw new LedgerError(
            `adjustment deltas must sum to zero, got ${total} (${JSON.stringify(deltaByMember)})`,
        );
    }
};

// ---------------------------------------------------------------------------
// §1.2 Balance derivation — the fold
// ---------------------------------------------------------------------------

export interface PendingSettlement {
    settlementId: string;
    from: MemberId;
    to: MemberId;
    amountCents: number;
    by: MemberId;
    proposedAt: string;
}

export interface LedgerState {
    /**
     * POSITIVE = has overpaid, is OWED money. NEGATIVE = owes.
     * Contains EVERY member the log has ever touched, including departed ones
     * (always at 0 — §3.1 blocks leaving otherwise). Dropping them would be the
     * easiest way to break the zero-sum invariant, so we never do.
     */
    balances: Record<MemberId, number>;
    /** Joined and not since left, ordered by id. */
    activeMembers: MemberId[];
    /** Proposed but not yet confirmed. Display state ONLY — moves no money. */
    pendingSettlements: PendingSettlement[];
    confirmedSettlementIds: string[];
}

/**
 * Fold the log into balances (§1.2).
 *
 *   receipt      payer += amountCents; every participant -= shares[member]
 *                (algebraically identical to the spec's
 *                 `payer += amountCents - shares[payer]`, and it also handles a
 *                 payer who is not himself a participant)
 *   settlement   moves money ONLY on settlement_confirmed: from += , to -=
 *                A proposed-but-unconfirmed settlement is inert display state.
 *   adjustment   applies deltaByMember, which must sum to zero.
 *
 * `events` must already be in log order. The fold re-asserts the zero-sum
 * invariant at the end and throws if it fails — at that point the stored log
 * itself is corrupt, and continuing would serve wrong numbers to real people.
 */
export const deriveLedgerState = (events: LedgerEvent[]): LedgerState => {
    const balances: Record<MemberId, number> = {};
    const active = new Set<MemberId>();
    const proposals = new Map<string, PendingSettlement>();
    const confirmed = new Set<string>();

    const touch = (m: MemberId): void => {
        if (!(m in balances)) balances[m] = 0;
    };

    for (const ev of events) {
        switch (ev.type) {
            case 'member_joined': {
                // §3.5 — a joiner starts at 0 and is never retroactively added to
                // a past receipt: the fold has already consumed those events and
                // each one carries its OWN participant set.
                touch(assertMemberId(ev.member, 'member_joined.member'));
                active.add(ev.member);
                break;
            }
            case 'member_left': {
                touch(assertMemberId(ev.member, 'member_left.member'));
                active.delete(ev.member);
                break;
            }
            case 'receipt_recorded': {
                assertMemberId(ev.payer, 'receipt_recorded.payer');
                // Re-assert on READ too: if a bad row ever reached the table, this
                // is where it stops, rather than silently skewing every balance.
                assertSharesSum(ev.amountCents, ev.shares);
                touch(ev.payer);
                balances[ev.payer] += ev.amountCents;
                for (const m of Object.keys(ev.shares)) {
                    touch(m);
                    balances[m] -= ev.shares[m];
                }
                break;
            }
            case 'settlement_proposed': {
                assertMemberId(ev.from, 'settlement_proposed.from');
                assertMemberId(ev.to, 'settlement_proposed.to');
                assertCents(ev.amountCents, 'settlement_proposed.amountCents');
                touch(ev.from);
                touch(ev.to);
                // Deliberately NO balance change (§1.2). Display state only.
                proposals.set(ev.settlementId, {
                    settlementId: ev.settlementId,
                    from: ev.from,
                    to: ev.to,
                    amountCents: ev.amountCents,
                    by: ev.by,
                    proposedAt: ev.at,
                });
                break;
            }
            case 'settlement_confirmed': {
                if (confirmed.has(ev.settlementId)) break; // already applied — idempotent
                const p = proposals.get(ev.settlementId);
                if (!p) {
                    throw new LedgerError(
                        `settlement_confirmed ${ev.settlementId} has no matching settlement_proposed`,
                    );
                }
                // `by` is intentionally unused: a manual confirm and the 7-day
                // auto-confirm must land on the identical state.
                touch(p.from);
                touch(p.to);
                balances[p.from] += p.amountCents;
                balances[p.to] -= p.amountCents;
                confirmed.add(ev.settlementId);
                break;
            }
            case 'adjustment': {
                assertDeltaSumsToZero(ev.deltaByMember);
                for (const m of Object.keys(ev.deltaByMember)) {
                    touch(m);
                    balances[m] += ev.deltaByMember[m];
                }
                break;
            }
            default: {
                const bad = ev as { type?: unknown };
                throw new LedgerError(`unknown ledger event type ${JSON.stringify(bad.type)}`);
            }
        }
    }

    const total = sumValues(balances);
    if (total !== 0) {
        throw new LedgerError(
            `zero-sum invariant violated: balances sum to ${total} (${JSON.stringify(balances)})`,
        );
    }

    return {
        balances,
        activeMembers: Array.from(active).sort(byId),
        pendingSettlements: Array.from(proposals.values())
            .filter((p) => !confirmed.has(p.settlementId))
            .sort((a, b) => byId(a.settlementId, b.settlementId)),
        confirmedSettlementIds: Array.from(confirmed).sort(byId),
    };
};

/**
 * §1.2 — the member with the most negative balance, as a SUGGESTION. Ties break
 * on member id so the nudge doesn't flicker between equally-indebted members.
 * Returns null when nobody is in the red.
 */
export const suggestNextShopper = (state: LedgerState): MemberId | null => {
    let best: MemberId | null = null;
    for (const m of state.activeMembers) {
        const v = state.balances[m] ?? 0;
        if (v >= 0) continue;
        if (best === null || v < state.balances[best] || (v === state.balances[best] && byId(m, best) < 0)) {
            best = m;
        }
    }
    return best;
};

// ---------------------------------------------------------------------------
// §3.2 Settle-and-leave — greedy debt simplification
// ---------------------------------------------------------------------------

export interface Transfer {
    /** Hands the money over. */
    from: MemberId;
    /** Receives it. */
    to: MemberId;
    amountCents: number;
}

/**
 * The minimal set of transfers that clears ONE member to zero (§3.2).
 *
 * Pairs the member against the opposite-sign balances, LARGEST FIRST, until
 * their balance is gone. Largest-first is what makes the set minimal: any
 * smaller counterparty could only ever need more transfers to absorb the same
 * amount.
 *
 * Both directions are handled by the same walk:
 *   · NEGATIVE balance (owes)     → "Laura owes John €4.00"
 *   · POSITIVE balance (is owed)  → "John owes Laura €4.00"
 * Someone hands money over either way; only the arrow flips.
 *
 * The transfers sum EXACTLY to |balance| (§1.3). That is guaranteed rather than
 * hoped for: the household sums to zero, so the opposite side always holds at
 * least |balance| of capacity. If the walk ever runs out anyway the input was
 * not a valid ledger state, and we throw.
 */
export const simplifyDebts = (
    balances: Record<MemberId, number>,
    member: MemberId,
): Transfer[] => {
    assertMemberId(member, 'member');
    const own = balances[member] ?? 0;
    assertCents(own, `balances[${member}]`);
    if (own === 0) return [];

    const owes = own < 0;
    const counterparties = Object.keys(balances)
        .filter((id) => id !== member && (owes ? balances[id] > 0 : balances[id] < 0))
        .map((id) => ({ id, capacity: Math.abs(assertCents(balances[id], `balances[${id}]`)) }))
        // Largest first; ties broken on id so the dialog is deterministic.
        .sort((a, b) => b.capacity - a.capacity || byId(a.id, b.id));

    let remaining = Math.abs(own);
    const transfers: Transfer[] = [];
    for (const cp of counterparties) {
        if (remaining === 0) break;
        const amountCents = Math.min(remaining, cp.capacity);
        transfers.push(
            owes
                ? { from: member, to: cp.id, amountCents }
                : { from: cp.id, to: member, amountCents },
        );
        remaining -= amountCents;
    }

    if (remaining !== 0) {
        throw new LedgerError(
            `cannot clear ${member}: ${remaining} cents unmatched — the household does not sum to zero ` +
            `(${JSON.stringify(balances)})`,
        );
    }
    const moved = transfers.reduce((s, t) => s + t.amountCents, 0);
    if (moved !== Math.abs(own)) {
        throw new LedgerError(`transfers sum to ${moved}, expected ${Math.abs(own)}`);
    }
    return transfers;
};
