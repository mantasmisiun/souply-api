import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { createHousehold, joinHousehold } from '../src/models/householdModel.js';
import {
    getLedgerEvents,
    getLedgerState,
    getReceiptRecordedEvent,
    isReceiptSettlementLocked,
    appendSettlementProposed,
    appendSettlementConfirmed,
} from '../src/models/householdLedgerModel.js';
import { deriveLedgerState } from '../src/services/householdLedger.js';
import { recordFamilyReceipt } from '../src/services/householdMembership.js';
import { confirmSettlement, proposeSettlement } from '../src/services/householdSettlements.js';
import {
    computeFamilySubtotalCents,
    getScopedReceiptItems,
    itemToLine,
    lineToItem,
    lineTotalCents,
    replaceReceiptItems,
} from '../src/models/receiptItemModel.js';
import {
    assertReceiptDeletable,
    getFamilyReceiptView,
    getScopeLockState,
    getReceiptScopeContext,
    setReceiptItemScope,
} from '../src/services/receiptFamilyScope.js';

/**
 * FAMILY SHOPPING §4 — FAMILY vs PERSONAL ITEMS, against the real database.
 *
 * Two invariants run through every test here:
 *   §4.3  the ledger only ever sees the FAMILY subtotal. Never the grand total.
 *   §1.2  balances sum to exactly zero — after a restatement, after an
 *         adjustment, after any sequence of them. `deriveLedgerState` THROWS
 *         when they don't, so every `state()` call below is also that check.
 */

const OWNER = 'rfs-owner-0000-0000-000000000001';
const ALICE = 'rfs-alice-0000-0000-000000000002';
const BOB = 'rfs-bob00-0000-0000-000000000003';
/** In no household at all — the §4.5 "non-member gets nothing" case. */
const STRANGER = 'rfs-stran-0000-0000-000000000004';
const ALL_USERS = [OWNER, ALICE, BOB, STRANGER];

const HOUR_MS = 60 * 60 * 1000;

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

/** A receipt attached to a trip of `householdId` (null → an ordinary personal receipt). */
const freshReceipt = async (args: {
    householdId: number | null;
    uploader: string;
    /** `[grossEuros, isPersonal]` per line. */
    lines: [number, boolean][];
    /** Goes into parsedData.footer.total — the GRAND TOTAL that must never leak. */
    printedTotal?: number;
    savedAmount?: number;
}): Promise<number> => {
    let tripId: number | null = null;
    if (args.householdId != null) {
        const t = await q(
            'INSERT INTO Trip (createdByUserId, householdId, isAdHoc) VALUES (?,?,1)',
            [args.uploader, args.householdId]);
        tripId = Number(t.insertId);
        createdTrips.push(tripId);
    }
    const parsed = JSON.stringify({
        header: {},
        products: [],
        footer: { total: args.printedTotal ?? 99.99, totalSavings: 1.23, comboDiscount: 0 },
    });
    const r = await q(
        `INSERT INTO Receipt (userId, uploaderUserId, tripId, storeId, filePath, fileType,
                              processingStatus, receiptDate, parsedData, savedAmount)
         VALUES (?,?,?,NULL,?, 'jpg', 'done', NOW(), ?, ?)`,
        [args.uploader, args.uploader, tripId, `receipts/${Date.now()}-${Math.random()}.jpg`,
            parsed, args.savedAmount ?? 7.77],
    );
    const receiptId = Number(r.insertId);
    createdReceipts.push(receiptId);
    await replaceReceiptItems(receiptId, args.lines.map(([price, isPersonal], i) => ({
        name: `Item ${i}`, price, quantity: 1, isPersonal,
    })));
    return receiptId;
};

const state = (householdId: number) => getLedgerState(householdId);

const expectZeroSum = async (householdId: number): Promise<void> => {
    const s = await state(householdId);
    expect(Object.values(s.balances).reduce((a, b) => a + b, 0)).toBe(0);
};

const eventsOfType = async (householdId: number, type: string) =>
    (await getLedgerEvents(householdId)).filter(e => e.type === type);

const recordedAmount = async (householdId: number, receiptId: number): Promise<number | null> =>
    (await getReceiptRecordedEvent(householdId, receiptId))?.amountCents ?? null;

const backdateUpload = (receiptId: number, hoursAgo: number) =>
    q('UPDATE Receipt SET uploadedAt = DATE_SUB(NOW(), INTERVAL ? HOUR) WHERE id = ?', [hoursAgo, receiptId]);

