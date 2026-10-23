import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';

/**
 * POST /api/basket-templates/:id/invites — the addressed template invite.
 *
 * Contract mirrors POST /trips/:id/invites: `{ email? | handle? }` body,
 * oracle-free 200 `{ code, addressed }`, registered target → Notification
 * inbox row. Template-specific parts under test: the delivered link is the
 * /t/:slug share page (NOT a /join code — templates have no membership),
 * owner-only access via loadOwnedTemplate, and the bare-body 400 (the QR
 * mint lives at /:id/share, so an addressless invite has no meaning here).
 */

const OWNER = 'tplinv-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TARGET = 'tplinv-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OUTSIDER = 'tplinv-cccc-cccc-cccc-cccccccccccc';
const TARGET_EMAIL = 'tplinv.target@example.test';
const TARGET_HANDLE = 'tplinv_target';
const CAT_ID = 9975;
const PROD_ID = 605;

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

let templateId: number;
let emptyTemplateId: number;

/** Delivery is fire-and-forget behind the 200 — poll the inbox briefly. */
const waitForNotifications = async (userId: string): Promise<any[]> => {
    for (let i = 0; i < 30; i++) {
        const rows = await q(
            "SELECT type, payload FROM Notification WHERE userId = ? AND type = 'template_invite' ORDER BY id",
            [userId]);
        if (rows.length) return rows;
        await new Promise(r => setTimeout(r, 100));
    }
    return [];
};

beforeAll(async () => {
    await primeTokens(OWNER, TARGET, OUTSIDER);
    for (const u of [OWNER, TARGET, OUTSIDER]) {
        await q('DELETE FROM Notification WHERE userId = ?', [u]);
        await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    }
    // The TARGET is a REGISTERED user reachable both ways — so both invite
    // paths resolve to the in-app notification (never SMTP, never CI flakes).
    await q('UPDATE User SET email = ?, username = ? WHERE id = ?', [TARGET_EMAIL, TARGET_HANDLE, TARGET]);
    await q("INSERT INTO Category (id, name) VALUES (?, 'TplInv Cat') ON DUPLICATE KEY UPDATE name=VALUES(name)", [CAT_ID]);
    await q("INSERT INTO Product (id, name, categoryId) VALUES (?, 'TplInv Milk', ?) ON DUPLICATE KEY UPDATE name=VALUES(name)", [PROD_ID, CAT_ID]);

    const created = await asUser(app, OWNER).post('/api/basket-templates')
        .send({ userId: OWNER, name: 'Testinis krepšelis' });
    expect(created.status).toBe(201);
    templateId = created.body.id;
    const item = await asUser(app, OWNER).post(`/api/basket-templates/${templateId}/items`)
        .send({ productId: PROD_ID, quantity: 1 });
    expect(item.status).toBe(201);

    const empty = await asUser(app, OWNER).post('/api/basket-templates')
        .send({ userId: OWNER, name: 'Tuščias krepšelis' });
    expect(empty.status).toBe(201);
    emptyTemplateId = empty.body.id;
});

afterAll(async () => {
    for (const id of [templateId, emptyTemplateId]) {
        if (!id) continue;
        await q('DELETE FROM BasketTemplateItem WHERE templateId = ?', [id]);
        await q('DELETE FROM BasketTemplate WHERE id = ?', [id]);
    }
    for (const u of [OWNER, TARGET, OUTSIDER]) {
        await q('DELETE FROM Notification WHERE userId = ?', [u]);
        await q('DELETE FROM User WHERE id = ?', [u]);
    }
    await q('DELETE FROM Product WHERE id = ?', [PROD_ID]);
    await q('DELETE FROM Category WHERE id = ?', [CAT_ID]);
    await (pool as any).end();
});

describe('POST /api/basket-templates/:id/invites', () => {
    it('rejects an unauthenticated caller', async () => {
        const res = await request(app).post(`/api/basket-templates/${templateId}/invites`)
            .send({ email: TARGET_EMAIL });
        expect(res.status).toBe(401);
    });

    it('owner invites by email → oracle-shaped 200 + inbox notification with the /t/:slug link', async () => {
        const res = await asUser(app, OWNER).post(`/api/basket-templates/${templateId}/invites`)
            .send({ email: TARGET_EMAIL.toUpperCase() }); // case-folds like trips
        expect(res.status).toBe(200);
        expect(res.body.addressed).toBe(true);
        // code = the template's shareSlug (10-char lowercase alphanumeric),
        // and inviting must have persisted it on the template row.
        expect(res.body.code).toMatch(/^[a-z0-9]{10}$/);
        const [tpl] = await q('SELECT shareSlug FROM BasketTemplate WHERE id = ?', [templateId]);
        expect(tpl.shareSlug).toBe(res.body.code);

        const inbox = await waitForNotifications(TARGET);
        expect(inbox.length).toBe(1);
        const payload = typeof inbox[0].payload === 'string' ? JSON.parse(inbox[0].payload) : inbox[0].payload;
        expect(payload.route).toBe(`/t/${res.body.code}`);
        await q('DELETE FROM Notification WHERE userId = ?', [TARGET]);
    });

    it('owner invites by @handle → same contract, slug reused (one link per template)', async () => {
        const first = await q('SELECT shareSlug FROM BasketTemplate WHERE id = ?', [templateId]);
        const res = await asUser(app, OWNER).post(`/api/basket-templates/${templateId}/invites`)
            .send({ handle: `@${TARGET_HANDLE}` }); // leading @ is stripped like trips
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ code: first[0].shareSlug, addressed: true });

        const inbox = await waitForNotifications(TARGET);
        expect(inbox.length).toBe(1);
        await q('DELETE FROM Notification WHERE userId = ?', [TARGET]);
    });

    it('a non-owner is refused (403), even with a valid address', async () => {
        const res = await asUser(app, OUTSIDER).post(`/api/basket-templates/${templateId}/invites`)
            .send({ email: TARGET_EMAIL });
        expect(res.status).toBe(403);
        // ...and nothing was delivered.
        const rows = await q(
            "SELECT 1 FROM Notification WHERE userId = ? AND type = 'template_invite'", [TARGET]);
        expect(rows.length).toBe(0);
    });

    it('malformed body is rejected: no address / non-string fields → 400', async () => {
        for (const body of [{}, { email: 42 }, { handle: { nested: true } }, { email: '   ' , handle: '' }]) {
            const res = await asUser(app, OWNER).post(`/api/basket-templates/${templateId}/invites`)
                .send(body as any);
            expect(res.status).toBe(400);
        }
    });

    it('an itemless template cannot be shared by invite (same guard as /share)', async () => {
        const res = await asUser(app, OWNER).post(`/api/basket-templates/${emptyTemplateId}/invites`)
            .send({ email: TARGET_EMAIL });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no items/i);
    });
});
