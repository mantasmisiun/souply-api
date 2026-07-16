import app from '../src/index.js';
import pool from '../src/config/db.js';
import { primeTokens, asUser } from './helpers/authedRequest.js';
import { createTrip } from '../src/models/tripModel.js';

/**
 * Souply 2.0 Phase 6: inbox as source of truth — push-token lifecycle,
 * member-joined + addressed-invite triggers landing inbox rows, unread
 * badge + mark-read.
 */

const OWNER = 'notif-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const JOINER = 'notif-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params) as any)[0];

beforeAll(async () => {
    await primeTokens(OWNER, JOINER);
    for (const u of [OWNER, JOINER]) {
        await q('DELETE FROM Notification WHERE userId = ?', [u]);
        await q('DELETE FROM PushToken WHERE userId = ?', [u]);
        await q('DELETE FROM TripMember WHERE userId = ?', [u]);
        await q('DELETE FROM Trip WHERE createdByUserId = ?', [u]);
        await q('INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points=0', [u]);
    }
    await q("UPDATE User SET username = 'notifjoiner' WHERE id = ?", [JOINER]);
});

afterAll(async () => {
    for (const u of [OWNER, JOINER]) {
        await q('DELETE FROM Notification WHERE userId = ?', [u]);
        await q('DELETE FROM PushToken WHERE userId = ?', [u]);
        await q('DELETE FROM TripMember WHERE userId = ?', [u]);
        await q('DELETE FROM Trip WHERE createdByUserId = ?', [u]);
    }
    await q("UPDATE User SET username = NULL WHERE id = ?", [JOINER]);
    await (pool as any).end();
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('notification plumbing', () => {
    it('push-token register is idempotent and re-owns a token', async () => {
        const r1 = await asUser(app, OWNER).post('/api/push-tokens').send({ token: 'ExponentPushToken[notif-1]', platform: 'android' });
        expect(r1.status).toBe(200);
        const r2 = await asUser(app, JOINER).post('/api/push-tokens').send({ token: 'ExponentPushToken[notif-1]', platform: 'android' });
        expect(r2.status).toBe(200);
        const rows = await q("SELECT userId FROM PushToken WHERE token = 'ExponentPushToken[notif-1]'");
        expect(rows).toHaveLength(1);
        expect(rows[0].userId).toBe(JOINER); // device changed hands → re-owned
        await asUser(app, JOINER).delete('/api/push-tokens').send({ token: 'ExponentPushToken[notif-1]' });
        expect(await q("SELECT userId FROM PushToken WHERE token = 'ExponentPushToken[notif-1]'")).toHaveLength(0);
    });

    it('trip join notifies existing members; addressed invite lands in the inbox', async () => {
        const tripId = await createTrip(OWNER);
        // Addressed invite BY HANDLE → joiner gets an inbox row with the join route.
        const inv = await asUser(app, OWNER).post(`/api/trips/${tripId}/invites`).send({ handle: '@notifjoiner' });
        expect(inv.status).toBe(200);
        expect(inv.body.addressed).toBe(true);
        await wait(150); // fire-and-forget insert
        let inbox = await asUser(app, JOINER).get('/api/notifications');
        expect(inbox.body.some((n: any) => n.type === 'trip_invite' && n.payload.route === `/join/${inv.body.code}`)).toBe(true);

        // Claiming notifies the OWNER (not the joiner).
        const claim = await asUser(app, JOINER).post(`/api/join/${inv.body.code}/claim`).send({});
        expect(claim.status).toBe(200);
        await wait(150);
        const ownerInbox = await asUser(app, OWNER).get('/api/notifications');
        expect(ownerInbox.body.some((n: any) => n.type === 'trip_member_joined')).toBe(true);

        // Unread badge + mark-read round-trip.
        const unread = await asUser(app, OWNER).get('/api/notifications/unread-count');
        expect(unread.body.unread).toBeGreaterThan(0);
        await asUser(app, OWNER).post('/api/notifications/mark-read').send({});
        const after = await asUser(app, OWNER).get('/api/notifications/unread-count');
        expect(after.body.unread).toBe(0);
    });
});