const cleanAll = async () => {
    if (createdReceipts.length) {
        await q('DELETE FROM ReceiptItem WHERE receiptId IN (?)', [createdReceipts]);
        await q('DELETE FROM Receipt WHERE id IN (?)', [createdReceipts]);
        createdReceipts.length = 0;
    }
    if (createdTrips.length) {
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
// §4.1 the flag itself
// ---------------------------------------------------------------------------

describe('§4.1 the item flag', () => {
    it('defaults to FAMILY when nothing says otherwise', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [] });
        await replaceReceiptItems(rid, [{ name: 'A', price: 1.5, quantity: 1 }]);
        const items = await getScopedReceiptItems(rid);
        expect(items).toHaveLength(1);
        expect(items[0].isPersonal).toBe(false);
    });

    it('survives the line <-> row round trip', () => {
        const back = itemToLine(lineToItem(1, 0, { name: 'A', price: 2, isPersonal: true }));
        expect(back.isPersonal).toBe(true);
        expect(itemToLine(lineToItem(1, 0, { name: 'A', price: 2 })).isPersonal).toBe(false);
    });

    it('is PRESERVED across a re-save whose lines do not carry it', async () => {
        // The autosave / heal / dev-replace trap: a whole-receipt rewrite must
        // not silently move personal items back into the family subtotal.
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [4, true]],
        });
        await replaceReceiptItems(rid, [
            { name: 'Item 0', price: 10, quantity: 1 },
            { name: 'Item 1', price: 4, quantity: 1 },
        ]);
        expect((await getScopedReceiptItems(rid)).map(i => i.isPersonal)).toEqual([false, true]);
        expect(await computeFamilySubtotalCents(rid)).toBe(1000);
    });

    it('lets an EXPLICIT false clear the flag', async () => {
        const hh = await freshHousehold(OWNER);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[4, true]] });
        await replaceReceiptItems(rid, [{ name: 'Item 0', price: 4, quantity: 1, isPersonal: false }]);
        expect((await getScopedReceiptItems(rid))[0].isPersonal).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// §4.3 only family items reach the ledger
// ---------------------------------------------------------------------------

describe('§4.3 the ledger amount is the family subtotal', () => {
    it('sums FAMILY items only, ignoring the printed grand total', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER,
            lines: [[10.00, false], [5.50, false], [4.20, true]],
            printedTotal: 19.70,
        });
        expect(await computeFamilySubtotalCents(rid)).toBe(1550);

        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        // 1550, NOT 1970 — the personal €4.20 never reaches a balance.
        expect(await recordedAmount(hh, rid)).toBe(1550);
        await expectZeroSum(hh);
    });

    it('prefers the promo price and multiplies by quantity, like every other spend number', () => {
        expect(lineTotalCents({ price: 2.5, promoPrice: null, quantity: 2 })).toBe(500);
        expect(lineTotalCents({ price: 2.5, promoPrice: 1.99, quantity: 2 })).toBe(398);
        expect(lineTotalCents({ price: 3, promoPrice: null, quantity: null })).toBe(300);
        // A weighed item with an unrecoverable price is stored as 0 — never invented.
        expect(lineTotalCents({ price: 0, promoPrice: null, quantity: 1 })).toBe(0);
    });

    it('records ZERO when every item is personal', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, true], [5, true]], printedTotal: 15,
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        expect(await recordedAmount(hh, rid)).toBe(0);
        await expectZeroSum(hh);
    });
});

// ---------------------------------------------------------------------------
// §4.4 the lock window
// ---------------------------------------------------------------------------

