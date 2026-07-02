import type { Request, Response, NextFunction } from 'express';
import { evaluateClientVersion } from '../services/versionPolicyService.js';
import { getClientVersionDistribution } from '../services/versionTelemetry.js';

/**
 * GET /api/app/version-check?platform=ios|android|web&version=1.2.3
 *
 * The launch-time gate check. Returns the evaluation so the client can decide to hard-block,
 * soft-nudge, or proceed. Falls back to the request's X-Client-* headers when the query
 * params are omitted. Always 200 (the STATUS is in the body) so it never itself trips the
 * global 426 middleware — and it's exempted from that middleware anyway (see index.ts).
 */
export const versionCheck = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const platform =
            (typeof req.query.platform === 'string' && req.query.platform) ||
            (req.header('x-client-platform') ?? '');
        const version =
            (typeof req.query.version === 'string' && req.query.version) ||
            (req.header('x-client-version') ?? '');

        const evalResult = await evaluateClientVersion(platform, version);
        res.json({
            status: evalResult.status,
            latestVersion: evalResult.recommendedVersion ?? evalResult.minVersion ?? null,
            minVersion: evalResult.minVersion,
            storeUrl: evalResult.storeUrl,
            message: evalResult.message,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/client-versions?days=14 (requireAdmin)
 * The version distribution rollup (Phase 5) — the operator reads this to see when old builds
 * have drained to ~0, i.e. when it's safe to contract deprecated routes/code.
 */
export const clientVersionDistribution = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const daysRaw = Number(req.query.days);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 120 ? Math.floor(daysRaw) : 14;
        res.json({ days, distribution: await getClientVersionDistribution(days) });
    } catch (error) {
        next(error);
    }
};
