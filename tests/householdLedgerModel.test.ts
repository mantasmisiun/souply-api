import { readFileSync } from 'fs';
import { resolve } from 'path';
import pool from '../src/config/db.js';
import {
    appendAdjustment,
    appendMemberJoined,
    appendMemberLeft,
    appendReceiptRecorded,
    appendSettlementConfirmed,
    appendSettlementProposed,
    getLedgerEvents,
    getLedgerState,
    isReceiptRecorded,
} from '../src/models/householdLedgerModel.js';
import { AUTO_CONFIRM_ACTOR, LedgerError } from '../src/services/householdLedger.js';

/**
 * The DB half of the ledger: that the append-only log round-trips through
 * MariaDB with the integer cents intact, that the write-time assertions fire
 * BEFORE anything lands, and that the at-most-once keys make a re-post a no-op.
 *
 * The suite applies sql/household_ledger.sql itself (idempotent
 * CREATE TABLE IF NOT EXISTS) rather than relying on tests/schema/schema.sql,
 * which is only loaded into a completely empty test DB — an already-bootstrapped
 * souply_test_ci would otherwise not have the new table.
 */

const HH = 990_001;   // FK-less schema: any household id works as a namespace.
const HH2 = 990_002;  // isolation check
const LAURA = 'laura-0000-0000-0000-000000000001';
const PETER = 'peter-0000-0000-0000-000000000002';
const JOHN = 'john0-0000-0000-0000-000000000003';

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const applyMigration = async (): Promise<void> => {
    const raw = readFileSync(resolve(process.cwd(), 'sql/household_ledger.sql'), 'utf8');
    const statements = raw
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
    for (const s of statements) await pool.query(s);
};

const wipe = async () => {
    await q('DELETE FROM HouseholdLedgerEvent WHERE householdId IN (?, ?)', [HH, HH2]);
};

beforeAll(async () => {
    await applyMigration();
    await wipe();
});

afterAll(async () => {
    await wipe();
    await (pool as any).end();
});

