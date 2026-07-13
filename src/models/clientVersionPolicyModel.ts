import pool from '../config/db.js';

export type ClientPlatform = 'ios' | 'android' | 'web';

export interface ClientVersionPolicyRow {
    platform: ClientPlatform;
    minVersion: string | null;
    recommendedVersion: string | null;
    storeUrl: string | null;
    message: string | null;
}

/** All version policies, one per platform. Read wholesale (3 rows) so the service can
 *  cache the full set behind a short TTL and never hit the DB per request. */
export const getAllClientVersionPolicies = async (): Promise<ClientVersionPolicyRow[]> => {
    const [rows]: any = await pool.query(
        'SELECT platform, minVersion, recommendedVersion, storeUrl, message FROM ClientVersionPolicy',
    );
    return (rows as any[]).map((r) => ({
        platform: r.platform,
        minVersion: r.minVersion ?? null,
        recommendedVersion: r.recommendedVersion ?? null,
        storeUrl: r.storeUrl ?? null,
        message: r.message ?? null,
    }));
};
