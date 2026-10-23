import {
    AUTO_CONFIRM_ACTOR,
    LedgerError,
    assertSharesSum,
    computeShares,
    deriveLedgerState,
    simplifyDebts,
    suggestNextShopper,
} from '../src/services/householdLedger.js';
import type { LedgerEvent, MemberId, Transfer } from '../src/services/householdLedger.js';

/**
 * FAMILY SHOPPING LEDGER — spec §1/§3.2, phase 1.
 *
 * These are the eight tests §10 asks for, IN THAT ORDER, plus the §2 worked
 * example end-to-end and property tests over randomised inputs. No database:
 * the ledger core is pure by construction (§10 — "nothing in §1 depends on the
 * UI, so it can be built and tested on its own"), and every bug class here
 * surfaces as "balances no longer sum to zero", which is exactly what a fold
 * over a synthetic log can prove.
 */

const LAURA = 'laura';
const PETER = 'peter';
const JOHN = 'john';
// Ordering by member id (§1.3) is codepoint order: john < laura < peter.

const T0 = Date.parse('2026-07-01T10:00:00Z');

/** Builds a well-formed log: monotonic ids, monotonic timestamps. */
const makeLog = () => {
    const events: LedgerEvent[] = [];
    let n = 0;
    const push = (body: Record<string, unknown>): LedgerEvent => {
        n += 1;
        const ev = { id: n, at: new Date(T0 + n * 60_000).toISOString(), ...body } as LedgerEvent;
        events.push(ev);
        return ev;
    };
    return {
        events,
        join: (member: MemberId) => push({ type: 'member_joined', member }),
        leave: (member: MemberId) => push({ type: 'member_left', member }),
        receipt: (receiptId: number, payer: MemberId, amountCents: number, participants: MemberId[]) =>
            push({
                type: 'receipt_recorded',
                receiptId,
                payer,
                amountCents,
                shares: computeShares(receiptId, amountCents, participants),
            }),
        propose: (settlementId: string, from: MemberId, to: MemberId, amountCents: number, by = from) =>
            push({ type: 'settlement_proposed', settlementId, from, to, amountCents, by }),
        confirm: (settlementId: string, by: MemberId) =>
            push({ type: 'settlement_confirmed', settlementId, by }),
        adjust: (receiptId: number, reason: string, deltaByMember: Record<MemberId, number>) =>
            push({ type: 'adjustment', receiptId, reason, deltaByMember }),
    };
};

const sum = (rec: Record<string, number>): number =>
    Object.keys(rec).reduce((s, k) => s + rec[k], 0);

/** Applies §1.2's settlement semantics, so tests exercise the real direction. */
const applyTransfers = (balances: Record<MemberId, number>, transfers: Transfer[]): Record<MemberId, number> => {
    const out = { ...balances };
    for (const t of transfers) {
        out[t.from] = (out[t.from] ?? 0) + t.amountCents;
        out[t.to] = (out[t.to] ?? 0) - t.amountCents;
    }
    return out;
};

/** Deterministic PRNG (mulberry32) — property tests must be replayable. */
const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ===========================================================================
// §10.1 — sum(all balances) === 0 after EVERY event type, always
// ===========================================================================

describe('1. zero-sum invariant holds after every event type', () => {
    it('every prefix of a log containing all six event types sums to zero', () => {
        const log = makeLog();
        log.join(LAURA);
        log.join(PETER);
        log.receipt(11, LAURA, 1234, [LAURA, PETER]);
        log.join(JOHN);
        log.receipt(12, JOHN, 999, [LAURA, PETER, JOHN]);
        log.adjust(12, 'Coffee moved to personal', { [JOHN]: 420, [LAURA]: -210, [PETER]: -210 });
        log.propose('s-1', LAURA, PETER, 300);
        log.confirm('s-1', PETER);
        log.leave(PETER);

        expect(log.events).toHaveLength(9);
        // Fold every prefix: the invariant must hold after each individual event,
        // not merely at the end where errors could cancel out.
        for (let i = 0; i <= log.events.length; i++) {
            const state = deriveLedgerState(log.events.slice(0, i));
            expect(sum(state.balances)).toBe(0);
        }
        // All six types were exercised.
        expect(new Set(log.events.map((e) => e.type)).size).toBe(6);
    });

    it('a departed member stays in the balance map (dropping them would break the sum)', () => {
        const log = makeLog();
        log.join(LAURA);
        log.join(PETER);
        log.receipt(20, LAURA, 1000, [LAURA, PETER]);
        log.leave(PETER);
        const state = deriveLedgerState(log.events);
        expect(Object.keys(state.balances).sort()).toEqual([LAURA, PETER]);
        expect(state.activeMembers).toEqual([LAURA]);
        expect(sum(state.balances)).toBe(0);
    });

    it('a corrupt log that does not sum to zero THROWS rather than serving wrong numbers', () => {
        const log = makeLog();
        log.join(LAURA);
        log.join(PETER);
        const bad = log.receipt(21, LAURA, 1000, [LAURA, PETER]) as any;
        bad.shares[LAURA] = 499; // hand-corrupted row
        expect(() => deriveLedgerState(log.events)).toThrow(LedgerError);
    });
});

