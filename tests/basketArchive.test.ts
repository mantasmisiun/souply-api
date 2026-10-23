import pool from '../src/config/db.js';
import { createBasket, getBasketsByUserId } from '../src/models/basketModel.js';
import { sweepBasketAutoArchive } from '../src/services/basketArchiveService.js';

/**
 * Basket auto-archive sweep: a PERSONAL draft/compared cart idle ≥48 h with no
 * shopping list is abandoned → archived (leaves the resumable pool). Fresh
 * carts, converted carts (a ShoppingList exists), and family baskets are never
 * archived.
 */

const USER = 'basarch-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORE_ID = 99671;
const CHAIN_ID = 9967;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];
const setUpdated = (basketId: number, hoursAgo: number) =>
    q('UPDATE Basket SET updatedAt = DATE_SUB(NOW(), INTERVAL ? HOUR) WHERE id = ?', [hoursAgo, basketId]);
const setStatus = (basketId: number, status: string) =>
    q('UPDATE Basket SET status = ? WHERE id = ?', [status, basketId]);
const archivedAt = async (basketId: number) =>
    (await q('SELECT archivedAt FROM Basket WHERE id = ?', [basketId]))[0]?.archivedAt ?? null;

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
    await q('INSERT INTO StoreChain (id, name) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [CHAIN_ID, 'BasArch Chain']);
    await q('INSERT INTO Store (id, chainId, name, address) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [STORE_ID, CHAIN_ID, 'BasArch Store', 'Test St. 7']);
});

afterAll(async () => {
    await q('DELETE FROM ShoppingList WHERE userId = ?', [USER]);
    await q('DELETE FROM Basket WHERE userId = ?', [USER]);
    await (pool as any).end();
});

describe('sweepBasketAutoArchive', () => {
    it('archives an idle (≥48h) personal draft cart but not a fresh one', async () => {
        const stale = await createBasket(USER);
        const fresh = await createBasket(USER);
        await setUpdated(stale, 49);
        await setUpdated(fresh, 47);

        await sweepBasketAutoArchive();

        expect(await archivedAt(stale)).not.toBeNull();
        expect(await archivedAt(fresh)).toBeNull();
    });

    it('archives an idle compared cart but never a converted one (has a shopping list)', async () => {
        const compared = await createBasket(USER);
        await setStatus(compared, 'compared');
        await setUpdated(compared, 50);

        const converted = await createBasket(USER);
        await q('INSERT INTO ShoppingList (userId, storeId, basketId) VALUES (?,?,?)', [USER, STORE_ID, converted]);
        await setUpdated(converted, 100);

        await sweepBasketAutoArchive();

        expect(await archivedAt(compared)).not.toBeNull();
        expect(await archivedAt(converted)).toBeNull();
    });

    it('never archives a family/shared basket', async () => {
        const family = await createBasket(USER);
        // householdId is a plain marker here (no FK from Basket) — a set value
        // is enough to exercise the "shared basket, never archived" guard.
        await q('UPDATE Basket SET householdId = ? WHERE id = ?', [99672, family]);
        await setUpdated(family, 200);

        await sweepBasketAutoArchive();

        expect(await archivedAt(family)).toBeNull();
        await q('DELETE FROM Basket WHERE id = ?', [family]);
    });

    it('hides archived carts from the user basket list', async () => {
        const stale = await createBasket(USER);
        await setUpdated(stale, 72);
        await sweepBasketAutoArchive();

        const list = await getBasketsByUserId(USER);
        expect(list.some((b: any) => b.id === stale)).toBe(false);
    });
});
