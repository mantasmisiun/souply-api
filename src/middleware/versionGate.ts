import type { Request, Response, NextFunction } from 'express';
import { evaluateClientVersion } from '../services/versionPolicyService.js';
import { recordSighting } from '../services/versionTelemetry.js';

/**
 * Global client version gate. Reads X-Client-Platform / X-Client-Version off every request:
 *   - STRICTLY BELOW the hard floor ⇒ HTTP 426 Upgrade Required
 *     { error:'upgrade_required', storeUrl, message } — the app's 426 catcher shows the
 *     full-screen hard gate.
 *   - strictly below the soft floor ⇒ pass through (200) with `X-Client-Update: recommended`
 *     + `X-Client-Store-Url` so the app can raise a dismissible nudge without a round-trip.
 *
 * FAIL-OPEN, and EXEMPT the routes needed to even render/resolve the gate, so deploying this
 * can never brick the existing userbase or create a lockout loop:
 *   - No/blank version header (every current build, web, curl) ⇒ ok.
 *   - The version-check endpoint + /health are skipped (else a blocked client can't ask what
 *     to do, and health checks would 426).
 *   - Any evaluation error ⇒ ok (evaluateClientVersion already fails open).
 */

// Path suffixes that must remain reachable regardless of client version.
const EXEMPT_SUFFIXES = ['/app/version-check', '/health'];

export async function versionGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const path = req.path || req.originalUrl || '';
        if (EXEMPT_SUFFIXES.some((s) => path.endsWith(s))) {
            next();
            return;
        }
        const platform = req.header('x-client-platform');
        const version = req.header('x-client-version');
        // Telemetry (Phase 5): buffer the version distribution so we can later see when old
        // builds have drained. In-memory bump only; never touches the response.
        recordSighting(platform, version);
        // Fail open the instant there's nothing to evaluate — the common case for existing
        // installs and non-app callers. Avoids even the cached policy read.
        if (!platform || !version) {
            next();
            return;
        }

        const result = await evaluateClientVersion(platform, version);
        if (result.status === 'hard') {
            res.status(426).json({
                error: 'upgrade_required',
                storeUrl: result.storeUrl,
                message: result.message,
                minVersion: result.minVersion,
            });
            return;
        }
        if (result.status === 'soft') {
            res.setHeader('X-Client-Update', 'recommended');
            if (result.storeUrl) res.setHeader('X-Client-Store-Url', result.storeUrl);
        }
        next();
    } catch {
        // Never let the gate itself break a request.
        next();
    }
}