// ===========================================================================
// §10.2 — sum(shares) === amountCents on every receipt (asserted on write)
// ===========================================================================

describe('2. share split always adds up', () => {
    it('sums exactly for every participant count and every remainder', () => {
        for (let n = 1; n <= 12; n++) {
            const participants = Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, '0')}`);
            for (let amount = 0; amount <= 250; amount++) {
                for (let receiptId = 0; receiptId < 5; receiptId++) {
                    const shares = computeShares(receiptId, amount, participants);
                    expect(Object.keys(shares)).toHaveLength(n);
                    expect(sum(shares)).toBe(amount);
                    // No share differs from another by more than one cent.
                    const vals = Object.values(shares);
                    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
                }
            }
        }
    });

    it('€10.00 across 3 is 334/333/333 — the spec\'s worked split', () => {
        const shares = computeShares(0, 1000, ['a', 'b', 'c']);
        expect(Object.values(shares).sort((x, y) => y - x)).toEqual([334, 333, 333]);
        expect(sum(shares)).toBe(1000);
    });

    it('the assertion THROWS on write — it does not log and continue', () => {
        // assertSharesSum is what the model calls on the exact payload it inserts.
        expect(() => assertSharesSum(1000, { a: 334, b: 333, c: 332 })).toThrow(LedgerError);
        expect(() => assertSharesSum(1000, { a: 334, b: 333, c: 334 })).toThrow(/does not add up/);
        expect(() => assertSharesSum(1000, { a: 334, b: 333, c: 333 })).not.toThrow();
    });

    it('rejects non-integer money at the door — no floats reach the log', () => {
        expect(() => computeShares(1, 10.5, ['a', 'b'])).toThrow(LedgerError);
        expect(() => computeShares(1, -100, ['a', 'b'])).toThrow(/must be >= 0/);
        expect(() => computeShares(1, 100, [])).toThrow(/at least one participant/);
        expect(() => assertSharesSum(100, { a: 50.5, b: 49.5 })).toThrow(LedgerError);
    });

    it('duplicate participants collapse to one share', () => {
        const shares = computeShares(1, 300, ['a', 'b', 'a']);
        expect(shares).toEqual({ a: 150, b: 150 });
    });
});

// ===========================================================================
// §10.3 — remainder rotation
// ===========================================================================

describe('3. the extra cent rotates across consecutive receipts', () => {
    const participants = [LAURA, PETER, JOHN]; // sorted: john, laura, peter

    const extraCentHolder = (receiptId: number): MemberId => {
        const shares = computeShares(receiptId, 1000, participants); // base 333, r 1
        const winners = Object.keys(shares).filter((m) => shares[m] === 334);
        expect(winners).toHaveLength(1);
        return winners[0];
    };

    it('three consecutive receipts with the same participants give the extra cent to three different members', () => {
        const holders = [7, 8, 9].map(extraCentHolder);
        expect(new Set(holders).size).toBe(3);
        // Deterministic, not random: offset = receiptId mod n over [john, laura, peter].
        expect(holders).toEqual([LAURA, PETER, JOHN]);
    });

    it('consecutive receipts never hand the extra cent to the same member twice in a row', () => {
        let previous = extraCentHolder(0);
        for (let receiptId = 1; receiptId < 60; receiptId++) {
            const holder = extraCentHolder(receiptId);
            expect(holder).not.toBe(previous);
            previous = holder;
        }
    });

    it('is fair over time — 60 receipts spread the extra cent evenly', () => {
        const tally: Record<MemberId, number> = { [LAURA]: 0, [PETER]: 0, [JOHN]: 0 };
        for (let receiptId = 0; receiptId < 60; receiptId++) tally[extraCentHolder(receiptId)] += 1;
        expect(Object.values(tally)).toEqual([20, 20, 20]);
    });

    it('is replayable — the same receiptId always produces the same split', () => {
        expect(computeShares(42, 1000, participants)).toEqual(computeShares(42, 1000, participants));
    });
});

// ===========================================================================
// §10.4 — a member leaving does not alter any historical receipt's split
// ===========================================================================

describe('4. leaving never re-splits history', () => {
    it('the stored shares and every balance contribution are byte-identical before and after member_left', () => {
        const log = makeLog();
        log.join(LAURA);
        log.join(PETER);
        log.join(JOHN);
        const r1 = log.receipt(30, LAURA, 1000, [LAURA, PETER, JOHN]);
        const before = deriveLedgerState([...log.events]);
        const sharesBefore = JSON.stringify((r1 as any).shares);

        log.leave(JOHN);
        const after = deriveLedgerState(log.events);

        expect(JSON.stringify((r1 as any).shares)).toBe(sharesBefore);
        // Balances unchanged — leaving is a membership fact, not a money event.
        expect(after.balances).toEqual(before.balances);
        expect(after.activeMembers).toEqual([LAURA, PETER]);
        expect(sum(after.balances)).toBe(0);
    });

    it('a trip from before Laura left still splits three ways, forever', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER); log.join(JOHN);
        log.receipt(31, PETER, 900, [LAURA, PETER, JOHN]); // 300 each
        log.leave(LAURA);
        log.receipt(32, PETER, 900, [PETER, JOHN]);        // 450 each — Laura excluded
        const state = deriveLedgerState(log.events);
        expect(state.balances[LAURA]).toBe(-300); // untouched by the second trip
        expect(state.balances[PETER]).toBe(900 - 300 + 900 - 450);
        expect(state.balances[JOHN]).toBe(-300 - 450);
        expect(sum(state.balances)).toBe(0);
    });
});

// ===========================================================================
// §10.5 — a joiner is absent from every receipt recorded before they joined
// ===========================================================================

describe('5. joining is never retroactive', () => {
    it('the new member has no share in any earlier receipt and starts at zero', () => {
        const log = makeLog();
        log.join(LAURA);
        log.join(PETER);
        const early1 = log.receipt(40, LAURA, 1000, [LAURA, PETER]);
        const early2 = log.receipt(41, PETER, 777, [LAURA, PETER]);
        const atJoin = deriveLedgerState([...log.events]);

        log.join(JOHN);
        const afterJoin = deriveLedgerState([...log.events]);
        expect(afterJoin.balances[JOHN]).toBe(0);
        expect((early1 as any).shares[JOHN]).toBeUndefined();
        expect((early2 as any).shares[JOHN]).toBeUndefined();
        // Nobody else moved either.
        expect(afterJoin.balances[LAURA]).toBe(atJoin.balances[LAURA]);
        expect(afterJoin.balances[PETER]).toBe(atJoin.balances[PETER]);

        // Only receipts recorded AFTER the join include them.
        const late = log.receipt(42, JOHN, 900, [LAURA, PETER, JOHN]);
        expect((late as any).shares[JOHN]).toBe(300);
        const final = deriveLedgerState(log.events);
        expect(final.activeMembers).toEqual([JOHN, LAURA, PETER]);
        expect(sum(final.balances)).toBe(0);
    });
});

// ===========================================================================
// §10.6 — settlement moves balances ONLY on confirm
// ===========================================================================

describe('6. a pending settlement is inert', () => {
    it('settlement_proposed changes nothing; settlement_confirmed moves the money', () => {
        const log = makeLog();
        log.join(LAURA);
        log.join(PETER);
        log.receipt(50, PETER, 1000, [LAURA, PETER]); // Laura -500, Peter +500
        const before = deriveLedgerState([...log.events]);
        expect(before.balances).toEqual({ [LAURA]: -500, [PETER]: 500 });

        log.propose('s-a', LAURA, PETER, 500, LAURA);
        const pending = deriveLedgerState([...log.events]);
        expect(pending.balances).toEqual(before.balances); // INERT
        expect(pending.pendingSettlements).toHaveLength(1);
        expect(pending.pendingSettlements[0]).toMatchObject({ from: LAURA, to: PETER, amountCents: 500 });
        expect(sum(pending.balances)).toBe(0);

        log.confirm('s-a', PETER);
        const confirmed = deriveLedgerState(log.events);
        expect(confirmed.balances).toEqual({ [LAURA]: 0, [PETER]: 0 });
        expect(confirmed.pendingSettlements).toHaveLength(0);
        expect(confirmed.confirmedSettlementIds).toEqual(['s-a']);
    });

    it('two pending settlements stay inert and independent', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER); log.join(JOHN);
        log.receipt(51, JOHN, 900, [LAURA, PETER, JOHN]); // L -300, P -300, J +600
        log.propose('s-b', LAURA, JOHN, 300);
        log.propose('s-c', PETER, JOHN, 300);
        const state = deriveLedgerState([...log.events]);
        expect(state.balances).toEqual({ [LAURA]: -300, [PETER]: -300, [JOHN]: 600 });
        expect(state.pendingSettlements.map((p) => p.settlementId)).toEqual(['s-b', 's-c']);

        log.confirm('s-b', JOHN);
        const half = deriveLedgerState(log.events);
        expect(half.balances).toEqual({ [LAURA]: 0, [PETER]: -300, [JOHN]: 300 });
        expect(half.pendingSettlements.map((p) => p.settlementId)).toEqual(['s-c']);
        expect(sum(half.balances)).toBe(0);
    });

    it('a confirm with no proposal throws — it never invents a transfer', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER);
        log.confirm('ghost', PETER);
        expect(() => deriveLedgerState(log.events)).toThrow(/no matching settlement_proposed/);
    });

    it('a repeated confirm applies once (double-confirm cannot move money twice)', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER);
        log.receipt(52, PETER, 1000, [LAURA, PETER]);
        log.propose('s-d', LAURA, PETER, 500);
        log.confirm('s-d', PETER);
        log.confirm('s-d', PETER);
        expect(deriveLedgerState(log.events).balances).toEqual({ [LAURA]: 0, [PETER]: 0 });
    });
});

// ===========================================================================
// §10.7 — auto-confirm produces the identical end state to a manual confirm
// ===========================================================================

describe('7. auto-confirm is state-identical to a manual confirm', () => {
    const buildUpTo = () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER); log.join(JOHN);
        log.receipt(60, JOHN, 1700, [LAURA, PETER, JOHN]);
        log.propose('s-e', LAURA, JOHN, 567, LAURA);
        return log;
    };

    it('the fold ignores `by` — 7-day lapse and counterparty tap land on the same balances', () => {
        // The 7-day JOB is phase 2; the STATE EQUIVALENCE it depends on is proven now.
        const manual = buildUpTo();
        manual.confirm('s-e', JOHN); // the counterparty taps confirm

        const auto = buildUpTo();
        auto.confirm('s-e', AUTO_CONFIRM_ACTOR); // 7 days of silence lapse

        const a = deriveLedgerState(manual.events);
        const b = deriveLedgerState(auto.events);
        expect(b.balances).toEqual(a.balances);
        expect(b.activeMembers).toEqual(a.activeMembers);
        expect(b.pendingSettlements).toEqual(a.pendingSettlements);
        expect(b.confirmedSettlementIds).toEqual(a.confirmedSettlementIds);
        expect(sum(b.balances)).toBe(0);
    });

    it('and the timing of the confirm does not change the outcome either', () => {
        const soon = buildUpTo();
        const soonEv = soon.confirm('s-e', JOHN);
        const late = buildUpTo();
        const lateEv = late.confirm('s-e', AUTO_CONFIRM_ACTOR);
        (lateEv as any).at = new Date(Date.parse(soonEv.at) + 7 * 24 * 3600 * 1000).toISOString();
        expect(deriveLedgerState(late.events).balances).toEqual(deriveLedgerState(soon.events).balances);
    });
});

// ===========================================================================
// §10.8 — adjustment preserves the zero-sum invariant
// ===========================================================================

describe('8. adjustment preserves zero-sum', () => {
    it('moving an item to personal after the lock redistributes without creating money', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER); log.join(JOHN);
        log.receipt(70, PETER, 1200, [LAURA, PETER, JOHN]); // 400 each: L -400, P +800, J -400
        const before = deriveLedgerState([...log.events]);
        expect(before.balances).toEqual({ [LAURA]: -400, [PETER]: 800, [JOHN]: -400 });

        // "Peter moved Coffee €4.20 to personal": the €4.20 stops being shared,
        // so Peter absorbs it and the other two get their thirds back (140 each).
        log.adjust(70, 'Coffee €4.20 → personal', { [PETER]: -280, [LAURA]: 140, [JOHN]: 140 });
        const after = deriveLedgerState(log.events);
        expect(sum(after.balances)).toBe(0);
        expect(after.balances).toEqual({ [LAURA]: -260, [PETER]: 520, [JOHN]: -260 });
    });

    it('an adjustment against an ALREADY-SETTLED receipt still holds the invariant', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER);
        log.receipt(71, PETER, 1000, [LAURA, PETER]);
        log.propose('s-f', LAURA, PETER, 500);
        log.confirm('s-f', PETER);
        expect(deriveLedgerState([...log.events]).balances).toEqual({ [LAURA]: 0, [PETER]: 0 });

        log.adjust(71, 'half was personal', { [PETER]: 250, [LAURA]: -250 });
        const after = deriveLedgerState(log.events);
        expect(after.balances).toEqual({ [LAURA]: -250, [PETER]: 250 });
        expect(sum(after.balances)).toBe(0);
    });

    it('a delta that does not sum to zero is REJECTED, not absorbed', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER);
        log.receipt(72, PETER, 1000, [LAURA, PETER]);
        log.adjust(72, 'bad', { [PETER]: 100, [LAURA]: -50 });
        expect(() => deriveLedgerState(log.events)).toThrow(/must sum to zero/);
    });

    it('an adjustment can introduce a member the receipt never had, still zero-sum', () => {
        const log = makeLog();
        log.join(LAURA); log.join(PETER);
        log.receipt(73, PETER, 1000, [LAURA, PETER]);
        log.join(JOHN);
        log.adjust(73, 'John should have been on this trip', { [JOHN]: -100, [LAURA]: 50, [PETER]: 50 });
        const state = deriveLedgerState(log.events);
        expect(sum(state.balances)).toBe(0);
        expect(state.balances[JOHN]).toBe(-100);
    });
});

// ===========================================================================
// §3.2 — the settle-and-leave dialog
// ===========================================================================

describe('debt simplification (§3.2)', () => {
    it('a NEGATIVE leaver sees who they owe, largest counterparty first', () => {
        // Laura -700; John +400, Peter +300.
        const balances = { [LAURA]: -700, [JOHN]: 400, [PETER]: 300 };
        const transfers = simplifyDebts(balances, LAURA);
        expect(transfers).toEqual([
            { from: LAURA, to: JOHN, amountCents: 400 },
            { from: LAURA, to: PETER, amountCents: 300 },
        ]);
        expect(transfers.reduce((s, t) => s + t.amountCents, 0)).toBe(700);
        const cleared = applyTransfers(balances, transfers);
        expect(cleared[LAURA]).toBe(0);
        expect(sum(cleared)).toBe(0);
    });

    it('a POSITIVE leaver sees the arrow reversed — someone hands money over either way', () => {
        const balances = { [LAURA]: 700, [JOHN]: -400, [PETER]: -300 };
        const transfers = simplifyDebts(balances, LAURA);
        expect(transfers).toEqual([
            { from: JOHN, to: LAURA, amountCents: 400 },
            { from: PETER, to: LAURA, amountCents: 300 },
        ]);
        const cleared = applyTransfers(balances, transfers);
        expect(cleared[LAURA]).toBe(0);
        expect(sum(cleared)).toBe(0);
    });

    it('is minimal — one transfer when a single counterparty can absorb it all', () => {
        expect(simplifyDebts({ [LAURA]: -700, [JOHN]: 900, [PETER]: -200 }, LAURA)).toEqual([
            { from: LAURA, to: JOHN, amountCents: 700 },
        ]);
    });

    it('a settled member has nothing to do', () => {
        expect(simplifyDebts({ [LAURA]: 0, [JOHN]: 500, [PETER]: -500 }, LAURA)).toEqual([]);
    });

    it('an odd-cent balance still clears EXACTLY (§1.3)', () => {
        const balances = { [LAURA]: -667, [JOHN]: 334, [PETER]: 333 };
        const transfers = simplifyDebts(balances, LAURA);
        expect(transfers.reduce((s, t) => s + t.amountCents, 0)).toBe(667);
        expect(applyTransfers(balances, transfers)[LAURA]).toBe(0);
    });

    it('ties break deterministically on member id, so the dialog never flickers', () => {
        const a = simplifyDebts({ x: -600, [JOHN]: 300, [PETER]: 300 }, 'x');
        const b = simplifyDebts({ x: -600, [PETER]: 300, [JOHN]: 300 }, 'x');
        expect(a).toEqual(b);
        expect(a[0].to).toBe(JOHN);
    });

    it('a non-zero-sum input is rejected rather than half-cleared', () => {
        expect(() => simplifyDebts({ [LAURA]: -700, [JOHN]: 100 }, LAURA)).toThrow(/does not sum to zero/);
    });
});

// ===========================================================================
// §2 — the worked example, end to end
// ===========================================================================

describe('§2 worked example, end to end', () => {
    it('Laura −7 / Peter 0 / John +7, then Laura settles and leaves, then Peter pays €12', () => {
        const log = makeLog();
        log.join(LAURA);
        log.join(PETER);
        log.join(JOHN);

        // Receipt ids 1, 2, 4: with n=3 the rotation offset is receiptId mod 3, and
        // ids 1/2/4 give the split the spec's totals require (no three CONSECUTIVE
        // ids can — that is the rotation doing its job, not a fudge).
        log.receipt(1, LAURA, 300, [LAURA, PETER, JOHN]);   // €3   → 100 each
        log.receipt(2, JOHN, 1700, [LAURA, PETER, JOHN]);   // €17  → 566/567/567
        log.receipt(4, PETER, 1000, [LAURA, PETER, JOHN]);  // €10  → 334/333/333

        const state = deriveLedgerState([...log.events]);
        expect(state.balances).toEqual({ [LAURA]: -700, [PETER]: 0, [JOHN]: 700 });
        expect(sum(state.balances)).toBe(0);
        // "Next shopper suggested: Laura."
        expect(suggestNextShopper(state)).toBe(LAURA);

        // Laura leaves → the settle-and-leave dialog (§3.2).
        const transfers = simplifyDebts(state.balances, LAURA);
        expect(transfers).toEqual([{ from: LAURA, to: JOHN, amountCents: 700 }]);

        // §3.2.1 — both parties. Proposing alone must not move anything.
        log.propose('s-laura', LAURA, JOHN, 700, LAURA);
        expect(deriveLedgerState([...log.events]).balances).toEqual(state.balances);

        log.confirm('s-laura', JOHN);
        const settled = deriveLedgerState([...log.events]);
        expect(settled.balances).toEqual({ [LAURA]: 0, [PETER]: 0, [JOHN]: 0 });

        // §3.1 — only now, at zero, may she leave.
        expect(settled.balances[LAURA]).toBe(0);
        log.leave(LAURA);

        // R4: Peter pays €12, participants {Peter, John}.
        log.receipt(5, PETER, 1200, [PETER, JOHN]);
        const final = deriveLedgerState(log.events);
        expect(final.balances).toEqual({ [LAURA]: 0, [PETER]: 600, [JOHN]: -600 });
        expect(final.activeMembers).toEqual([JOHN, PETER]);
        expect(sum(final.balances)).toBe(0);
        // "Next shopper suggested: John." — and paying pushed Peter POSITIVE,
        // which is the v1 sign bug §2 exists to correct.
        expect(suggestNextShopper(final)).toBe(JOHN);
    });
});

// ===========================================================================
// Property tests
// ===========================================================================

describe('property: randomised amounts and participant counts', () => {
    it('5000 random splits all satisfy sum(shares) === amountCents', () => {
        const rand = rng(20260728);
        for (let i = 0; i < 5000; i++) {
            const n = 1 + Math.floor(rand() * 12);
            const participants = Array.from({ length: n }, (_, k) => `u-${Math.floor(rand() * 1000)}-${k}`);
            const amountCents = Math.floor(rand() * 5_000_00);
            const receiptId = Math.floor(rand() * 100_000);
            const shares = computeShares(receiptId, amountCents, participants);
            expect(sum(shares)).toBe(amountCents);
            const base = Math.floor(amountCents / n);
            for (const m of Object.keys(shares)) {
                // Every share is base or base+1 — never a re-division artefact.
                expect(shares[m] === base || shares[m] === base + 1).toBe(true);
            }
        }
    });

    it('1000 random logs fold to zero and every member clears EXACTLY', () => {
        const rand = rng(9781);
        for (let iter = 0; iter < 1000; iter++) {
            const memberCount = 2 + Math.floor(rand() * 6);
            const members = Array.from({ length: memberCount }, (_, i) => `m${String(i).padStart(2, '0')}`);
            const log = makeLog();
            for (const m of members) log.join(m);

            let settlementSeq = 0;
            const proposed: { id: string; from: MemberId; to: MemberId; amountCents: number }[] = [];
            const receiptEvents = 3 + Math.floor(rand() * 10);
            for (let e = 0; e < receiptEvents; e++) {
                const roll = rand();
                if (roll < 0.7) {
                    // A receipt with a random non-empty participant subset.
                    const participants = members.filter(() => rand() < 0.7);
                    if (participants.length === 0) participants.push(members[0]);
                    const payer = participants[Math.floor(rand() * participants.length)];
                    log.receipt(Math.floor(rand() * 10_000), payer, Math.floor(rand() * 20_000), participants);
                } else if (roll < 0.85) {
                    // An adjustment: a random zero-sum redistribution.
                    const a = members[Math.floor(rand() * memberCount)];
                    const b = members[Math.floor(rand() * memberCount)];
                    if (a === b) continue;
                    const delta = 1 + Math.floor(rand() * 500);
                    log.adjust(1, 'randomised', { [a]: delta, [b]: -delta });
                } else {
                    // Propose (inert) and sometimes confirm.
                    const state = deriveLedgerState([...log.events]);
                    const debtor = members.find((m) => (state.balances[m] ?? 0) < 0);
                    const creditor = members.find((m) => (state.balances[m] ?? 0) > 0);
                    if (!debtor || !creditor) continue;
                    const amountCents = Math.min(-state.balances[debtor], state.balances[creditor]);
                    if (amountCents <= 0) continue;
                    settlementSeq += 1;
                    const id = `p-${iter}-${settlementSeq}`;
                    log.propose(id, debtor, creditor, amountCents, debtor);
                    proposed.push({ id, from: debtor, to: creditor, amountCents });
                    if (rand() < 0.6) log.confirm(id, rand() < 0.5 ? creditor : AUTO_CONFIRM_ACTOR);
                }
            }

            const state = deriveLedgerState(log.events);
            expect(sum(state.balances)).toBe(0);
            for (const m of Object.keys(state.balances)) {
                expect(Number.isSafeInteger(state.balances[m])).toBe(true);
            }
            // Every member must be clearable to exactly zero (§3.2 / §1.3).
            for (const m of Object.keys(state.balances)) {
                const transfers = simplifyDebts(state.balances, m);
                const moved = transfers.reduce((s, t) => s + t.amountCents, 0);
                expect(moved).toBe(Math.abs(state.balances[m]));
                const cleared = applyTransfers(state.balances, transfers);
                expect(cleared[m]).toBe(0);
                expect(sum(cleared)).toBe(0);
            }
        }
    });

    it('property: a pending settlement is ALWAYS inert, whatever the log', () => {
        const rand = rng(4242);
        for (let iter = 0; iter < 300; iter++) {
            const log = makeLog();
            log.join(LAURA); log.join(PETER); log.join(JOHN);
            const receipts = 1 + Math.floor(rand() * 5);
            for (let i = 0; i < receipts; i++) {
                const participants = [LAURA, PETER, JOHN].filter(() => rand() < 0.8);
                if (participants.length === 0) participants.push(JOHN);
                log.receipt(
                    Math.floor(rand() * 1000),
                    participants[Math.floor(rand() * participants.length)],
                    Math.floor(rand() * 10_000),
                    participants,
                );
            }
            const before = deriveLedgerState([...log.events]);
            log.propose(`inert-${iter}`, LAURA, PETER, 1 + Math.floor(rand() * 900), LAURA);
            const after = deriveLedgerState(log.events);
            expect(after.balances).toEqual(before.balances);
        }
    });
});
