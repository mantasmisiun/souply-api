import pool from '../src/config/db.js';
import { createBasket } from '../src/models/basketModel.js';
import {
    getBasketQuantitiesByBasketId,
    upsertBasketItemByProduct,
    getBasketItemByBasketAndProduct,
} from '../src/models/basketItemModel.js';

/**
 * THE STEPPER'S ROUND TRIP.
 *
 * Every ± tap used to cost the client TWO requests: GET /baskets/:id/items (the
 * heaviest read in the basket API — localized names, image aggregates, canonical
 * units, the user's product scores and a p80 percentile over Product) purely to
 * translate productId → basketItem id, then a PUT on that id. Addressing the row
 * by PRODUCT makes a step one call, and `quantities` answers "Add or stepper?"
 * without any of that payload.
 */

const USER = 'basqty-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CAT = 990601;
const P1 = 990611;
const P2 = 990612;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO Category (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [CAT, 'qty-test']);
    for (const [id, name] of [[P1, 'Qty test A'], [P2, 'Qty test B']] as [number, string][]) {
        await q('INSERT INTO Product (id, name, categoryId) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
            [id, name, CAT]);
    }
});

afterAll(async () => {
    await q('DELETE FROM BasketItem WHERE productId IN (?,?)', [P1, P2]);
    await q('DELETE FROM Basket WHERE userId = ?', [USER]);
    await q('DELETE FROM Product WHERE id IN (?,?)', [P1, P2]);
    await q('DELETE FROM Category WHERE id = ?', [CAT]);
    await (pool as any).end();
});

describe('upsertBasketItemByProduct', () => {
    it('creates the line when the product is not in the basket yet', async () => {
        const basketId = await createBasket(USER);
        const r = await upsertBasketItemByProduct(basketId, P1, 2);
        expect(r.created).toBe(true);
        expect(r.quantity).toBe(2);
        expect(r.remaining).toBe(1);
        expect(r.id).not.toBeNull();
    });

    it('updates in place on the next step — no duplicate row', async () => {
        const basketId = await createBasket(USER);
        const first = await upsertBasketItemByProduct(basketId, P1, 1);
        const second = await upsertBasketItemByProduct(basketId, P1, 3);
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
        expect(second.quantity).toBe(3);
        expect(second.remaining).toBe(1);
        const row = await getBasketItemByBasketAndProduct(basketId, P1);
        expect(parseFloat(row.quantity)).toBe(3);
    });

    it('quantity 0 removes the line and reports what is left', async () => {
        const basketId = await createBasket(USER);
        await upsertBasketItemByProduct(basketId, P1, 1);
        await upsertBasketItemByProduct(basketId, P2, 1);
        const r = await upsertBasketItemByProduct(basketId, P1, 0);
        expect(r.id).toBeNull();
        expect(r.quantity).toBe(0);
        // The caller tears the basket down when this hits 0 — so it has to be right.
        expect(r.remaining).toBe(1);
        expect(await getBasketItemByBasketAndProduct(basketId, P1)).toBeNull();
    });

    it('removing the last line reports remaining 0', async () => {
        const basketId = await createBasket(USER);
        await upsertBasketItemByProduct(basketId, P1, 1);
        expect((await upsertBasketItemByProduct(basketId, P1, 0)).remaining).toBe(0);
    });

    it('keeps fractional (weighed) quantities intact', async () => {
        const basketId = await createBasket(USER);
        await upsertBasketItemByProduct(basketId, P1, 0.35);
        const row = await getBasketItemByBasketAndProduct(basketId, P1);
        expect(parseFloat(row.quantity)).toBeCloseTo(0.35, 3);
    });

    it('honours matchMode on create', async () => {
        const basketId = await createBasket(USER);
        await upsertBasketItemByProduct(basketId, P1, 1, 'base');
        const row = await getBasketItemByBasketAndProduct(basketId, P1);
        expect(row.matchMode).toBe('base');
    });
});

describe('getBasketQuantitiesByBasketId', () => {
    it('returns productId → quantity, and nothing else', async () => {
        const basketId = await createBasket(USER);
        await upsertBasketItemByProduct(basketId, P1, 2);
        await upsertBasketItemByProduct(basketId, P2, 0.5);
        const map = await getBasketQuantitiesByBasketId(basketId);
        expect(map).toEqual({ [P1]: 2, [P2]: 0.5 });
    });

    it('an empty basket is an empty map, not a throw', async () => {
        const basketId = await createBasket(USER);
        expect(await getBasketQuantitiesByBasketId(basketId)).toEqual({});
    });
});
