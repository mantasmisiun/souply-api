import app from '../src/index.js';
import pool from '../src/config/db.js';
import { asUser, primeTokens } from './helpers/authedRequest.js';

/**
 * Pantry items and the moment the shopper decides about them.
 *
 * A recipe keeps its staples for good — salt is part of the recipe whether or
 * not the cupboard has any today. What changes trip to trip is whether this
 * BASKET needs them, so the keep-or-drop choice belongs to instantiation.
 *
 * The rule with teeth: only a PANTRY item may be dropped this way. A request
 * naming an ordinary ingredient is ignored, so a stale client (or a hostile
 * one) cannot quietly empty a basket by listing every product id.
 */

const USER = 'pantrysk-aaaa-bbbb-cccc-dddddddddddd';
const CAT = 990440;
const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

const ids: Record<string, number> = {};
let templateId = 0;

const addProduct = async (name: string): Promise<number> => {
    const p = await q(`INSERT INTO Product (categoryId, name) VALUES (?, ?)`, [CAT, name]);
    return Number(p.insertId);
};

beforeAll(async () => {
    await q(`INSERT INTO User (id, isAdmin, points) VALUES (?,0,0)
             ON DUPLICATE KEY UPDATE points=0`, [USER]);
    await q(`INSERT INTO Category (id, name) VALUES (?, 'PantrySkipCat')
             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [CAT]);
    await primeTokens(USER);

    ids.flour = await addProduct('Kvietiniai miltai PANTRYSK');
    ids.salt = await addProduct('Druska PANTRYSK');
    ids.chicken = await addProduct('Vištiena PANTRYSK');

    const t = await q(
        `INSERT INTO BasketTemplate (userId, name, isDefault, autoUpdate) VALUES (?,?,0,0)`,
        [USER, 'Pantry skip recipe']);
    templateId = Number(t.insertId);
    await q(
        `INSERT INTO BasketTemplateItem (templateId, productId, quantity, sortOrder, isPantry)
         VALUES (?,?,?,?,?), (?,?,?,?,?), (?,?,?,?,?)`,
        [
            templateId, ids.flour, 1, 0, 0,
            templateId, ids.salt, 1, 1, 1,      // the staple
            templateId, ids.chicken, 1, 2, 0,
        ]);
});

afterAll(async () => {
    await q(`DELETE bi FROM BasketItem bi JOIN Basket b ON b.id = bi.basketId WHERE b.userId = ?`, [USER]);
    await q(`DELETE FROM Basket WHERE userId = ?`, [USER]);
    await q(`DELETE FROM BasketTemplateItem WHERE templateId = ?`, [templateId]);
    await q(`DELETE FROM BasketTemplate WHERE userId = ?`, [USER]);
    const productIds = Object.values(ids);
    if (productIds.length) await q(`DELETE FROM Product WHERE id IN (?)`, [productIds]);
    await q(`DELETE FROM Category WHERE id = ?`, [CAT]);
    await q(`DELETE FROM User WHERE id = ?`, [USER]);
    await (pool as any).end();
});

const itemsOfNewestBasket = async (): Promise<number[]> => {
    const rows: any = await q(
        `SELECT bi.productId FROM BasketItem bi
           JOIN Basket b ON b.id = bi.basketId
          WHERE b.userId = ? ORDER BY b.id DESC, bi.productId ASC`, [USER]);
    const newest: any = await q(
        `SELECT id FROM Basket WHERE userId = ? ORDER BY id DESC LIMIT 1`, [USER]);
    const rows2: any = await q(
        `SELECT productId FROM BasketItem WHERE basketId = ?`, [Number(newest[0].id)]);
    return (rows2 as any[]).map(r => Number(r.productId)).sort((a, b) => a - b);
};

const instantiate = (body: Record<string, unknown>) =>
    asUser(app, USER).post(`/api/basket-templates/${templateId}/instantiate`)
        .send({ userId: USER, force: true, ...body });

describe('pantry items at basket creation', () => {
    it('keeps everything when the shopper says nothing', async () => {
        const res = await instantiate({});
        expect([200, 201]).toContain(res.status);
        expect(await itemsOfNewestBasket()).toEqual([ids.flour, ids.salt, ids.chicken].sort((a, b) => a - b));
    });

    it('leaves out the staple the shopper already has', async () => {
        const res = await instantiate({ skipPantryProductIds: [ids.salt] });
        expect([200, 201]).toContain(res.status);
        const items = await itemsOfNewestBasket();
        expect(items).not.toContain(ids.salt);
        expect(items).toEqual([ids.flour, ids.chicken].sort((a, b) => a - b));
    });

    /** The recipe is not edited by a basket decision — next time, salt is back. */
    it('does not touch the recipe itself', async () => {
        const rows: any = await q(
            `SELECT productId FROM BasketTemplateItem WHERE templateId = ?`, [templateId]);
        expect((rows as any[]).map(r => Number(r.productId)).sort((a, b) => a - b))
            .toEqual([ids.flour, ids.salt, ids.chicken].sort((a, b) => a - b));
    });

    /**
     * THE GUARD: naming an ordinary ingredient does nothing. Only staples are
     * droppable, so a stale client cannot empty a basket by listing every id.
     */
    it('refuses to drop an ordinary ingredient', async () => {
        const res = await instantiate({ skipPantryProductIds: [ids.chicken, ids.flour] });
        expect([200, 201]).toContain(res.status);
        const items = await itemsOfNewestBasket();
        expect(items).toContain(ids.chicken);
        expect(items).toContain(ids.flour);
    });

    it('ignores junk in the list rather than failing the whole basket', async () => {
        const res = await instantiate({ skipPantryProductIds: ['nonsense', null, -1, 999999999] });
        expect([200, 201]).toContain(res.status);
        expect(await itemsOfNewestBasket()).toHaveLength(3);
    });
});
