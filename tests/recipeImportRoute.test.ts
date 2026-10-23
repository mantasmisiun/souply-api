import app from '../src/index.js';
import pool from '../src/config/db.js';
import { asUser, primeTokens } from './helpers/authedRequest.js';
import supertest from 'supertest';

/**
 * POST /api/recipes/import — the endpoint contract.
 *
 * This is the one route in the codebase that makes an outbound request to a host
 * the CALLER chooses, so the guards are the point of these tests: authentication,
 * a URL we are willing to fetch, and a body size cap. None of the cases below
 * reach the network — they are all refused before a socket is opened, which is
 * exactly why they are safe to run in CI.
 */

const USER = 'recimp-aaaa-bbbb-cccc-dddddddddddd';

beforeAll(async () => {
    await pool.query(
        'INSERT INTO User (id, isAdmin, points) VALUES (?,0,0) ON DUPLICATE KEY UPDATE points = 0', [USER]);
    await primeTokens(USER);
});

afterAll(async () => {
    await pool.query('DELETE FROM User WHERE id = ?', [USER]);
    await (pool as any).end();
});

describe('POST /api/recipes/import', () => {
    it('requires a signed-in caller', async () => {
        const res = await supertest(app).post('/api/recipes/import').send({ url: 'https://example.com/r' });
        expect(res.status).toBe(401);
    });

    it('requires a url', async () => {
        const res = await asUser(app, USER).post('/api/recipes/import').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/url/i);
    });

    it('refuses a non-http scheme', async () => {
        const res = await asUser(app, USER).post('/api/recipes/import').send({ url: 'file:///etc/passwd' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('bad_url');
    });

    /** SSRF. Our own dev database lives at a private address; the server must not
     *  be usable as a proxy to reach it. */
    it('refuses a private address', async () => {
        for (const url of ['http://127.0.0.1:3000/', 'http://169.254.169.254/latest/meta-data/',
            'http://192.168.1.212:3307/', 'http://localhost/r']) {
            const res = await asUser(app, USER).post('/api/recipes/import').send({ url });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('blocked_host');
        }
    });

    /** The device-fetch fallback posts HTML back; the cap stops that path being a
     *  way to hand the server an arbitrarily large body to parse. */
    it('refuses oversized client-supplied html', async () => {
        const res = await asUser(app, USER)
            .post('/api/recipes/import')
            .send({ url: 'https://example.com/r', html: 'x'.repeat(3.1 * 1024 * 1024) });
        expect(res.status).toBe(413);
    });

    /** Client-supplied HTML is parsed WITHOUT any network access, which is what
     *  makes the blocked-publisher fallback work — and what makes this testable. */
    it('parses client-supplied html and returns a preview', async () => {
        const recipe = {
            '@context': 'https://schema.org',
            '@type': 'Recipe',
            name: 'Testinis blynų receptas',
            recipeYield: '4',
            recipeIngredient: ['200 gramų kvietinių miltų', '2 vienetai kiaušinių', 'pagal skonį druskos'],
        };
        const html = `<!doctype html><html lang="lt"><head><title>T</title>`
            + `<script type="application/ld+json">${JSON.stringify(recipe)}</script></head>`
            + `<body><h1>Testinis blynų receptas</h1></body></html>`;

        const res = await asUser(app, USER)
            .post('/api/recipes/import')
            .send({ url: 'https://www.lamaistas.lt/receptas/testinis-123', html });

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Testinis blynų receptas');
        expect(res.body.site).toBe('lamaistas.lt');
        expect(res.body.lang).toBe('lt');
        expect(res.body.servings).toBe(4);
        expect(res.body.extractor).toBe('jsonld');
        expect(typeof res.body.suggestedEmoji).toBe('string');

        // Every returned item is something the client can hand straight to
        // POST /api/basket-templates.
        for (const item of res.body.items) {
            expect(Number.isFinite(item.productId)).toBe(true);
            expect(item.quantity).toBeGreaterThan(0);
            expect(['kg', 'vnt']).toContain(item.unit);
        }
        // The counts must describe the arrays actually sent.
        expect(res.body.counts.matched).toBe(res.body.items.length);
        expect(res.body.counts.skipped).toBe(res.body.skipped.length);
    });

    it('reports a page with no recipe as such, rather than guessing', async () => {
        const res = await asUser(app, USER).post('/api/recipes/import').send({
            url: 'https://example.com/article',
            html: '<!doctype html><html><body><p>An article about food.</p></body></html>',
        });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('no_recipe');
    });
});
