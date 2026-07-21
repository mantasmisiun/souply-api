/**
 * DEV-ONLY convenience: `ADMIN_OPEN_ACCESS=1` in .env makes EVERY user a
 * superadmin — the profile reports role 'superadmin' (so the app shows the
 * admin panel) and all admin/superadmin gates pass.
 *
 * NEVER set this on staging or production. It is intentionally an explicit
 * opt-in flag (not NODE_ENV-based) so a misconfigured NODE_ENV can't open
 * the panel by accident.
 */
export const ADMIN_OPEN_ACCESS = process.env.ADMIN_OPEN_ACCESS === '1';