describe('household ledger log (append-only)', () => {
    it('round-trips every event type in log order and folds to the same state as the pure core', async () => {
        await appendMemberJoined({ householdId: HH, member: LAURA });
        await appendMemberJoined({ householdId: HH, member: PETER });
        await appendMemberJoined({ householdId: HH, member: JOHN });

        const r = await appendReceiptRecorded({
            householdId: HH, receiptId: 9001, payer: LAURA, amountCents: 1700,
            participants: [LAURA, PETER, JOHN],
        });
        expect((r as any).shares).toBeDefined();
        const shareTotal = Object.values((r as any).shares as Record<string, number>).reduce((s, v) => s + v, 0);
        expect(shareTotal).toBe(1700);

        await appendAdjustment({
            householdId: HH, receiptId: 9001, reason: 'Coffee → personal',
            deltaByMember: { [LAURA]: -200, [PETER]: 100, [JOHN]: 100 }, actorUserId: LAURA,
        });
        await appendSettlementProposed({
            householdId: HH, settlementId: 'sm-1', from: PETER, to: LAURA, amountCents: 100, by: PETER,
        });
        await appendSettlementConfirmed({ householdId: HH, settlementId: 'sm-1', by: LAURA });
        await appendMemberLeft({ householdId: HH, member: JOHN });

        const events = await getLedgerEvents(HH);
        expect(events).toHaveLength(8);
        expect(events.map((e) => e.type)).toEqual([
            'member_joined', 'member_joined', 'member_joined', 'receipt_recorded',
            'adjustment', 'settlement_proposed', 'settlement_confirmed', 'member_left',
        ]);
        // Ids strictly increasing — the log has a total order.
        for (let i = 1; i < events.length; i++) expect(events[i].id).toBeGreaterThan(events[i - 1].id);

        const state = await getLedgerState(HH);
        expect(Object.values(state.balances).reduce((s, v) => s + v, 0)).toBe(0);
        expect(state.activeMembers).toEqual([LAURA, PETER]); // JOHN left
        expect(state.balances[JOHN]).toBeDefined();          // ...but keeps his balance row
        expect(state.confirmedSettlementIds).toEqual(['sm-1']);
        expect(state.pendingSettlements).toHaveLength(0);
        // Cents survived the JSON round-trip as integers, not strings or floats.
        for (const m of Object.keys(state.balances)) expect(Number.isInteger(state.balances[m])).toBe(true);
    });

    it('keeps households isolated', async () => {
        await appendMemberJoined({ householdId: HH2, member: LAURA });
        await appendReceiptRecorded({
            householdId: HH2, receiptId: 9001, payer: LAURA, amountCents: 500, participants: [LAURA],
        });
        const other = await getLedgerEvents(HH2);
        expect(other).toHaveLength(2);
        // The same receiptId in another household is a separate event, not a dupe.
        expect(await getLedgerEvents(HH)).toHaveLength(8);
    });

    it('re-posting the same receipt is a NO-OP that returns the stored shares', async () => {
        const first = await appendReceiptRecorded({
            householdId: HH, receiptId: 9002, payer: PETER, amountCents: 1000,
            participants: [LAURA, PETER, JOHN],
        });
        const before = await getLedgerState(HH);

        const again = await appendReceiptRecorded({
            householdId: HH, receiptId: 9002, payer: PETER, amountCents: 1000,
            participants: [LAURA, PETER, JOHN],
        });
        expect(again.id).toBe(first.id);
        expect((again as any).shares).toEqual((first as any).shares);

        const after = await getLedgerState(HH);
        expect(after.balances).toEqual(before.balances); // not double-counted
        const [rows]: any = await pool.query(
            "SELECT COUNT(*) AS n FROM HouseholdLedgerEvent WHERE householdId = ? AND receiptId = 9002 AND type = 'receipt_recorded'",
            [HH],
        );
        expect(Number(rows[0].n)).toBe(1);
        expect(await isReceiptRecorded(HH, 9002)).toBe(true);
        expect(await isReceiptRecorded(HH, 4242)).toBe(false);
    });

    it('a double confirm moves the money once', async () => {
        await appendSettlementProposed({
            householdId: HH, settlementId: 'sm-2', from: LAURA, to: PETER, amountCents: 250, by: LAURA,
        });
        const pending = await getLedgerState(HH);
        expect(pending.pendingSettlements.map((p) => p.settlementId)).toEqual(['sm-2']);

        const c1 = await appendSettlementConfirmed({ householdId: HH, settlementId: 'sm-2', by: PETER });
        const afterFirst = await getLedgerState(HH);
        const c2 = await appendSettlementConfirmed({ householdId: HH, settlementId: 'sm-2', by: AUTO_CONFIRM_ACTOR });
        expect(c2.id).toBe(c1.id);
        expect((await getLedgerState(HH)).balances).toEqual(afterFirst.balances);
    });

    it('the write-time assertions THROW and nothing lands', async () => {
        const before = (await getLedgerEvents(HH)).length;

        // Float money.
        await expect(appendReceiptRecorded({
            householdId: HH, receiptId: 9101, payer: LAURA, amountCents: 10.5, participants: [LAURA, PETER],
        })).rejects.toThrow(LedgerError);

        // No participants.
        await expect(appendReceiptRecorded({
            householdId: HH, receiptId: 9102, payer: LAURA, amountCents: 100, participants: [],
        })).rejects.toThrow(/at least one participant/);

        // Adjustment that creates money.
        await expect(appendAdjustment({
            householdId: HH, receiptId: 9001, reason: 'bad', deltaByMember: { [LAURA]: 100, [PETER]: -50 },
        })).rejects.toThrow(/must sum to zero/);

        // Confirming a settlement nobody proposed.
        await expect(appendSettlementConfirmed({
            householdId: HH, settlementId: 'never-proposed', by: PETER,
        })).rejects.toThrow(/no proposal/);

        // Settlement with a non-positive amount / one party.
        await expect(appendSettlementProposed({
            householdId: HH, settlementId: 'sm-bad', from: LAURA, to: PETER, amountCents: 0, by: LAURA,
        })).rejects.toThrow(LedgerError);
        await expect(appendSettlementProposed({
            householdId: HH, settlementId: 'sm-bad2', from: LAURA, to: LAURA, amountCents: 100, by: LAURA,
        })).rejects.toThrow(/two distinct parties/);

        expect((await getLedgerEvents(HH)).length).toBe(before);
        expect(Object.values((await getLedgerState(HH)).balances).reduce((s, v) => s + v, 0)).toBe(0);
    });

    it('exports no update or delete path', async () => {
        const model = await import('../src/models/householdLedgerModel.js');
        const mutators = Object.keys(model).filter((k) => /update|delete|remove|reset/i.test(k));
        expect(mutators).toEqual([]);
    });
});
