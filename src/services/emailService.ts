import nodemailer from 'nodemailer';

const publicUrl = () =>
    (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');

const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

/**
 * Notify the team when a visitor signs up for the beta from the landing
 * page. Goes to BETA_NOTIFY_EMAIL (falls back to the SMTP user — i.e.
 * yourself). Plain text by design: it's an internal ops ping, not a
 * branded user-facing mail. The actual invite is still sent manually.
 */
export async function sendBetaSignupNotification(opts: {
    name: string;
    email: string;
    platform: string;
}): Promise<void> {
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'noreply@souply.app';
    const to = process.env.BETA_NOTIFY_EMAIL ?? process.env.SMTP_USER;
    if (!to) {
        console.warn('[email] no BETA_NOTIFY_EMAIL / SMTP_USER set; skipping beta notification');
        return;
    }
    await transporter.sendMail({
        from,
        to,
        subject: `Souply beta signup — ${opts.name} (${opts.platform})`,
        text: [
            'New beta signup from the landing page:',
            '',
            `Name:     ${opts.name}`,
            `Email:    ${opts.email}`,
            `Platform: ${opts.platform}`,
        ].join('\n'),
    });
}

/**
 * User-facing beta invite — sent to the visitor who signs up on the
 * landing page. Branded HTML (minimalist, matches the website), with a
 * single platform-appropriate store button. The store URLs come from
 * env (`BETA_TESTFLIGHT_URL` for iOS, `BETA_PLAYSTORE_URL` for Android)
 * so the links can be set/changed without a code deploy; until they're
 * set the button points at `#` (harmless). Fire-and-forget at the call
 * site — a mail hiccup must never fail the signup.
 */
export async function sendBetaInviteEmail(opts: {
    to: string;
    name: string;
    platform: 'ios' | 'android';
    /** Visitor's site language; falls back to Lithuanian. */
    lang?: 'lt' | 'en';
}): Promise<void> {
    const from = process.env.SMTP_FROM ?? 'Souply <noreply@souply.lt>';
    const isIos = opts.platform === 'ios';
    const storeUrl = (isIos ? process.env.BETA_TESTFLIGHT_URL : process.env.BETA_PLAYSTORE_URL) || '#';
    const year = new Date().getFullYear();
    const en = opts.lang === 'en';

    const t = en ? {
        lang: 'en',
        subject: 'Welcome to the Souply beta 🎉',
        heading: "You're on the beta list 🎉",
        greeting: `Hi ${opts.name}!`,
        body: 'Thanks for joining the Souply beta. Every Lithuanian store in one place — so you shop smarter. Install the app to get started:',
        button: isIos ? 'Download on TestFlight' : 'Get it on Google Play',
        fallback: "If the button doesn't work, copy this link:",
        footerQ: 'Questions? Email',
        slogan: 'Shop smart',
    } : {
        lang: 'lt',
        subject: 'Sveika(s) atvykę į Souply beta 🎉',
        heading: 'Tu beta sąraše 🎉',
        greeting: `Sveika(s), ${opts.name}!`,
        body: 'Ačiū, kad prisijungei prie Souply beta. Visos Lietuvos parduotuvės vienoje vietoje — kad pirktum pigiau. Įsidiek programėlę ir pradėk:',
        button: isIos ? 'Atsisiųsti per TestFlight' : 'Atsisiųsti iš Google Play',
        fallback: 'Jei mygtukas neveikia, nukopijuok nuorodą:',
        footerQ: 'Turi klausimų? Parašyk',
        slogan: 'Apsipirk išmaniai',
    };

    await transporter.sendMail({
        from,
        to: opts.to,
        subject: t.subject,
        text: [
            t.greeting,
            '',
            t.body,
            '',
            storeUrl,
            '',
            `${t.footerQ} support@souply.lt`,
            '— Souply',
        ].join('\n'),
        html: `<!DOCTYPE html>
<html lang="${t.lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f2f3;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2f3;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;padding:40px 36px;box-shadow:0 8px 40px rgba(31,27,29,.08);font-family:'Inter',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td align="center" style="padding-bottom:28px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:44px;height:44px;background:#EB6784;border-radius:14px;text-align:center;vertical-align:middle;color:#ffffff;font-size:24px;font-weight:700;">S</td>
            <td style="padding-left:12px;font-size:20px;font-weight:700;color:#1f1b1d;letter-spacing:-.02em;">Souply<span style="color:#b9b1b5;font-weight:600;">.lt</span></td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="font-size:24px;line-height:1.25;font-weight:700;color:#1f1b1d;letter-spacing:-.02em;padding-bottom:14px;">
          ${t.heading}
        </td></tr>
        <tr><td align="center" style="font-size:15px;line-height:1.6;color:#5b5358;padding-bottom:32px;">
          ${t.greeting}<br>
          ${t.body}
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px;">
          <a href="${storeUrl}" style="display:inline-block;background:#EB6784;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:15px 36px;border-radius:9999px;">${t.button}</a>
        </td></tr>
        <tr><td align="center" style="font-size:12px;line-height:1.5;color:#9b9498;padding-bottom:32px;">
          ${t.fallback}<br>
          <span style="color:#5b5358;word-break:break-all;">${storeUrl}</span>
        </td></tr>
        <tr><td style="border-top:1px solid #ece8e7;padding-bottom:20px;"></td></tr>
        <tr><td align="center" style="font-size:12px;line-height:1.6;color:#b9b1b5;">
          ${t.footerQ} <a href="mailto:support@souply.lt" style="color:#EB6784;text-decoration:none;">support@souply.lt</a><br>
          © ${year} Souply · ${t.slogan}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
}

export async function sendAdminVerificationEmail(opts: {
    to: string;
    firstName: string;
    verifyUrl: string;
}): Promise<void> {
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'noreply@souply.app';
    await transporter.sendMail({
        from,
        to: opts.to,
        subject: 'Souply – confirm your admin access',
        text: [
            `Hi ${opts.firstName},`,
            '',
            'You were granted admin access to Souply. Tap the link below to confirm your email and activate your account:',
            '',
            opts.verifyUrl,
            '',
            'This link expires in 1 hour. If you did not request this, ignore this email.',
        ].join('\n'),
        html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:system-ui,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <tr><td align="center" style="padding-bottom:24px">
          <img src="${publicUrl()}/assets/logo.png" alt="Souply" width="72" height="72" style="border-radius:16px;display:block">
        </td></tr>
        <tr><td style="font-size:20px;font-weight:700;color:#111;text-align:center;padding-bottom:12px">
          Admin access invite
        </td></tr>
        <tr><td style="font-size:15px;color:#555;line-height:1.6;text-align:center;padding-bottom:28px">
          Hi ${opts.firstName},<br><br>
          You were granted admin access to Souply.<br>
          Click the button below to confirm your email and activate your account.
        </td></tr>
        <tr><td align="center" style="padding-bottom:28px">
          <a href="${opts.verifyUrl}"
             style="display:inline-block;background:#e91e8c;color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Confirm admin access
          </a>
        </td></tr>
        <tr><td style="font-size:13px;color:#aaa;text-align:center;padding-bottom:8px">
          This link expires in 1 hour. If you did not request this, ignore this email.
        </td></tr>
        <tr><td style="font-size:11px;color:#ccc;text-align:center;word-break:break-all">
          ${opts.verifyUrl}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
}
