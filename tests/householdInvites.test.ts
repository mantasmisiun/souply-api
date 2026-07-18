import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { createTrip } from '../src/models/tripModel.js';

/**
 * Souply 2.0 Phase 1c end-to-end: household lifecycle (create → invite →
 * claim → leave), the ONE-household invariant, the multi-claim ledger, trip
 * QR claims, and the shared-basket singleton staying out of the personal
 * draft flow.
 */

const OWNER = 'hhinv-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const JOINER = 'hhinv-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const THIRD = 'hhinv-cccc-cccc-cccc-cccccccccccc';

const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

let sharedBasketId: number;
let hhCode: string;

beforeAll(async () => {
    await primeTokens(OWNER, JOINER, THIRD);
    for (const u of [OWNER, JOINER, THIRD]) {
        await q('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
        await q('DELETE FROM BasketItem WHERE basketId IN (SELECT id FROM Basket WHERE userId = ?)', [u]);
        await q('DELETE FROM Basket WHERE userId = ?', [u]);
        await q('DELETE FROM TripMember WHERE userId = ?', [u]);
        await q('DELETE FROM Trip WHERE createdByUserId = ?', [u]);
        await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    }
    await q('DELETE FROM Household WHERE createdByUserId IN (?,?,?)', [OWNER, JOINER, THIRD]);
});

afterAll(async () => {
    for (const u of [OWNER, JOINER, THIRD]) {
        await q('DELETE FROM HouseholdMember WHERE userId = ?', [u]);
        await q('DELETE FROM Basket WHERE userId = ?', [u]);
        await q('DELETE FROM TripMember WHERE userId = ?', [u]);
        await q('DELETE FROM Trip WHERE createdByUserId = ?', [u]);
    }
    await q('DELETE FROM Household WHERE createdByUserId IN (?,?,?)', [OWNER, JOINER, THIRD]);
    await q('DELETE FROM BasketItem WHERE productId = 601');
    await q('DELETE FROM Product WHERE id = 601');
    await q('DELETE FROM Category WHERE id = 9971');
    await (pool as any).end();
});

describe('household lifecycle', () => {
    it('creates a household with owner membership and the shared basket', async () => {
        const r = await asUser(app, OWNER).post('/api/households').send({ name: 'Šeima' });
        expect(r.status).toBe(201);
        sharedBasketId = r.body.sharedBasketId;
        expect(sharedBasketId).toBeGreaterThan(0);

        const mine = await asUser(app, OWNER).get('/api/households/mine');
        expect(mine.status).toBe(200);
        expect(mine.body.role).toBe('owner');
        expect(mine.body.sharedBasketId).toBe(sharedBasketId);
        expect(mine.body.members).toHaveLength(1);
    });

    it('the shared basket never hijacks the personal draft flow', async () => {
        // POST /baskets must mint a NEW personal draft, not return the shared one.
        const b = await asUser(app, OWNER).post('/api/baskets').send({});
        expect([200, 201]).toContain(b.status);
        expect(b.body.id).not.toBe(sharedBasketId);
    });

    it('second household for the same user → 409 (schema invariant)', async () => {
        const r = await asUser(app, OWNER).post('/api/households').send({});
        expect(r.status).toBe(409);
        expect(r.body.error).toBe('household-exists');
    });

    it('invite → preview → claim brings the joiner in; the same QR works for a third user', async () => {
        const inv = await asUser(app, OWNER).post('/api/households/mine/invites').send({});
        expect(inv.status).toBe(200);
        hhCode = inv.body.code;
        expect(hhCode).toMatch(/^[a-z2-9]{12}$/);

        const preview = await asUser(app, JOINER).get(`/api/join/${hhCode}/preview`);
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({ scope: 'household', alreadyMember: false, memberCount: 1 });

        const claim = await asUser(app, JOINER).post(`/api/join/${hhCode}/claim`).send({});
        expect(claim.status).toBe(200);
        expect(claim.body.alreadyMember).toBe(false);

        // Multi-claim: the SAME code admits another user (the ledger redesign).
        const claim3 = await asUser(app, THIRD).post(`/api/join/${hhCode}/claim`).send({});
        expect(claim3.status).toBe(200);

        const mine = await asUser(app, OWNER).get('/api/households/mine');
        expect(mine.body.members).toHaveLength(3);
    });

    it('re-claim is idempotent', async () => {
        const again = await asUser(app, JOINER).post(`/api/join/${hhCode}/claim`).send({});
        expect(again.status).toBe(200);
        expect(again.body.alreadyMember).toBe(true);
    });

    it('a member of one household claiming another → 409 leave-first', async () => {
        const second = await asUser(app, THIRD).post('/api/households').send({});
        expect(second.status).toBe(409); // THIRD already joined OWNER's household

        // THIRD leaves, creates their own, then JOINER tries to claim into it while
        // still in OWNER's household → 409 household-exists.
        await asUser(app, THIRD).delete('/api/households/mine/membership');
        const own = await asUser(app, THIRD).post('/api/households').send({});
        expect(own.status).toBe(201);
        const inv = await asUser(app, THIRD).post('/api/households/mine/invites').send({});
        const r = await asUser(app, JOINER).post(`/api/join/${inv.body.code}/claim`).send({});
        expect(r.status).toBe(409);
        expect(r.body.error).toBe('household-exists');
    });

    it('last member leaving deletes the household and its shared basket', async () => {
        await asUser(app, THIRD).delete('/api/households/mine/membership');
        const gone = await asUser(app, THIRD).get('/api/households/mine');
        expect(gone.status).toBe(404);
        const [rows]: any = await pool.query(
            'SELECT COUNT(*) AS n FROM Basket WHERE userId = ? AND householdId IS NOT NULL', [THIRD]);
        expect(Number(rows[0].n)).toBe(0);
    });
});

describe('family basket writes', () => {
    it('household members can add/edit items in the shared basket; strangers cannot', async () => {
        // OWNER + JOINER are still in the lifecycle household — reuse it.
        const mine = await asUser(app, OWNER).get('/api/households/mine');
        expect(mine.status).toBe(200);
        const shared = mine.body.sharedBasketId;

        await q("INSERT INTO Category (id, name) VALUES (9971, 'HH Cat') ON DUPLICATE KEY UPDATE name=VALUES(name)");
        await q("INSERT INTO Product (id, name, categoryId) VALUES (601, 'HH Milk', 9971) ON DUPLICATE KEY UPDATE name=VALUES(name)");

        // MEMBER (non-creator) adds an item to the shared basket.
        const add = await asUser(app, JOINER).post('/api/basket-items')
            .send({ basketId: shared, productId: 601, quantity: 1 });
        expect([200, 201]).toContain(add.status);

        // ...and can edit it.
        const upd = await asUser(app, JOINER).put(`/api/basket-items/${add.body.id}`).send({ quantity: 2 });
        expect(upd.status).toBe(200);

        // A NON-member is still forbidden.
        const stranger = await asUser(app, THIRD).post('/api/basket-items')
            .send({ basketId: shared, productId: 601, quantity: 1 });
        expect(stranger.status).toBe(403);
    });
});

describe('trip invites', () => {
    it('member mints a QR; an invitee claims into TripMember; non-members cannot mint', async () => {
        const tripId = await createTrip(OWNER);

        const forbidden = await asUser(app, JOINER).post(`/api/trips/${tripId}/invites`).send({});
        expect(forbidden.status).toBe(404); // membership guard probes as not-found

        const inv = await asUser(app, OWNER).post(`/api/trips/${tripId}/invites`).send({});
        expect(inv.status).toBe(200);

        const claim = await asUser(app, JOINER).post(`/api/join/${inv.body.code}/claim`).send({});
        expect(claim.status).toBe(200);
        expect(claim.body).toMatchObject({ scope: 'trip', tripId, alreadyMember: false });

        // Now a member — can mint the same (reused) token.
        const inv2 = await asUser(app, JOINER).post(`/api/trips/${tripId}/invites`).send({});
        expect(inv2.status).toBe(200);
        expect(inv2.body.code).toBe(inv.body.code); // one QR per trip
    });
});