describe('§4.4 the lock window', () => {
    it('is OPEN inside 72 h: toggling changes the amount with NO adjustment event', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [6, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        expect(await recordedAmount(hh, rid)).toBe(1600);
        expect((await state(hh)).balances[ALICE]).toBe(-800);

        const res = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [1], isPersonal: true,
        });
        expect(res.ledger).toBe('restated');
        expect(res.lock.reason).toBe('open');
        expect(res.familySubtotalCents).toBe(1000);
        // The recorded amount MOVED, and no audit entry was created.
        expect(await recordedAmount(hh, rid)).toBe(1000);
        expect(await eventsOfType(hh, 'adjustment')).toHaveLength(0);
        expect((await state(hh)).balances[ALICE]).toBe(-500);
        await expectZeroSum(hh);
    });

    it('EXPIRES after 72 h: toggling emits an adjustment instead', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [6, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await backdateUpload(rid, 73);

        const lock = await getScopeLockState((await getReceiptScopeContext(rid))!);
        expect(lock).toMatchObject({ recorded: true, locked: true, reason: 'expired' });

        const res = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [1], isPersonal: true,
        });
        expect(res.ledger).toBe('adjusted');
        expect(res.previousFamilySubtotalCents).toBe(1600);
        expect(res.familySubtotalCents).toBe(1000);

        const adjustments = await eventsOfType(hh, 'adjustment');
        expect(adjustments).toHaveLength(1);
        expect((adjustments[0] as any).reason).toContain('to-personal');
        // The original receipt_recorded is UNTOUCHED — history was not rewritten.
        expect(await recordedAmount(hh, rid)).toBe(1600);
        // ...but the balances reflect €10, not €16.
        expect((await state(hh)).balances[ALICE]).toBe(-500);
        await expectZeroSum(hh);
    });

    it('is still open at 71 h and locked at 73 h', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await backdateUpload(rid, 71);
        expect((await getScopeLockState((await getReceiptScopeContext(rid))!)).locked).toBe(false);
        await backdateUpload(rid, 73);
        expect((await getScopeLockState((await getReceiptScopeContext(rid))!)).locked).toBe(true);
    });

    it('LOCKS once a settlement is confirmed after the receipt was recorded', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [6, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        // ALICE owes 800; she hands it over, OWNER confirms.
        const proposal = await proposeSettlement({
            proposer: ALICE, from: ALICE, to: OWNER, amountCents: 800,
        });
        await confirmSettlement(OWNER, proposal.settlementId);

        expect(await isReceiptSettlementLocked(hh, rid)).toBe(true);
        const res = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [1], isPersonal: true,
        });
        expect(res.lock.reason).toBe('settled');
        expect(res.ledger).toBe('adjusted');
        expect(await eventsOfType(hh, 'adjustment')).toHaveLength(1);
        expect(await recordedAmount(hh, rid)).toBe(1600);
        await expectZeroSum(hh);
    });

    it('does NOT lock on a settlement confirmed BEFORE the receipt was recorded', async () => {
        // The half of the ordering rule that matters most: without it, one
        // historical settlement would lock every future receipt forever.
        const hh = await freshHousehold(OWNER, [ALICE]);
        const older = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: older, payer: OWNER });
        const proposal = await proposeSettlement({
            proposer: ALICE, from: ALICE, to: OWNER, amountCents: 500,
        });
        await confirmSettlement(OWNER, proposal.settlementId);
        expect(await isReceiptSettlementLocked(hh, older)).toBe(true);

        const newer = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[8, false], [2, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: newer, payer: OWNER });
        expect(await isReceiptSettlementLocked(hh, newer)).toBe(false);

        const res = await setReceiptItemScope({
            receiptId: newer, actorUserId: OWNER, lineIdxs: [1], isPersonal: true,
        });
        expect(res.ledger).toBe('restated');
        expect(await recordedAmount(hh, newer)).toBe(800);
        await expectZeroSum(hh);
    });

    it('a PENDING settlement does not lock — only a confirmed one does', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false], [6, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 800 });
        expect(await isReceiptSettlementLocked(hh, rid)).toBe(false);
        expect((await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [1], isPersonal: true,
        })).ledger).toBe('restated');
    });

    it('never locks a receipt that was never counted into a ledger, however old', async () => {
        const rid = await freshReceipt({ householdId: null, uploader: OWNER, lines: [[10, false]] });
        await backdateUpload(rid, 24 * 30);
        const lock = await getScopeLockState((await getReceiptScopeContext(rid))!);
        expect(lock).toMatchObject({ recorded: false, locked: false, reason: 'not-recorded' });
        const res = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [0], isPersonal: true,
        });
        expect(res.ledger).toBe('none');
        expect(res.familySubtotalCents).toBe(0);
    });

    it('a no-op toggle writes nothing to the ledger', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await backdateUpload(rid, 100);
        const res = await setReceiptItemScope({
            receiptId: rid, actorUserId: OWNER, lineIdxs: [0], isPersonal: false,
        });
        expect(res.changedLineIdxs).toEqual([]);
        expect(res.ledger).toBe('none');
        expect(await eventsOfType(hh, 'adjustment')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// §4.4 / §10.8 adjustments preserve the zero-sum invariant
// ---------------------------------------------------------------------------

describe('§4.4 adjustments', () => {
    it('move balances with an audit trail and keep the household at zero', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [5, false], [3, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await backdateUpload(rid, 100);
        expect(await recordedAmount(hh, rid)).toBe(1800);

        await setReceiptItemScope({ receiptId: rid, actorUserId: BOB, lineIdxs: [2], isPersonal: true });
        const s = await state(hh);
        // €15 family across 3 → 500 each; OWNER paid 1500 of family value.
        expect(s.balances[OWNER]).toBe(1000);
        expect(s.balances[ALICE]).toBe(-500);
        expect(s.balances[BOB]).toBe(-500);
        await expectZeroSum(hh);
    });

    it('compose: a second adjustment computes against the FIRST one', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [6, false], [4, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await backdateUpload(rid, 100);

        await setReceiptItemScope({ receiptId: rid, actorUserId: OWNER, lineIdxs: [1], isPersonal: true });
        await setReceiptItemScope({ receiptId: rid, actorUserId: OWNER, lineIdxs: [2], isPersonal: true });
        expect(await eventsOfType(hh, 'adjustment')).toHaveLength(2);
        // Family is €10 → ALICE owes half.
        expect((await state(hh)).balances[ALICE]).toBe(-500);
        await expectZeroSum(hh);

        // ...and back again: personal → family restores the original split.
        await setReceiptItemScope({ receiptId: rid, actorUserId: OWNER, lineIdxs: [1, 2], isPersonal: false });
        expect((await state(hh)).balances[ALICE]).toBe(-1000);
        await expectZeroSum(hh);
    });

    it('keeps the FROZEN participant set: a later joiner is never dragged in', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [6, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await backdateUpload(rid, 100);
        await joinHousehold(hh, BOB);

        await setReceiptItemScope({ receiptId: rid, actorUserId: OWNER, lineIdxs: [1], isPersonal: true });
        const s = await state(hh);
        expect(s.balances[BOB]).toBe(0);
        expect(s.balances[ALICE]).toBe(-500);
        await expectZeroSum(hh);
    });

    it('PROPERTY: any sequence of random toggles keeps the household summing to zero', async () => {
        const hh = await freshHousehold(OWNER, [ALICE, BOB]);
        // Prices chosen to hit odd-cent splits across 3 members constantly.
        const prices: [number, boolean][] = [
            [3.33, false], [7.77, false], [0.01, false], [12.49, false],
            [5.05, false], [0.99, false], [21.11, false], [4.44, false],
        ];
        const rid = await freshReceipt({ householdId: hh, uploader: ALICE, lines: prices });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: ALICE });
        await backdateUpload(rid, 100); // every toggle from here is an adjustment

        const actors = [OWNER, ALICE, BOB];
        for (let step = 0; step < 40; step++) {
            const n = 1 + (step % 3);
            const lineIdxs = Array.from({ length: n }, (_, k) => (step * 7 + k * 3) % prices.length);
            const isPersonal = (step * 13) % 2 === 0;
            await setReceiptItemScope({
                receiptId: rid, actorUserId: actors[step % actors.length], lineIdxs, isPersonal,
            });

            // The invariant, re-derived from the raw log every single step.
            const events = await getLedgerEvents(hh);
            const folded = deriveLedgerState(events);
            expect(Object.values(folded.balances).reduce((a, b) => a + b, 0)).toBe(0);

            // ...and the ledger still agrees with the ITEMS it is a projection of.
            const expected = await computeFamilySubtotalCents(rid);
            const last = events.filter(e => e.type === 'adjustment').at(-1) as any;
            expect(last.amountCents).toBe(expected);
            expect(Object.values(last.shares as Record<string, number>)
                .reduce((a, b) => a + b, 0)).toBe(expected);
            expect(Object.values(last.deltaByMember as Record<string, number>)
                .reduce((a, b) => a + b, 0)).toBe(0);
        }
    }, 60000);
});

