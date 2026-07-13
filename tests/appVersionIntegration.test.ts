import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import pool from '../src/config/db.js';
import { invalidateVersionPolicyCache } from '../src/services/versionPolicyService.js';

/**
 * End-to-end version gate through the real Express app + real DB policy: route mounted,
 * middleware order, DB read + cache, 426, fail-open. Flips the android floor and restores it.
 */

async function setAndroidFloor(minVersion: string | null) {
    await pool.query(
        `INSERT INTO ClientVersionPolicy (platform, minVersion, storeUrl)
             VALUES ('android', ?, 'play://souply')
         ON DUPLICATE KEY UPDATE minVersion = VALUES(minVersion), storeUrl = VALUES(storeUrl)`,
        [minVersion],
    );
    invalidateVersionPolicyCache();
}

afterAll(async () => {
    await setAndroidFloor(null); // leave the gate open (seed state)
});

describe('GET /api/app/version-check', () => {
    it("returns 'ok' when no floor is set (fail-open seed state)", async () => {
        await setAndroidFloor(null);
        const res = await request(app).get('/api/app/version-check?platform=android&version=1.0.0');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it("returns 'hard' + storeUrl when the client is below the floor", async () => {
        await setAndroidFloor('2.0.0');
        const res = await request(app).get('/api/app/version-check?platform=android&version=1.4.0');
        expect(res.status).toBe(200); // status is in the body, never 426 on this endpoint
        expect(res.body.status).toBe('hard');
        expect(res.body.storeUrl).toBe('play://souply');
    });

    it("returns 'ok' at/above the floor", async () => {
        await setAndroidFloor('2.0.0');
        const res = await request(app).get('/api/app/version-check?platform=android&version=2.0.0');
        expect(res.body.status).toBe('ok');
    });
});

describe('global version gate middleware (real app)', () => {
    it('426s a real request from a below-floor client', async () => {
        await setAndroidFloor('2.0.0');
        const res = await request(app)
            .get('/api/categories') // any /api route
            .set('X-Client-Platform', 'android')
            .set('X-Client-Version', '1.0.0');
        expect(res.status).toBe(426);
        expect(res.body.error).toBe('upgrade_required');
    });

    it('FAIL-OPEN: same request with no version headers is NOT blocked', async () => {
        await setAndroidFloor('2.0.0');
        const res = await request(app).get('/api/categories');
        expect(res.status).not.toBe(426);
    });

    it('EXEMPT: version-check itself is reachable even from a below-floor client', async () => {
        await setAndroidFloor('2.0.0');
        const res = await request(app)
            .get('/api/app/version-check?platform=android&version=1.0.0')
            .set('X-Client-Platform', 'android')
            .set('X-Client-Version', '1.0.0');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('hard');
    });

    it('an at-floor client passes through normally', async () => {
        await setAndroidFloor('2.0.0');
        const res = await request(app)
            .get('/api/categories')
            .set('X-Client-Platform', 'android')
            .set('X-Client-Version', '2.1.0');
        expect(res.status).not.toBe(426);
    });
});
