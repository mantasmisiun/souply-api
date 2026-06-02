/**
 * Public base URL of the web/landing front-end — the host that serves the
 * `/t/:slug` share page and resolves it against this API.
 *
 * Per-environment via the `WEB_PUBLIC_URL` env var:
 *   - prod  → https://souply.lt
 *   - test  → https://souply.manofoto.dpdns.org
 *   - dev   → http://localhost:5173
 *
 * Defaults to the prod domain so a missing var can never silently break
 * production share links. The environment that mints a link bakes in its own
 * domain, and a slug only exists in that environment's DB — so test/dev/prod
 * links stay naturally isolated (a prod QR resolves in prod, a test QR in
 * test). This is config, never a runtime flag.
 */
export const WEB_PUBLIC_URL = (process.env.WEB_PUBLIC_URL ?? 'https://souply.lt').replace(/\/+$/, '');

/** Build the public share URL for a template slug. */
export const shareUrlForSlug = (slug: string): string => `${WEB_PUBLIC_URL}/t/${slug}`;
