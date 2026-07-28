import pool from '../src/config/db.js';
import { createTrip } from '../src/models/tripModel.js';
import { getTripBasketComparison } from '../src/services/tripBasketComparison.js';

/**
 * TRIP-LEVEL SUTAUPYTA — "what if I'd bought everything in one shop?"
 *
 * The per-receipt comparison can't answer that on a split trip: each receipt is
 * only ever priced against alternatives for its OWN items, so nothing ever holds
 * the whole basket. This service unions every receipt line of the trip and
 * prices that one basket at each nearby store — the visited ones included,
 * because "all of it at IKI alone" is the comparison a two-store trip is asking
 * for.
 *
 * Product decision pinned here: a store that CAN'T price an item does not get a
 * partial-coverage label and is not pushed down the list — the item is carried at
 * what the user paid, so every bar prices the same basket and stays comparable.
 */

const USER = 'tripcmp-aaaa-aaaa-aaaa-aaaaaaaa';
const CAT = 990801;
const CH_A = 99081, CH_B = 99082;
const ST_A = 990811, ST_B = 990821;
const P1 = 990831, P2 = 990832, P3 = 990833, P4 = 990834;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const mkReceipt = async (tripId: number, storeId: number): Promise<number> => {
    const r = await q(
        `INSERT INTO Receipt (userId, storeId, filePath, receiptDate, tripId, processingStatus,
                              mandatorySwipesRequired, mandatorySwipesCompleted)
         VALUES (?,?,?,NOW(),?, 'completed', 0, 0)`, [USER, storeId, 'test://r.jpg', tripId]);
    return Number(r.insertId);
};
let lineIdx = 0;
const mkLine = async (receiptId: number, spId: number | null, name: string, price: number, qty = 1) =>
    q(`INSERT INTO ReceiptItem (receiptId, lineIdx, name, price, quantity, matchedSpId) VALUES (?,?,?,?,?,?)`,
        [receiptId, lineIdx++, name, price, qty, spId]);

/** productId → its StoreProduct id at a given chain's store. */
const spIds = new Map<string, number>();

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO Category (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [CAT, 'cmp-test']);
    for (const [id, name] of [[CH_A, 'CmpChain A'], [CH_B, 'CmpChain B']] as [number, string][]) {
        await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [id, name]);
    }
    // Two stores, ~0 km apart, so both are "nearby" candidates.
    await q(`INSERT INTO Store (id, chainId, name, address, latitude, longitude) VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE latitude=VALUES(latitude)`, [ST_A, CH_A, 'Cmp A', 'X 1', 55.9, 23.3]);
    await q(`INSERT INTO Store (id, chainId, name, address, latitude, longitude) VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE latitude=VALUES(latitude)`, [ST_B, CH_B, 'Cmp B', 'X 2', 55.9, 23.3]);

    for (const [pid, nm] of [[P1, 'Cmp Milk'], [P2, 'Cmp Bread'], [P3, 'Cmp Cheese'], [P4, 'Cmp Nowhere']] as [number, string][]) {
        await q('INSERT INTO Product (id, name, categoryId) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
            [pid, nm, CAT]);
    }
    // StoreProduct is CHAIN-scoped; prices live per STORE in Price.
    // Chain A sells all three; chain B is missing P3 entirely (the carry case).
    const mkSp = async (chainId: number, storeId: number, productId: number, price: number, key: string) => {
        const r = await q(
            `INSERT INTO StoreProduct (chainId, productId, storeProductName, isWeighable)
             VALUES (?,?,?,0)`, [chainId, productId, `sp-${productId}-${chainId}`]);
        const spId = Number(r.insertId);
        await q('INSERT INTO Price (storeProductId, storeId, price, isFallback) VALUES (?,?,?,0)',
            [spId, storeId, price]);
        spIds.set(key, spId);
    };
    await mkSp(CH_A, ST_A, P1, 1.00, 'a1');
    await mkSp(CH_A, ST_A, P2, 2.00, 'a2');
    await mkSp(CH_A, ST_A, P3, 3.00, 'a3');
    await mkSp(CH_B, ST_B, P1, 0.50, 'b1');
    await mkSp(CH_B, ST_B, P2, 1.00, 'b2');
    // P4 exists as a product with a chain-A listing but NO price anywhere — the
    // only case nothing can price, so the paid-price carry is what's left.
    const noPrice = await q(
        `INSERT INTO StoreProduct (chainId, productId, storeProductName, isWeighable) VALUES (?,?,?,0)`,
        [CH_A, P4, 'sp-nowhere']);
    spIds.set('a4', Number(noPrice.insertId));
});

