import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Expand→contract tooling (roadmap Phase 5). For the RARE genuinely-breaking API change,
 * you run `/v1` and `/v2` of a route in the SAME process against the SAME database — `/v2`
 * is the real handler, `/v1` is a thin SHIM that translates the OLD request shape IN and the
 * NEW response shape back OUT, so old app builds keep working during the weeks-long overlap
 * after a release. Once the version telemetry (GET /api/admin/client-versions) shows the old
 * version has drained to ~0, you DELETE the `/v1` mount + its adapters — that's the "contract".
 *
 * ~90% of changes are ADDITIVE (a new response field an old client ignores) and need none of
 * this — reach for `v1Shim` only when the shape genuinely changed incompatibly.
 *
 * Example:
 *   // v2 returns { items: [...] }; v1 clients expect a bare array and sent { uid } not { userId }
 *   router.get('/v2/things', getThings);                       // new handler, new shape
 *   router.get('/v1/things', v1Shim(getThings, {
 *       adaptRequest:  (req) => { req.query.userId = req.query.uid; },
 *       adaptResponse: (body) => (body as any).items,          // unwrap to the old bare array
 *   }));
 */
export function v1Shim(
    v2Handler: RequestHandler,
    opts: {
        /** Mutate req (body/query/params) into the shape v2Handler expects. */
        adaptRequest?: (req: Request) => void;
        /** Reshape v2Handler's JSON body back into the v1 contract. */
        adaptResponse?: (v2Body: unknown, req: Request) => unknown;
    } = {},
): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (opts.adaptRequest) {
            try {
                opts.adaptRequest(req);
            } catch (e) {
                next(e);
                return;
            }
        }
        if (opts.adaptResponse) {
            const originalJson = res.json.bind(res);
            // Intercept the v2 handler's res.json and reshape to the v1 contract. Guarded so a
            // buggy adapter surfaces as a 500 via next(), not a malformed body.
            res.json = ((body: unknown) => {
                try {
                    return originalJson(opts.adaptResponse!(body, req));
                } catch (e) {
                    next(e);
                    return res;
                }
            }) as Response['json'];
        }
        return v2Handler(req, res, next);
    };
}
