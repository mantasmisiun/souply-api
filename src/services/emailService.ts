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