afterAll(async () => {
    await q('DELETE ri FROM ReceiptItem ri JOIN Receipt r ON r.id = ri.receiptId WHERE r.userId = ?', [USER]);
    await q('DELETE FROM Receipt WHERE userId = ?', [USER]);
    await q('DELETE FROM TripComparisonSnapshot WHERE tripId IN (SELECT id FROM Trip WHERE createdByUserId = ?)', [USER]);
    await q('DELETE FROM TripMember WHERE userId = ?', [USER]);
    await q('DELETE FROM Trip WHERE createdByUserId = ?', [USER]);
    await q('DELETE p FROM Price p JOIN StoreProduct sp ON sp.id = p.storeProductId WHERE sp.chainId IN (?,?)', [CH_A, CH_B]);
    await q('DELETE FROM StoreProduct WHERE chainId IN (?,?)', [CH_A, CH_B]);
    await q('DELETE FROM Product WHERE id IN (?,?,?,?)', [P1, P2, P3, P4]);
    await q('DELETE FROM Store WHERE id IN (?,?)', [ST_A, ST_B]);
    await q('DELETE FROM StoreChain WHERE id IN (?,?)', [CH_A, CH_B]);
    await q('DELETE FROM Category WHERE id = ?', [CAT]);
    await (pool as any).end();
});

