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
    /** Re-invite: prepend a "the previous link didn't work, this one does and is
     *  safe to tap" note + a clearer subject. For the one-time TestFlight fix. */
    reinvite?: boolean;
}): Promise<void> {
    const from = process.env.SMTP_FROM ?? 'Souply <noreply@souply.lt>';
    const isIos = opts.platform === 'ios';
    const year = new Date().getFullYear();
    const en = opts.lang === 'en';
    // Android closed-testing self-serve: testers join the Google Group, then
    // open the Play opt-in link. iOS testers get the public TestFlight link.
    const groupUrl = process.env.BETA_GROUP_URL || 'https://groups.google.com/g/souply-testers';
    const optinUrl = process.env.BETA_OPTIN_URL || 'https://play.google.com/apps/testing/lt.souply.app';
    const testflightUrl = process.env.BETA_TESTFLIGHT_URL || 'https://testflight.apple.com/join/XYTFFyEu';

    const t = en ? {
        lang: 'en',
        subject: 'Your Souply beta invite 🎉',
        heading: "You're invited to test Souply 🎉",
        greeting: `Hi ${opts.name}!`,
        intro: "Here's how to start — two quick steps:",
        step1Title: '1. Join the testers group',
        step1Btn: 'Join the group',
        step1Note: 'Sign in with your Google account and tap “Join group”.',
        step2Title: '2. Install the app',
        step2Btn: 'Install from Google Play',
        step2Note: 'Tap “Become a tester”, then “Download it on Google Play”.',
        sameAccount: 'Use the same Google account for both steps.',
        iosBody: 'Thanks for joining! Install the app on TestFlight to get started:',
        iosBtn: 'Download on TestFlight',
        reinviteSubject: 'Your working Souply TestFlight link 🎉',
        reinviteNote: 'Heads up — the TestFlight link we sent you earlier didn’t work. This one is fixed and safe to tap. Sorry for the mix-up!',
        footerQ: 'Questions? Email',
        slogan: 'Shop smart',
    } : {
        lang: 'lt',
        subject: 'Tavo Souply testavimo kvietimas 🎉',
        heading: 'Tapk Souply testuotoju 🎉',
        greeting: `Sveika(s), ${opts.name}!`,
        intro: 'Štai kaip pradėti — du paprasti žingsniai:',
        step1Title: '1. Prisijunk prie testuotojų grupės',
        step1Btn: 'Prisijungti prie grupės',
        step1Note: 'Prisijunk su savo Google paskyra ir paspausk „Join group“.',
        step2Title: '2. Įsidiek programėlę',
        step2Btn: 'Įdiegti iš Google Play',
        step2Note: 'Paspausk „Become a tester“, tada „Download it on Google Play“.',
        sameAccount: 'Naudok tą pačią Google paskyrą abiem žingsniams.',
        iosBody: 'Ačiū, kad prisijungei! Įsidiek programėlę per TestFlight:',
        iosBtn: 'Atsisiųsti per TestFlight',
        reinviteSubject: 'Veikianti Souply TestFlight nuoroda 🎉',
        reinviteNote: 'Atsiprašome — anksčiau siųsta TestFlight nuoroda neveikė.',
        footerQ: 'Turi klausimų? Parašyk',
        slogan: 'Apsipirk išmaniai',
    };

    const btn = (href: string, label: string) =>
        `<a href="${href}" style="display:inline-block;background:#EB6784;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 30px;border-radius:9999px;">${label}</a>`;
    const step = (title: string, button: string, note: string) =>
        `<tr><td style="padding-bottom:22px;">
          <div style="font-size:16px;font-weight:700;color:#1f1b1d;padding-bottom:10px;">${title}</div>
          <div style="padding-bottom:8px;">${button}</div>
          <div style="font-size:13px;line-height:1.5;color:#9b9498;">${note}</div>
        </td></tr>`;

    const ctaHtml = isIos
        ? `<tr><td align="center" style="font-size:15px;line-height:1.6;color:#5b5358;padding-bottom:24px;">${t.iosBody}</td></tr>
           <tr><td align="center" style="padding-bottom:20px;">${btn(testflightUrl, t.iosBtn)}</td></tr>`
        : `<tr><td align="center" style="font-size:15px;line-height:1.6;color:#5b5358;padding-bottom:26px;">${t.intro}</td></tr>
           ${step(t.step1Title, btn(groupUrl, t.step1Btn), t.step1Note)}
           ${step(t.step2Title, btn(optinUrl, t.step2Btn), t.step2Note)}
           <tr><td style="padding-bottom:24px;"><div style="font-size:13px;line-height:1.5;color:#5b5358;background:#fdf0f3;border-radius:12px;padding:12px 16px;">⚠️ ${t.sameAccount}</div></td></tr>`;

    // Re-invite reassurance note (iOS only), shown above the CTA.
    const reinviteHtml = opts.reinvite
        ? `<tr><td style="padding-bottom:20px;"><div style="font-size:13px;line-height:1.55;color:#1f1b1d;background:#eef9f0;border-radius:12px;padding:12px 16px;">✅ ${t.reinviteNote}</div></td></tr>`
        : '';

    const textLines = isIos
        ? [t.greeting, '', ...(opts.reinvite ? [t.reinviteNote, ''] : []), t.iosBody, '', testflightUrl]
        : [t.greeting, '', t.intro, '', `${t.step1Title}: ${groupUrl}`, '', `${t.step2Title}: ${optinUrl}`, '', `! ${t.sameAccount}`];

    await transporter.sendMail({
        from,
        to: opts.to,
        subject: opts.reinvite ? t.reinviteSubject : t.subject,
        text: [...textLines, '', `${t.footerQ} support@souply.lt`, '— Souply'].join('\n'),
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
        <tr><td align="center" style="font-size:15px;line-height:1.6;color:#5b5358;padding-bottom:28px;">
          ${t.greeting}
        </td></tr>
        ${reinviteHtml}
        ${ctaHtml}
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

/**
 * Trip ("shared shopping") invite for an address with NO registered account —
 * registered users get the in-app notification instead (joinController).
 * Branded, bilingual-lite (LT with an EN hint), one big join button.
 */
export async function sendTripInviteEmail(opts: {
    to: string;
    joinUrl: string;
    inviterName: string | null;
}): Promise<void> {
    const from = process.env.SMTP_FROM ?? 'Souply <noreply@souply.lt>';
    const who = opts.inviterName?.trim() || 'Draugas';
    await transporter.sendMail({
        from,
        to: opts.to,
        subject: `${who} kviečia į bendrą apsipirkimą – Souply`,
        text: `${who} pakvietė tave į bendrą pirkinių sąrašą programėlėje Souply.\n\nPrisijunk: ${opts.joinUrl}\n\n(You've been invited to a shared shopping list on Souply — open the link to join.)`,
        html: `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
  <h2 style="color:#212121;margin:0 0 8px;">🛒 ${who} kviečia apsipirkti kartu</h2>
  <p style="color:#555;line-height:1.5;">Tave pakvietė į bendrą pirkinių sąrašą programėlėje <b>Souply</b> —
  matysi bendrą krepšelį, pigiausias parduotuves ir kvitus vienoje vietoje.</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${opts.joinUrl}" style="background:#EB6784;color:#fff;text-decoration:none;
       padding:13px 28px;border-radius:12px;font-weight:700;display:inline-block;">Prisijungti</a>
  </p>
  <p style="color:#999;font-size:12px;">Jei mygtukas neveikia: <a href="${opts.joinUrl}">${opts.joinUrl}</a><br>
  You've been invited to a shared shopping list on Souply — open the link to join.</p>
</div>`,
    });
}
