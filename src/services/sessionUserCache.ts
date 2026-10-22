import { userExists } from '../models/userModel.js';

/**
 * A validly signed session token can outlive its User row (account deleted on
 * another device, recovery merge removing the fresh account, a DB restore).
 * requireUser asks here whether the token's subject still exists, so an orphaned
 * token gets a 401 the app can recover from instead of a 500 from the first FK it
 * hits. Positive results are cached briefly — one PK probe per user per minute,
 * not per request; every code path that deletes a User row calls forgetSessionUser.
 */
const KNOWN_USER_TTL_MS = 60_000;
const KNOWN_USER_MAX = 10_000;
const knownUsers = new Map<string, number>();

export async function sessionUserExists(userId: string): Promise<boolean> {
    const until = knownUsers.get(userId);
    if (until && until > Date.now()) return true;
    const exists = await userExists(userId);
    if (exists) {
        if (knownUsers.size >= KNOWN_USER_MAX) knownUsers.clear();
        knownUsers.set(userId, Date.now() + KNOWN_USER_TTL_MS);
    } else {
        knownUsers.delete(userId);
    }
    return exists;
}

export function forgetSessionUser(userId: string): void {
    knownUsers.delete(userId);
}
