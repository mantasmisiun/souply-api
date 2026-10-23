import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { createHousehold, joinHousehold } from '../src/models/householdModel.js';
import { getLedgerEvents } from '../src/models/householdLedgerModel.js';
import { recordFamilyReceipt, requestLeaveHousehold } from '../src/services/householdMembership.js';
import { confirmSettlement, proposeSettlement } from '../src/services/householdSettlements.js';
import { replaceReceiptItems, computeFamilySubtotalCents } from '../src/models/receiptItemModel.js';
import { setReceiptItemScope } from '../src/services/receiptFamilyScope.js';

/**
 * FAMILY SHOPPING §5.2 — the history feed.
 *
 * Three things are being pinned here, in descending order of how badly they
 * would hurt if they broke:
 *   §4.5  the feed exposes NO receipt grand total, no savedAmount and no
 *         personal item — the family subtotal is visible by design, so a grand
 *         total anywhere gives personal spend away by subtraction.
 *   §3.2.1  a settlement enters the history only once CONFIRMED. A proposal is
 *         one signature of two and moves no money.
 *   pagination is STABLE — the feed's order is the exact reverse of the fold's
 *         (`at ASC, id ASC`), and walking it in pages must produce that order
 *         with no duplicate and no gap, including when events share a
 *         millisecond.
 */

const OWNER = 'hhh-owner-0000-0000-000000000001';
const ALICE = 'hhh-alice-0000-0000-000000000002';
const BOB = 'hhh-bob00-0000-0000-000000000003';
/** In no household at all. */
const STRANGER = 'hhh-stran-0000-0000-000000000004';
/** Owns a DIFFERENT household — the cross-household read. */
const OUTSIDER = 'hhh-outsi-0000-0000-000000000005';
const ALL_USERS = [OWNER, ALICE, BOB, STRANGER, OUTSIDER];

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

/** A real receipt on a family trip. `printedTotal`/`savedAmount` are the grand-
 *  total-shaped values §4.5 forbids: they exist here so a leak would be caught. */
const freshReceipt = async (args: {
    householdId: number;
    uploader: string;
    /** `[grossEuros, isPersonal]` per line. */
    lines: [number, boolean][];
    printedTotal?: number;
    savedAmount?: number;
}): Promise<number> => {
    const t = await q(
        'INSERT INTO Trip (createdByUserId, householdId, isAdHoc) VALUES (?,?,1)',
        [args.uploader, args.householdId]);
    const tripId = Number(t.insertId);
    createdTrips.push(tripId);
    const parsed = JSON.stringify({
        header: {}, products: [],
        footer: { total: args.printedTotal ?? 99.99, totalSavings: 1.23, comboDiscount: 0 },
    });
    const r = await q(
        `INSERT INTO Receipt (userId, uploaderUserId, tripId, filePath, fileType,
                              processingStatus, receiptDate, parsedData, savedAmount)
         VALUES (?,?,?,?, 'jpg', 'done', NOW(), ?, ?)`,
        [args.uploader, args.uploader, tripId, `receipts/hhh-${Date.now()}-${Math.random()}.jpg`,
            parsed, args.savedAmount ?? 7.77],
    );
    const receiptId = Number(r.insertId);
    createdReceipts.push(receiptId);
    await replaceReceiptItems(receiptId, args.lines.map(([price, isPersonal], i) => ({
        name: `Item ${i}`, price, quantity: 1, isPersonal,
    })));
    return receiptId;
};

const feed = async (user: string, query = '') =>
    asUser(app, user).get(`/api/households/mine/history${query}`);

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
    if (createdHouseholds.length) {
        await q('DELETE FROM HouseholdLedgerEvent WHERE householdId IN (?)', [createdHouseholds]);
        createdHouseholds.length = 0;
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
        await q(
            'INSERT INTO User (id, isAdmin, points, displayName) VALUES (?,0,0,?) '
            + 'ON DUPLICATE KEY UPDATE points=0, displayName=VALUES(displayName)',
            [u, u.slice(4, 9)]);
    }
    await cleanAll();
});

afterEach(cleanAll);

afterAll(async () => {
    await cleanAll();
    for (const u of ALL_USERS) await q('DELETE FROM User WHERE id = ?', [u]);
    await (pool as any).end();
});

// ---------------------------------------------------------------------------
// Who may read it
// ---------------------------------------------------------------------------