// ---------------------------------------------------------------------------
// §4.5 visibility
// ---------------------------------------------------------------------------

describe('§4.5 visibility for a household member who did not upload', () => {
    const GRAND_TOTAL = 19.7;
    const SAVED = 3.21;

    const setup = async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER,
            lines: [[10.00, false], [5.50, false], [4.20, true]],
            printedTotal: GRAND_TOTAL, savedAmount: SAVED,
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        return { hh, rid };
    };

    it('returns FAMILY items only, with the family subtotal and family-only stats', async () => {
        const { rid } = await setup();
        const view = (await getFamilyReceiptView({ receiptId: rid, viewerUserId: ALICE }))!;
        expect(view).not.toBeNull();
        expect(view.familyItems.map(i => i.name)).toEqual(['Item 0', 'Item 1']);
        expect(view.familySubtotalCents).toBe(1550);
        expect(view.stats.itemCount).toBe(2);
        expect(view.stats.subtotalCents).toBe(1550);
        expect(view.stats.categoryBreakdown.reduce((a, c) => a + c.totalCents, 0)).toBe(1550);
    });

    it('LEAKS NOTHING: no grand total, no personal item, no image, anywhere in the payload', async () => {
        const { rid } = await setup();
        const view = (await getFamilyReceiptView({ receiptId: rid, viewerUserId: ALICE }))!;
        const wire = JSON.stringify(view);

        // Whole-payload scan, not a field-by-field check: this is what catches a
        // total that arrives via a nested object nobody thought about. Numbers
        // are compared as VALUES (a receipt id like 994200 contains "420"), keys
        // and strings as substrings.
        const numbers: number[] = [];
        const walk = (v: any): void => {
            if (typeof v === 'number') numbers.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(view.familyItems);
        walk(view.stats);
        walk({ s: view.familySubtotalCents });
        expect(numbers).not.toContain(1970);        // footer.total, in cents
        expect(numbers).not.toContain(19.7);        // ...as written
        expect(numbers).not.toContain(420);         // the personal line's cents
        expect(numbers).not.toContain(4.2);         // ...as written
        expect(numbers).not.toContain(3.21);        // savedAmount

        expect(wire).not.toContain('Item 2');       // the personal line
        expect(wire).not.toContain('parsedData');
        expect(wire).not.toContain('footer');
        expect(wire).not.toContain('filePath');
        expect(wire).not.toContain('savedAmount');
        expect(wire).not.toContain('.jpg');

        // The allowlist, stated positively — an added key must break this test.
        expect(Object.keys(view).sort()).toEqual([
            'chainName', 'familyItems', 'familySubtotalCents', 'householdId', 'lock',
            'receiptDate', 'receiptId', 'stats', 'storeName', 'tripId', 'uploadedAt',
            'uploaderUserId',
        ]);
        // No count or total of personal items either — with the family subtotal
        // known, a personal count is a partial disclosure for no product value.
        expect(wire).not.toContain('personal');
    });

    it('the grand total cannot be recovered by subtraction from what IS returned', async () => {
        const { rid } = await setup();
        const view = (await getFamilyReceiptView({ receiptId: rid, viewerUserId: ALICE }))!;
        const sumOfEverything = view.familyItems.reduce((a, i) => a + i.lineTotalCents, 0)
            + view.stats.promoSavingsCents;
        // Everything the viewer can add up is the FAMILY side. 1970 is unreachable.
        expect(sumOfEverything).toBe(1550);
    });

    it('serves the same redacted view over HTTP, and still refuses the owner-bound routes', async () => {
        const { rid } = await setup();
        const alice = asUser(app, ALICE);

        const ok = await alice.get(`/api/receipts/${rid}/family`);
        expect(ok.status).toBe(200);
        expect(ok.body.familySubtotalCents).toBe(1550);
        expect(JSON.stringify(ok.body)).not.toContain('19.7');

        // §4.5 third bullet — the image would show the personal items in print.
        expect((await alice.get(`/api/receipts/${rid}/image`)).status).toBe(403);
        // ...and the full receipt (which carries footer.total) is still owner-only.
        expect((await alice.get(`/api/receipts/${rid}`)).status).toBe(403);
        // ...as is the comparison basket, which is a whole-receipt total by another name.
        expect((await alice.get(`/api/receipts/${rid}/comparison`)).status).toBe(403);
    });

    it('gives a NON-MEMBER nothing at all, and does not leak that the receipt exists', async () => {
        const { rid } = await setup();
        expect(await getFamilyReceiptView({ receiptId: rid, viewerUserId: STRANGER })).toBeNull();
        const res = await asUser(app, STRANGER).get(`/api/receipts/${rid}/family`);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('19.7');
    });

    it('has no family view for a personal (non-household) receipt', async () => {
        const rid = await freshReceipt({ householdId: null, uploader: OWNER, lines: [[10, false]] });
        expect(await getFamilyReceiptView({ receiptId: rid, viewerUserId: OWNER })).toBeNull();
        expect(await getFamilyReceiptView({ receiptId: rid, viewerUserId: ALICE })).toBeNull();
    });

    it('lets a member adjust a family item (§3.3) but refuses a stranger', async () => {
        const { rid } = await setup();
        const okRes = await asUser(app, ALICE)
            .patch(`/api/receipts/${rid}/family/scope`)
            .send({ scope: 'personal', lineIdx: 1 });
        expect(okRes.status).toBe(200);
        expect(okRes.body.familySubtotalCents).toBe(1000);

        const bad = await asUser(app, STRANGER)
            .patch(`/api/receipts/${rid}/family/scope`)
            .send({ scope: 'personal', lineIdx: 0 });
        expect(bad.status).toBe(404);
    });

    it('rejects a malformed scope body', async () => {
        const { rid } = await setup();
        const alice = asUser(app, ALICE);
        expect((await alice.patch(`/api/receipts/${rid}/family/scope`).send({ scope: 'nope', lineIdx: 0 })).status).toBe(400);
        expect((await alice.patch(`/api/receipts/${rid}/family/scope`).send({ scope: 'personal' })).status).toBe(400);
        expect((await alice.patch(`/api/receipts/${rid}/family/scope`).send({ scope: 'personal', lineIdxs: [999] })).status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// §8 receipt deletion
// ---------------------------------------------------------------------------

describe('§8 a receipt counted into the ledger cannot be deleted', () => {
    it('refuses both the user hide and the dev hard purge', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });

        await expect(assertReceiptDeletable(rid)).rejects.toMatchObject({ status: 423 });

        const owner = asUser(app, OWNER);
        const hide = await owner.delete(`/api/receipts/${rid}/user`);
        expect(hide.status).toBe(423);
        expect(hide.body.error).toBe('receipt-counted-in-ledger');

        const purge = await owner.delete(`/api/receipts/${rid}`);
        expect(purge.status).toBe(423);

        // Still there, still counted.
        expect(await recordedAmount(hh, rid)).toBe(1000);
        const [rows]: any = await pool.query('SELECT userDeletedAt FROM Receipt WHERE id = ?', [rid]);
        expect(rows[0].userDeletedAt).toBeNull();
    });

    it('allows deletion of a family receipt that was never recorded', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false]] });
        await expect(assertReceiptDeletable(rid)).resolves.toBeUndefined();
        expect((await asUser(app, OWNER).delete(`/api/receipts/${rid}/user`)).status).toBe(200);
    });

    it('still allows the photo-only delete — dropping an image moves no money', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        expect((await asUser(app, OWNER).delete(`/api/receipts/${rid}/image`)).status).toBe(200);
        expect(await recordedAmount(hh, rid)).toBe(1000);
    });
});

