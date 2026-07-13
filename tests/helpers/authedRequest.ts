import supertest from 'supertest';
import { issueSessionToken } from '../../src/services/authService.js';

/**
 * Test helper: receipt/swipe routes now require a session-token Bearer header whose
 * subject owns the resource. `asUser(app, userId)` returns a supertest-like builder that
 * attaches a valid token for `userId` to every request — so integration tests exercise the
 * real requireUser + ownership middleware instead of bypassing it. Prime tokens once in
 * beforeAll with `primeTokens(...)` (they need SESSION_JWT_SECRET, loaded from .env.test).
 */

const cache = new Map<string, string>();

export async function primeTokens(...userIds: string[]): Promise<void> {
    for (const u of userIds) {
        if (!cache.has(u)) cache.set(u, await issueSessionToken(u));
    }
}

export function tokenFor(userId: string): string {
    const t = cache.get(userId);
    if (!t) throw new Error(`primeTokens(${userId}) must run in beforeAll before asUser()`);
    return t;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export function asUser(app: any, userId: string) {
    const bearer = `Bearer ${tokenFor(userId)}`;
    const agent = supertest(app);
    const wrap = (m: Method) => (url: string) => (agent as any)[m](url).set('Authorization', bearer);
    return {
        get: wrap('get'),
        post: wrap('post'),
        put: wrap('put'),
        patch: wrap('patch'),
        delete: wrap('delete'),
    };
}
