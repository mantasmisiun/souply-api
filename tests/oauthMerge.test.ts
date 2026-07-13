/**
 * Integration tests for the OAuth sign-in → anonymous-data merge wiring
 * (`linkOrCreateVerifiedUser`). Requires the live test DB (Basket-DB-Test),
 * same as tests/accountRecovery.test.ts.
 *
 * Covers the `loginExisting` branch (the device's anon UUID differs from the
 * verified account that already owns this provider pair):
 *   - Case 2: empty anon row → deleted, no leftover orphan.
 *   - Case 3: anon with data (a basket) → merged into the verified account,
 *     anon row deleted.
 *   - Guard: anon row is ITSELF a verified account (other provider) → NOT
 *     merged/deleted; both accounts survive.
 *
 * Each test cleans up its own rows so reruns stay idempotent.
 */
import { jest } from '@jest/globals';
import pool from '../src/config/db.js';
import { linkOrCreateVerifiedUser, type VerifiedTokenClaims } from '../src/services/authService.js';
import { createUser } from '../src/models/userModel.js';

jest.setTimeout(20000);

const ACCOUNT_USER = 'oamtest-acct-0000-0000-000000000000'; // existing verified account
const ANON_USER    = 'oamtest-anon-0000-0000-000000000000'; // device anon UUID
const OTHER_VERIF  = 'oamtest-othr-0000-0000-000000000000'; // anon row that is itself verified

const SUBJECT = 'oauth-merge-test-subject-google';
const OTHER_SUBJECT = 'oauth-merge-test-subject-apple';

const ALL_USERS = [ACCOUNT_USER, ANON_USER, OTHER_VERIF];

function claims(subject: string): VerifiedTokenClaims {
    return {
        subject,
        email: `${subject}@example.com`,
        emailVerified: true,
        name: null, givenName: null, familyName: null, picture: null,
    };
}

async function cleanup() {
    const conn = await (pool as any).getConnection();
    try {
        await conn.query(`SET foreign_key_checks = 0`);
        await conn.query(`DELETE FROM Basket WHERE userId IN (?, ?, ?)`, ALL_USERS);
        await conn.query(`DELETE FROM ShoppingList WHERE userId IN (?, ?, ?)`, ALL_USERS);
        await conn.query(`DELETE FROM User WHERE id IN (?, ?, ?)`, ALL_USERS);
        await conn.query(`SET foreign_key_checks = 1`);
    } finally {
        conn.release();
    }
}

async function userExists(id: string): Promise<boolean> {
    const [rows]: any = await pool.query(`SELECT id FROM User WHERE id = ? LIMIT 1`, [id]);
    return rows.length > 0;
}

async function basketOwner(basketId: number): Promise<string | null> {
    const [rows]: any = await pool.query(`SELECT userId FROM Basket WHERE id = ? LIMIT 1`, [basketId]);
    return rows.length ? String(rows[0].userId) : null;
}

/** Make `id` a verified account on `(provider, subject)`. */
async function makeVerified(id: string, provider: 'google' | 'apple', subject: string) {
    await createUser(id);
    await pool.query(
        `UPDATE User SET authProvider = ?, authSubject = ?, email = ?, emailVerified = 1 WHERE id = ?`,
        [provider, subject, `${subject}@example.com`, id],
    );
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); });

describe('linkOrCreateVerifiedUser — anon→account merge on loginExisting', () => {
    test('Case 2: empty anon row is deleted, returns the existing account id', async () => {
        await makeVerified(ACCOUNT_USER, 'google', SUBJECT);
        await createUser(ANON_USER); // empty anonymous device row

        const res = await linkOrCreateVerifiedUser({
            anonymousUserId: ANON_USER,
            provider: 'google',
            claims: claims(SUBJECT),
        });

        expect(res.action).toBe('loginExisting');
        expect(res.userId).toBe(ACCOUNT_USER);
        expect(await userExists(ANON_USER)).toBe(false); // orphan cleaned up
        expect(await userExists(ACCOUNT_USER)).toBe(true);
    });

    test('Case 3: anon-with-data is merged into the account, anon row deleted', async () => {
        await makeVerified(ACCOUNT_USER, 'google', SUBJECT);
        await createUser(ANON_USER);
        const [ins]: any = await pool.query(`INSERT INTO Basket (userId) VALUES (?)`, [ANON_USER]);
        const basketId = Number(ins.insertId);

        const res = await linkOrCreateVerifiedUser({
            anonymousUserId: ANON_USER,
            provider: 'google',
            claims: claims(SUBJECT),
        });

        expect(res.userId).toBe(ACCOUNT_USER);
        expect(await userExists(ANON_USER)).toBe(false);          // anon row gone
        expect(await basketOwner(basketId)).toBe(ACCOUNT_USER);   // data re-pointed
    });

    test('Guard: anon row that is itself verified is NOT merged/deleted', async () => {
        await makeVerified(ACCOUNT_USER, 'google', SUBJECT);
        // The device UUID is a real Apple-verified account with its own basket.
        await makeVerified(OTHER_VERIF, 'apple', OTHER_SUBJECT);
        const [ins]: any = await pool.query(`INSERT INTO Basket (userId) VALUES (?)`, [OTHER_VERIF]);
        const basketId = Number(ins.insertId);

        const res = await linkOrCreateVerifiedUser({
            anonymousUserId: OTHER_VERIF,
            provider: 'google',
            claims: claims(SUBJECT),
        });

        expect(res.userId).toBe(ACCOUNT_USER);
        // Both accounts survive; the other account's data is untouched.
        expect(await userExists(OTHER_VERIF)).toBe(true);
        expect(await basketOwner(basketId)).toBe(OTHER_VERIF);
    });
});