describe('access', () => {
    it('a member reads their household\'s feed', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const res = await feed(ALICE);
        expect(res.status).toBe(200);
        expect(res.body.householdId).toBe(hh);
        // Two joins already happened: the founder (§3.5) and ALICE.
        expect(res.body.entries.map((e: any) => e.kind)).toEqual(['member_joined', 'member_joined']);
    });

    it('a user in NO household is refused (404)', async () => {
        await freshHousehold(OWNER, [ALICE]);
        const res = await feed(STRANGER);
        expect(res.status).toBe(404);
    });

    it('unauthenticated is refused', async () => {
        await freshHousehold(OWNER);
        const { default: supertest } = await import('supertest');
        const res = await supertest(app).get('/api/households/mine/history');
        expect(res.status).toBe(401);
    });

    it('a member of ANOTHER household never sees this one\'s events', async () => {
        const mine = await freshHousehold(OWNER, [ALICE]);
        const theirs = await freshHousehold(OUTSIDER);
        const rid = await freshReceipt({ householdId: mine, uploader: OWNER, lines: [[20, false]] });
        await recordFamilyReceipt({ householdId: mine, receiptId: rid, payer: OWNER });

        const res = await feed(OUTSIDER);
        expect(res.status).toBe(200);
        // Self-scoped: they get THEIR household, never the one in the URL —
        // there is no household id in the URL to point elsewhere.
        expect(res.body.householdId).toBe(theirs);
        expect(res.body.entries.every((e: any) => e.kind === 'member_joined')).toBe(true);
        expect(res.body.entries.some((e: any) => e.receiptId === rid)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// §4.5 — the amounts are safe BY CONSTRUCTION; prove it rather than assume it
// ---------------------------------------------------------------------------

describe('§4.5 no grand total can leak', () => {
    it('a receipt entry carries the FAMILY subtotal, not the receipt total', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        // €10 family + €4 personal; the printed grand total says €99.99.
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER,
            lines: [[10, false], [4, true]], printedTotal: 99.99, savedAmount: 7.77,
        });
        expect(await computeFamilySubtotalCents(rid)).toBe(1000);
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });

        const res = await feed(ALICE);
        const receiptEntry = res.body.entries.find((e: any) => e.kind === 'receipt');
        expect(receiptEntry.amountCents).toBe(1000);
        expect(receiptEntry.receiptId).toBe(rid);
    });

    it('the serialised response contains no grand-total-shaped field at all', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER,
            lines: [[10, false], [4, true]], printedTotal: 99.99, savedAmount: 7.77,
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });

        const res = await feed(ALICE);
        const body = JSON.stringify(res.body);
        // The printed grand total, as a euro figure.
        expect(body).not.toContain('99.99');
        // The columns/blobs that carry or reconstruct it. `savedAmount` is the
        // one that would have ridden in unnoticed on a `SELECT r.*`.
        for (const forbidden of [
            'savedAmount', 'parsedData', 'footer', 'totalSavings', 'comboDiscount',
            'filePath', 'isPersonal', 'grandTotal',
        ]) {
            expect(body).not.toContain(forbidden);
        }
        // No personal item by name...
        expect(body).not.toContain('Item 1');
        // ...and no money value anywhere except the family subtotal: not the
        // grand total (9999), not the personal remainder (400). Checked on the
        // fields rather than the raw string, which would collide with ids.
        const amounts = res.body.entries.map((e: any) => e.amountCents);
        expect(amounts.filter((v: any) => v != null)).toEqual([1000]);
    });

    it('exposes no count of personal items either', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER,
            lines: [[10, false], [4, true], [6, true]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        const res = await feed(ALICE);
        const entry = res.body.entries.find((e: any) => e.kind === 'receipt');
        expect(Object.keys(entry).sort()).toEqual([
            'actor', 'amountCents', 'at', 'chainName', 'counterparty', 'deltaByMember',
            'id', 'kind', 'reason', 'receiptId', 'settlementId', 'storeName', 'subtitle', 'title',
        ]);
    });
});

// ---------------------------------------------------------------------------
// §3.2.1 — settlements
// ---------------------------------------------------------------------------

describe('§3.2.1 a settlement appears only once confirmed', () => {
    const setUpDebt = async (): Promise<number> => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[20, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        return hh;
    };

    it('a PROPOSED settlement is absent from the history', async () => {
        await setUpDebt();
        // ALICE owes OWNER €10 of the €20 receipt.
        const proposal = await proposeSettlement({
            proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000,
        });
        expect(proposal.settlementId).toBeTruthy();

        const res = await feed(ALICE);
        expect(res.body.entries.some((e: any) => e.kind === 'settlement')).toBe(false);
        // It IS visible as live state on the settlements read — just not as history.
        const live = await asUser(app, ALICE).get('/api/households/mine/settlements');
        expect(live.body.pendingSettlements).toHaveLength(1);
    });

    it('confirming it produces exactly ONE entry, with both parties and the amount', async () => {
        await setUpDebt();
        const proposal = await proposeSettlement({
            proposer: ALICE, from: ALICE, to: OWNER, amountCents: 1000,
        });
        await confirmSettlement(OWNER, proposal.settlementId);

        const res = await feed(ALICE);
        const settlements = res.body.entries.filter((e: any) => e.kind === 'settlement');
        expect(settlements).toHaveLength(1);
        expect(settlements[0]).toMatchObject({
            amountCents: 1000,
            settlementId: proposal.settlementId,
            actor: { userId: ALICE },
            counterparty: { userId: OWNER },
        });
        expect(settlements[0].title).toContain('atsiskaitė su');
    });
});