// ---------------------------------------------------------------------------
// Guards on the ledger primitives themselves
// ---------------------------------------------------------------------------

describe('ledger guards', () => {
    it('refuses to restate a settlement-locked receipt even if called directly', async () => {
        const { restateReceiptRecorded } = await import('../src/models/householdLedgerModel.js');
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false], [6, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        const p = await proposeSettlement({ proposer: ALICE, from: ALICE, to: OWNER, amountCents: 800 });
        await confirmSettlement(OWNER, p.settlementId);

        await expect(restateReceiptRecorded({ householdId: hh, receiptId: rid, amountCents: 1000 }))
            .rejects.toThrow(/settlement-locked/);
        expect(await recordedAmount(hh, rid)).toBe(1600);
    });

    it('an appended settlement pair with an explicit earlier timestamp does not lock a later receipt', async () => {
        // Ordering is (at, id) — the fold's order — not id alone. A backdated
        // settlement must sort BEFORE a receipt recorded after it.
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[10, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        const past = new Date(Date.now() - 5 * HOUR_MS);
        await appendSettlementProposed({
            householdId: hh, settlementId: 'rfs-back-1', from: ALICE, to: OWNER,
            amountCents: 100, by: ALICE, at: past,
        });
        await appendSettlementConfirmed({
            householdId: hh, settlementId: 'rfs-back-1', by: OWNER, at: past,
        });
        // Inserted later (higher id) but timestamped earlier → does NOT lock.
        expect(await isReceiptSettlementLocked(hh, rid)).toBe(false);
    });
});
