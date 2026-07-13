import {
    getAllClientVersionPolicies,
    type ClientPlatform,
    type ClientVersionPolicyRow,
} from '../models/clientVersionPolicyModel.js';
import { isBelow } from '../utils/semverCompare.js';

/**
 * Client version gate — the server-side source of truth for whether an installed frontend
 * is too old to run against the current backend. Policies live in ClientVersionPolicy
 * (runtime-flippable, no redeploy) and are cached here behind a short TTL so the launch
 * check + the per-request middleware never hit the DB hot.
 *
 * FAIL-OPEN is the whole safety model: unknown platform, unparseable version, or an unset
 * (NULL) floor ⇒ status 'ok'. A version is only ever gated when it is STRICTLY BELOW an
 * explicitly-set floor. This is what makes deploying the gate safe for every already-installed
 * build (which sends no/old version data).
 */

export type VersionStatus = 'ok' | 'soft' | 'hard';

export interface VersionEvaluation {
    status: VersionStatus;
    minVersion: string | null;
    recommendedVersion: string | null;
    storeUrl: string | null;
    message: string | null;
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; byPlatform: Map<ClientPlatform, ClientVersionPolicyRow> } | null = null;

async function getPolicies(): Promise<Map<ClientPlatform, ClientVersionPolicyRow>> {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) return cache.byPlatform;
    try {
        const rows = await getAllClientVersionPolicies();
        const byPlatform = new Map<ClientPlatform, ClientVersionPolicyRow>();
        for (const r of rows) byPlatform.set(r.platform, r);
        cache = { at: now, byPlatform };
        return byPlatform;
    } catch {
        // DB hiccup (or table not migrated yet) → FAIL OPEN with an empty policy set so the
        // gate never blocks anyone on an infrastructure blip. Cache the empty set briefly.
        cache = { at: now, byPlatform: new Map() };
        return cache.byPlatform;
    }
}

/** Force the next read to re-query (used after an operator flips a floor, and by tests). */
export function invalidateVersionPolicyCache(): void {
    cache = null;
}

function normalizePlatform(p: string | undefined | null): ClientPlatform | null {
    const v = (p ?? '').toLowerCase();
    return v === 'ios' || v === 'android' || v === 'web' ? v : null;
}

/**
 * Evaluate a (platform, version) against the current policy.
 *   hard = strictly below minVersion → block (426 / full-screen gate).
 *   soft = strictly below recommendedVersion (but not hard) → dismissible nudge.
 *   ok   = at/above both, OR any missing/unknown input (FAIL OPEN).
 */
export async function evaluateClientVersion(
    platformRaw: string | undefined | null,
    version: string | undefined | null,
): Promise<VersionEvaluation> {
    const platform = normalizePlatform(platformRaw);
    const policies = await getPolicies();
    const policy = platform ? policies.get(platform) : undefined;

    const base: VersionEvaluation = {
        status: 'ok',
        minVersion: policy?.minVersion ?? null,
        recommendedVersion: policy?.recommendedVersion ?? null,
        storeUrl: policy?.storeUrl ?? null,
        message: policy?.message ?? null,
    };

    // No policy, no version, or unknown platform → ok (fail open).
    if (!policy || !version) return base;

    if (isBelow(version, policy.minVersion)) return { ...base, status: 'hard' };
    if (isBelow(version, policy.recommendedVersion)) return { ...base, status: 'soft' };
    return base;
}
