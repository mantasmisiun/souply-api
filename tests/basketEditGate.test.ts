import pool from '../src/config/db.js';
import { createBasket } from '../src/models/basketModel.js';
import { ensureBasketEditable } from '../src/controllers/basketItemController.js';

/**
 * Basket EDIT GATE. A 'compared' basket has been priced, not finished — adding a
 * forgotten item to it is normal and simply invalidates the results, so the edit
 * REVERTS it to 'draft' instead of being refused.
 *
 * Before this, anything non-draft was rejected with a 400 and only the basket-
 * detail screen knew to revert first; every other entry point (catalog card +
 * amount modal, product detail, search, session dock) showed a spinner, silently
 * failed and dropped the button back to "Add".
 *
 * 'inProgress'/'completed' must STAY refused — they have shopping lists or
 * receipts hanging off them.
 */

const USER = 'basgate-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];
const setStatus = (basketId: number, status: string) =>
    q('UPDATE Basket SET status = ? WHERE id = ?', [status, basketId]);
const statusOf = async (basketId: number): Promise<string> =>
    (await q('SELECT status FROM Basket WHERE id = ?', [basketId]))[0]?.status;

beforeAll(async () => {
    await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [USER]);
});

afterAll(async () => {
    await q('DELETE FROM Basket WHERE userId = ?', [USER]);
    await (pool as any).end();
});

describe('ensureBasketEditable', () => {
    it('allows a draft basket through untouched', async () => {
        const id = await createBasket(USER);
        const gate = await ensureBasketEditable(id);
        expect(gate).toEqual({ ok: true, reverted: false });
        expect(await statusOf(id)).toBe('draft');
    });

    it('REVERTS a compared basket to draft and reports it (the silent-add bug)', async () => {
        const id = await createBasket(USER);
        await setStatus(id, 'compared');

        const gate = await ensureBasketEditable(id);

        expect(gate).toEqual({ ok: true, reverted: true });
        // The revert must be persisted, or the very next edit fails again.
        expect(await statusOf(id)).toBe('draft');
    });

    it('refuses inProgress and completed baskets (lists / receipts exist)', async () => {
        for (const status of ['inProgress', 'completed']) {
            const id = await createBasket(USER);
            await setStatus(id, status);

            const gate = await ensureBasketEditable(id);

            expect(gate.ok).toBe(false);
            if (!gate.ok) expect(gate.status).toBe(400);
            expect(await statusOf(id)).toBe(status);   // never silently downgraded
        }
    });

    it('404s an unknown basket', async () => {
        const gate = await ensureBasketEditable(2147483600);
        expect(gate.ok).toBe(false);
        if (!gate.ok) expect(gate.status).toBe(404);
    });

    it('is idempotent — a second edit of a reverted basket is a plain no-op', async () => {
        const id = await createBasket(USER);
        await setStatus(id, 'compared');

        expect(await ensureBasketEditable(id)).toEqual({ ok: true, reverted: true });
        // Second call sees 'draft' now, so nothing to revert and no stale-cache signal.
        expect(await ensureBasketEditable(id)).toEqual({ ok: true, reverted: false });
    });
});
