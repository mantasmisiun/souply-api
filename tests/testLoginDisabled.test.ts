import request from 'supertest';
import app from '../src/index.js';

/**
 * Without TEST_LOGIN_KEY (production, and every env that doesn't opt in) the
 * test-login routes must not exist at all.
 */
describe('test login — disabled by default', () => {
    it('is not registered when TEST_LOGIN_KEY is unset', async () => {
        expect(process.env.TEST_LOGIN_KEY).toBeUndefined();
        expect((await request(app).post('/api/auth/test-login').set('X-Test-Login-Key', 'anything')).status).toBe(404);
        expect((await request(app).get('/api/auth/test-login/redeem').query({ code: 'x' })).status).toBe(404);
    });
});
