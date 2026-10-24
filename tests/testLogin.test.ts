import request from 'supertest';

/**
 * Staging/dev test login (config/testLogin.ts). The key must be in the env
 * BEFORE the app is imported — routes register only when it is set — hence the
 * dynamic import.
 */
const KEY = 'test-login-key-for-jest-0123456789abcdef';
process.env.TEST_LOGIN_KEY = KEY;
process.env.API_PUBLIC_URL = 'https://api.example.test';
process.env.WEB_PUBLIC_URL = 'https://web.example.test';

const { default: app } = await import('../src/index.js');
const { default: pool } = await import('../src/config/db.js');
const { assertTestLoginSafe, DEFAULT_TEST_LOGIN_USER_ID } = await import('../src/config/testLogin.js');

afterAll(async () => {
    await pool.query('DELETE FROM User WHERE id = ?', [DEFAULT_TEST_LOGIN_USER_ID]);
});

describe('test login — guard', () => {
    const saved = { APP_ENV: process.env.APP_ENV, KEY: process.env.TEST_LOGIN_KEY };
    afterEach(() => {
        if (saved.APP_ENV === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = saved.APP_ENV;
        process.env.TEST_LOGIN_KEY = saved.KEY;
    });

    it('refuses to run in production', () => {
        process.env.APP_ENV = 'production';
        expect(() => assertTestLoginSafe()).toThrow(/production/);
    });
    it('refuses a short key', () => {
        process.env.TEST_LOGIN_KEY = 'short';
        expect(() => assertTestLoginSafe()).toThrow(/at least/);
    });
    it('is fine on staging with a proper key', () => {
        process.env.APP_ENV = 'staging';
        expect(() => assertTestLoginSafe()).not.toThrow();
    });
});

describe('test login — POST /api/auth/test-login', () => {
    it('no key → 401', async () => {
        expect((await request(app).post('/api/auth/test-login')).status).toBe(401);
    });
    it('wrong key → 401', async () => {
        const res = await request(app).post('/api/auth/test-login').set('X-Test-Login-Key', KEY + 'x');
        expect(res.status).toBe(401);
    });

    it('right key → a verified session for the test account', async () => {
        const res = await request(app).post('/api/auth/test-login').set('X-Test-Login-Key', KEY);
        expect(res.status).toBe(200);
        expect(res.body.userId).toBe(DEFAULT_TEST_LOGIN_USER_ID);
        expect(res.body.browserLoginUrl).toMatch(/^https:\/\/api\.example\.test\/api\/auth\/test-login\/redeem\?code=/);
        expect(String(res.headers['set-cookie'])).toMatch(/souply_session=.+HttpOnly/i);

        // The token is a normal session for a VERIFIED user (creator dashboard routes).
        const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
        expect(me.status).toBe(200);
        expect(me.body.email ?? me.body.user?.email).toBe('hermes@local.test');
    });
});

describe('test login — browser redeem', () => {
    const codeFrom = (url: string) => new URL(url).searchParams.get('code') as string;

    it('sets the session cookie and redirects to the dashboard, once', async () => {
        const login = await request(app).post('/api/auth/test-login').set('X-Test-Login-Key', KEY);
        const code = codeFrom(login.body.browserLoginUrl);

        const first = await request(app).get('/api/auth/test-login/redeem').query({ code });
        expect(first.status).toBe(302);
        expect(first.headers.location).toBe('https://web.example.test/dashboard');
        expect(String(first.headers['set-cookie'])).toMatch(/souply_session=/);

        const again = await request(app).get('/api/auth/test-login/redeem').query({ code });
        expect(again.status).toBe(400);
    });

    it('rejects an unknown code', async () => {
        expect((await request(app).get('/api/auth/test-login/redeem').query({ code: 'nope' })).status).toBe(400);
    });
});
