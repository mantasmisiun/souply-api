import { Request, Response, NextFunction } from 'express';
import {
    findClaimableInvite,
    attachEmailToken,
    verifyEmailToken,
    auditLog,
} from '../models/adminInviteModel.js';
import { sendAdminVerificationEmail } from '../services/emailService.js';

const publicUrl = (): string =>
    (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');

/** POST /api/admin-invite/claim  { token, userId } */
export const claimInvite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { token, userId } = req.body ?? {};
        if (typeof token !== 'string' || typeof userId !== 'string') {
            res.status(400).json({ error: 'token and userId required' });
            return;
        }

        const invite = await findClaimableInvite(token);
        if (!invite) {
            // Return a generic message — don't reveal whether the token was valid
            // but just expired vs never existed. Prevents enumeration.
            res.status(410).json({ error: 'invalid_or_expired' });
            return;
        }

        // Token is valid — issue email verification
        const rawEmailToken = await attachEmailToken(invite.id, userId);
        const verifyUrl = `${publicUrl()}/api/admin-invite/verify?t=${rawEmailToken}`;

        await sendAdminVerificationEmail({
            to: invite.email,
            firstName: invite.firstName,
            verifyUrl,
        });

        res.json({ status: 'email_sent', email: invite.email });
    } catch (err) {
        next(err);
    }
};

/** GET /api/admin-invite/verify?t=<emailToken>  — opened from email link in browser */
export const verifyEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const rawToken = typeof req.query.t === 'string' ? req.query.t : null;
        if (!rawToken) {
            res.status(400).send(htmlPage('Invalid link', 'This link is missing a verification token.', false));
            return;
        }

        const invite = await verifyEmailToken(rawToken);
        if (!invite) {
            res.status(410).send(htmlPage(
                'Link expired or already used',
                'This verification link has expired or was already used. Ask the operator to regenerate your QR code.',
                false,
            ));
            return;
        }

        res.send(htmlPage(
            'Admin access confirmed!',
            `Welcome, ${invite.firstName}. Your admin account is now active. Open the Souply app to get started.`,
            true,
        ));
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/admin-invite/open?t=<rawToken>
 * Served from the QR code. Camera opens this as a normal https link;
 * the page immediately redirects the browser to the souply:// deep link.
 */
export const openDeepLink = async (req: Request, res: Response): Promise<void> => {
    const rawToken = typeof req.query.t === 'string' ? req.query.t : null;
    if (!rawToken) { res.status(400).send('Missing token.'); return; }
    const appScheme = process.env.APP_SCHEME ?? 'souply';
    const deepLink = `${appScheme}://admin/claim?t=${encodeURIComponent(rawToken)}`;
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Opening Souply…</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px;
            text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    h1 { font-size: 20px; color: #111; margin: 0 0 12px; }
    p  { font-size: 15px; color: #555; line-height: 1.6; margin: 0 0 20px; }
    a  { display: inline-block; background: #16a34a; color: #fff; padding: 12px 28px;
         border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; }
  </style>
  <script>window.location.replace(${JSON.stringify(deepLink)});</script>
</head>
<body>
  <div class="card">
    <h1>Opening Souply…</h1>
    <p>If the app does not open automatically, tap the button below.</p>
    <a href="${deepLink}">Open Souply</a>
  </div>
</body>
</html>`);
};

/** POST /api/admin-invite/shadow-blocked  — called by requireAdmin middleware for shadow-banned write actions */
export const logShadowBlock = async (req: Request, res: Response): Promise<void> => {
    // Already logged by middleware; this handler just sends the fake 200.
    res.json({});
};

function htmlPage(title: string, body: string, success: boolean): string {
    const color = success ? '#16a34a' : '#dc2626';
    const icon = success ? '✓' : '✗';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Souply</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px;
            text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .icon { font-size: 48px; color: ${color}; margin-bottom: 16px; }
    h1 { font-size: 22px; color: #111; margin: 0 0 12px; }
    p  { font-size: 15px; color: #555; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}