// ---------------------------------------------------------------------------
// The other event kinds §5.2 asks for
// ---------------------------------------------------------------------------

describe('§5.2 the kinds the tab renders', () => {
    it('a departure appears as its own entry', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        // BOB joins after the receipt, so his balance is zero and he leaves at once.
        const rid = await freshReceipt({ householdId: hh, uploader: OWNER, lines: [[20, false]] });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        await joinHousehold(hh, BOB);
        const outcome = await requestLeaveHousehold(BOB);
        expect(outcome?.status).toBe('departed');

        const res = await feed(ALICE);
        const left = res.body.entries.filter((e: any) => e.kind === 'member_left');
        expect(left).toHaveLength(1);
        expect(left[0].actor.userId).toBe(BOB);
        expect(left[0].amountCents).toBeNull();
        // Newest first: the departure is the most recent thing that happened.
        expect(res.body.entries[0].kind).toBe('member_left');
    });

    it('a post-lock re-categorisation appears as a visible adjustment (§4.4)', async () => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const rid = await freshReceipt({
            householdId: hh, uploader: OWNER, lines: [[10, false], [4, false]],
        });
        await recordFamilyReceipt({ householdId: hh, receiptId: rid, payer: OWNER });
        // Past the 72 h backstop → the toggle must emit an adjustment.
        await q('UPDATE Receipt SET uploadedAt = DATE_SUB(NOW(), INTERVAL 100 HOUR) WHERE id = ?', [rid]);
        const result = await setReceiptItemScope({
            receiptId: rid, actorUserId: ALICE, lineIdxs: [1], isPersonal: true,
        });
        expect(result.ledger).toBe('adjusted');

        const res = await feed(OWNER);
        const adj = res.body.entries.find((e: any) => e.kind === 'adjustment');
        expect(adj.actor.userId).toBe(ALICE);
        expect(adj.reason).toContain('to-personal');
        // The restated FAMILY subtotal (€14 → €10), never a grand total.
        expect(adj.amountCents).toBe(1000);
        expect(Object.values(adj.deltaByMember).reduce((a: any, b: any) => a + b, 0)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination', () => {
    /** Six receipts sharing ONE millisecond, so ordering rests on `id` alone. */
    const sameInstantLog = async (): Promise<number> => {
        const hh = await freshHousehold(OWNER, [ALICE]);
        const at = new Date();
        for (let i = 0; i < 6; i++) {
            await recordFamilyReceipt({
                householdId: hh, receiptId: 880_100 + i, payer: OWNER, amountCents: 500, at,
            });
        }
        return hh;
    };

    const walk = async (user: string, limit: number): Promise<any[]> => {
        const all: any[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 50; guard++) {
            const res: any = await feed(user, `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            expect(res.status).toBe(200);
            expect(res.body.entries.length).toBeLessThanOrEqual(limit);
            all.push(...res.body.entries);
            cursor = res.body.nextCursor;
            if (!cursor) return all;
        }
        throw new Error('cursor never terminated');
    };

    it('is the exact reverse of the fold order, in one page or many', async () => {
        const hh = await sameInstantLog();
        const foldOrder = (await getLedgerEvents(hh)).map(e => e.id);

        const single = await feed(OWNER, '?limit=50');
        expect(single.body.nextCursor).toBeNull();
        expect(single.body.entries.map((e: any) => e.id)).toEqual([...foldOrder].reverse());

        const paged = await walk(OWNER, 2);
        expect(paged.map((e: any) => e.id)).toEqual([...foldOrder].reverse());
    });

    it('walking in pages loses nothing and repeats nothing', async () => {
        await sameInstantLog();
        for (const size of [1, 2, 3, 5]) {
            const ids = (await walk(ALICE, size)).map((e: any) => e.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids).toEqual([...ids].sort((a, b) => b - a));
            // 6 receipts + 2 joins.
            expect(ids).toHaveLength(8);
        }
    });

    it('clamps limit and survives a junk cursor', async () => {
        await sameInstantLog();
        const big = await feed(OWNER, '?limit=999');
        expect(big.status).toBe(200);
        expect(big.body.entries.length).toBeLessThanOrEqual(50);

        const junk = await feed(OWNER, '?limit=abc&cursor=not-a-cursor');
        expect(junk.status).toBe(200);
        // A cursor the client cannot fix restarts the feed rather than 500ing.
        expect(junk.body.entries).toHaveLength(8);
    });
});