describe('getTripBasketComparison', () => {
    it('splits your spend by store — the segmented bar', async () => {
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        const rB = await mkReceipt(trip, ST_B);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 1.20);
        await mkLine(rB, spIds.get('b2')!, 'Bread', 0.80);

        const cmp = await getTripBasketComparison(trip);
        expect(cmp.paidTotal).toBeCloseTo(2.00, 2);
        expect(cmp.segments).toHaveLength(2);
        expect(cmp.segments.map(s => s.total).sort()).toEqual([0.80, 1.20]);
        // Widest segment first — the bar renders in that order.
        expect(cmp.segments[0].total).toBe(1.20);
    });

    it('prices the WHOLE basket at each candidate, visited stores included', async () => {
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 1.20);
        await mkLine(rA, spIds.get('a2')!, 'Bread', 2.50);

        const cmp = await getTripBasketComparison(trip);
        const a = cmp.candidates.find(c => c.chainId === CH_A);
        const b = cmp.candidates.find(c => c.chainId === CH_B);
        expect(a?.visited).toBe(true);
        // The VISITED chain is priced from the till (1.20 + 2.50), not the
        // catalogue — you have better information about that shop than the
        // catalogue does.
        expect(a?.total).toBeCloseTo(3.70, 2);
        expect(b?.total).toBeCloseTo(1.50, 2);   // 0.50 + 1.00 catalogue
        expect(cmp.bestSingleTotal).toBeCloseTo(1.50, 2);
    });

    it('an item a chain does not stock is AVERAGED from the chains that do', async () => {
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 1.20);
        await mkLine(rA, spIds.get('a3')!, 'Cheese', 4.00);   // chain B doesn't stock it

        const cmp = await getTripBasketComparison(trip);
        const b = cmp.candidates.find(c => c.chainId === CH_B)!;
        // 0.50 milk + 3.00 cheese (cross-chain average). No carry needed: the
        // engine COULD price it, which is the better answer than assuming.
        expect(b.total).toBeCloseTo(3.50, 2);
        expect(b.carriedItems).toBe(0);
    });

    it('THE RULE: an item nothing can price is carried at what you paid — never dropped', async () => {
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 1.20);
        await mkLine(rA, spIds.get('a4')!, 'Nowhere', 4.00);  // no price exists anywhere

        const cmp = await getTripBasketComparison(trip);
        for (const c of cmp.candidates) {
            // Every bar prices the same basket: whatever it can, plus the 4.00
            // you actually paid for the item it can't.
            expect(c.total).toBeGreaterThanOrEqual(4.00);
            // The chain you SHOPPED knows the price — it charged it. Only the
            // others have to carry it.
            expect(c.carriedItems).toBe(c.visited ? 0 : 1);
        }
        // …and no bar is demoted for it: ordering is purely by total.
        const totals = cmp.candidates.map(c => c.total);
        expect([...totals].sort((x, y) => x - y)).toEqual(totals);
    });

    it('lines with no product identity count in your total and in every bar equally', async () => {
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 1.20);
        await mkLine(rA, null, 'Unmatched thing', 2.00);

        const cmp = await getTripBasketComparison(trip);
        expect(cmp.unmatchedLineCount).toBe(1);
        expect(cmp.unmatchedLineTotal).toBeCloseTo(2.00, 2);
        expect(cmp.paidTotal).toBeCloseTo(3.20, 2);
        // Every candidate carries the same unpriceable 2.00, so the comparison
        // between them is unaffected and none looks artificially cheap.
        for (const c of cmp.candidates) expect(c.total).toBeGreaterThanOrEqual(2.00);
    });

    it('one bar per chain — the visited branch represents its chain', async () => {
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 1.20);
        const cmp = await getTripBasketComparison(trip);
        const chainIds = cmp.candidates.map(c => c.chainId);
        expect(new Set(chainIds).size).toBe(chainIds.length);
        expect(cmp.candidates.find(c => c.chainId === CH_A)?.visited).toBe(true);
    });

    it('quantities of the same product across receipts fold into one line', async () => {
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        const rB = await mkReceipt(trip, ST_B);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 1.20, 1);
        await mkLine(rB, spIds.get('b1')!, 'Milk', 0.60, 2);

        const cmp = await getTripBasketComparison(trip);
        expect(cmp.itemCount).toBe(1);                       // one product, 3 units
        expect(cmp.paidTotal).toBeCloseTo(2.40, 2);          // 1.20 + 2×0.60
        const b = cmp.candidates.find(c => c.chainId === CH_B)!;
        // Chain B charged 0.60/unit for the two bought there; the third unit is
        // priced at that same rate rather than at the catalogue's 0.50.
        expect(b.total).toBeCloseTo(1.80, 2);
    });

    it('TWO RECEIPTS FROM THE SAME CHAIN ARE ONE SHOP', async () => {
        // You went back for what you forgot — that's one store visit, not two,
        // so the spend bar must show a single segment.
        const trip = await createTrip(USER, {});
        const first = await mkReceipt(trip, ST_A);
        const second = await mkReceipt(trip, ST_A);
        await mkLine(first, spIds.get('a1')!, 'Milk', 1.20);
        await mkLine(second, spIds.get('a2')!, 'Bread', 0.80);

        const cmp = await getTripBasketComparison(trip);
        expect(cmp.segments).toHaveLength(1);
        expect(cmp.segments[0].total).toBeCloseTo(2.00, 2);
    });

    it("a visited chain's bar reproduces the receipt — till prices beat the catalogue", async () => {
        // The catalogue doesn't know the promo you were given, so "IKI alone"
        // priced an IKI-only trip ABOVE the IKI receipt it was built from.
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 0.60);      // catalogue says 1.00
        await mkLine(rA, spIds.get('a2')!, 'Bread', 1.50);     // catalogue says 2.00

        const cmp = await getTripBasketComparison(trip);
        const a = cmp.candidates.find(c => c.chainId === CH_A)!;
        expect(cmp.paidTotal).toBeCloseTo(2.10, 2);
        expect(a.total).toBeCloseTo(2.10, 2);                  // to the cent
        // (chain B is genuinely cheaper here, so the trip still has headroom —
        // the point is that YOUR store's bar can't disagree with your receipt.)
    });

    it('units bought elsewhere are priced at the visited rate', async () => {
        // 1 at chain A (0.60 paid), 2 more at chain B. Chain A's bar = the 0.60
        // it charged + 2 more at that same rate.
        const trip = await createTrip(USER, {});
        const rA = await mkReceipt(trip, ST_A);
        const rB = await mkReceipt(trip, ST_B);
        await mkLine(rA, spIds.get('a1')!, 'Milk', 0.60, 1);
        await mkLine(rB, spIds.get('b1')!, 'Milk', 0.40, 2);

        const cmp = await getTripBasketComparison(trip);
        const a = cmp.candidates.find(c => c.chainId === CH_A)!;
        expect(a.total).toBeCloseTo(1.80, 2);                  // 3 × 0.60
    });

    it('a trip with no receipts is empty, not an error', async () => {
        const trip = await createTrip(USER, {});
        const cmp = await getTripBasketComparison(trip);
        expect(cmp).toMatchObject({ paidTotal: 0, candidates: [], bestSingleTotal: null });
    });
});
