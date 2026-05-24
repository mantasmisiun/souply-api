/**
 * basket admin CLI
 * Usage: npm run admin -- <command> [options]
 *
 * Commands:
 *   list                        List all admin invites
 *   create                      Interactively create a new invite
 *   qr <id>                     Print QR code for a pending invite
 *   revoke <id>                 Hard-revoke admin (user gets 403)
 *   revoke <id> --shadow        Shadow-ban (user sees 200, writes silently dropped)
 *   unshadow <userId>           Lift shadow ban (does not restore admin rights)
 *   audit                       Show recent audit log
 */

import '../config/env.js';
import readline from 'readline';
import qrTerminal from 'qrcode-terminal';
import {
    createInvite,
    listInvites,
    getInviteById,
    regenerateToken,
    revokeInvite,
    shadowBanInvite,
    unshadowUser,
    getAuditLog,
    type AdminRole,
} from '../models/adminInviteModel.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

function qrUrl(rawToken: string): string {
    const base = (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
    return `${base}/api/admin-invite/open?t=${rawToken}`;
}

function printTable(rows: any[]): void {
    if (!rows.length) { console.log('  (empty)'); return; }
    const keys = Object.keys(rows[0]);
    const widths = keys.map(k => Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)));
    const line = widths.map(w => '─'.repeat(w + 2)).join('┼');
    const fmt = (row: any) => keys.map((k, i) => ` ${String(row[k] ?? '').padEnd(widths[i])} `).join('│');
    console.log('┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐');
    console.log('│' + keys.map((k, i) => ` ${k.padEnd(widths[i])} `).join('│') + '│');
    console.log('├' + line + '┤');
    rows.forEach(r => console.log('│' + fmt(r) + '│'));
    console.log('└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');
}

// ── Commands ───────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
    const invites = await listInvites();
    if (!invites.length) { console.log('No invites found.'); return; }
    printTable(invites.map(i => ({
        id:       i.id,
        name:     `${i.firstName} ${i.lastName}`,
        email:    i.email,
        role:     i.role,
        status:   i.status,
        expires:  i.expiresAt ? new Date(i.expiresAt).toLocaleString() : '—',
        claimed:  i.claimedUserId ?? '—',
    })));
}

async function cmdCreate(): Promise<void> {
    console.log('\n── Create admin invite ──────────────────────\n');
    const firstName = (await ask('First name: ')).trim();
    const lastName  = (await ask('Last name:  ')).trim();
    const email     = (await ask('Email:      ')).trim();
    const roleRaw   = (await ask('Role (admin/superadmin) [admin]: ')).trim() || 'admin';
    const notes     = (await ask('Notes (optional): ')).trim();

    if (!firstName || !lastName || !email) {
        console.error('Error: first name, last name, and email are required.');
        return;
    }
    const role: AdminRole = roleRaw === 'superadmin' ? 'superadmin' : 'admin';

    console.log(`\nCreating invite for ${firstName} ${lastName} <${email}> as ${role}…`);
    const { id, rawToken } = await createInvite({
        firstName, lastName, email, role, notes,
        createdBy: process.env.USER ?? 'operator',
    });

    console.log(`\n✓ Invite #${id} created. Run: npm run admin -- qr ${id}\n`);

    const confirm = (await ask('Show QR code now? (y/N) ')).trim().toLowerCase();
    if (confirm === 'y') await printQr(id, rawToken);
}

async function printQr(id: number, rawToken?: string): Promise<void> {
    let token = rawToken;
    if (!token) {
        const invite = await getInviteById(id);
        if (!invite) { console.error(`Invite #${id} not found.`); return; }
        if (invite.status === 'claimed') { console.error('Already claimed.'); return; }
        // Regenerate if expired or pending_scan (safe to refresh token)
        if (invite.status === 'expired' || invite.status === 'pending_scan') {
            token = await regenerateToken(id);
            console.log(`Token refreshed (new 24 h window).`);
        } else {
            console.error(`Cannot show QR for invite with status: ${invite.status}`);
            return;
        }
    }

    const url = qrUrl(token);
    console.log(`\n── QR code for invite #${id} ─────────────────\n`);
    await new Promise<void>(resolve => qrTerminal.generate(url, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
    }));
    console.log(`URL: ${url}`);
    console.log('\nThis QR expires in 24 hours. The user must scan it with the Souply app.\n');
}

async function cmdRevoke(id: number, shadow: boolean): Promise<void> {
    const invite = await getInviteById(id);
    if (!invite) { console.error(`Invite #${id} not found.`); return; }

    const name = `${invite.firstName} ${invite.lastName}`;

    if (shadow) {
        const note = (await ask(`Shadow-ban note (internal, never shown to user): `)).trim();
        const confirm = (await ask(`Shadow-ban ${name} <${invite.email}>? (yes/N) `)).trim();
        if (confirm !== 'yes') { console.log('Aborted.'); return; }
        await shadowBanInvite(id, note);
        console.log(`✓ ${name} shadow-banned. Their writes are silently ignored.`);
    } else {
        const confirm = (await ask(`Hard-revoke ${name} <${invite.email}>? They will get 403. (yes/N) `)).trim();
        if (confirm !== 'yes') { console.log('Aborted.'); return; }
        await revokeInvite(id);
        console.log(`✓ ${name} revoked. isAdmin = 0.`);
    }
}

async function cmdUnshadow(userId: string): Promise<void> {
    const confirm = (await ask(`Lift shadow ban for userId ${userId}? (yes/N) `)).trim();
    if (confirm !== 'yes') { console.log('Aborted.'); return; }
    await unshadowUser(userId);
    console.log(`✓ Shadow ban lifted. Note: admin rights are NOT restored — use 'create' to re-invite.`);
}

async function cmdAudit(): Promise<void> {
    const log = await getAuditLog(50);
    if (!log.length) { console.log('Audit log is empty.'); return; }
    printTable(log.map(l => ({
        id:      l.id,
        when:    new Date(l.createdAt).toLocaleString(),
        action:  l.action,
        user:    l.userId ?? '—',
        invite:  l.inviteId ?? '—',
        who:     l.firstName ? `${l.firstName} ${l.lastName}` : '—',
    })));
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const [,, command, ...args] = process.argv;

    switch (command) {
        case 'list':
            await cmdList();
            break;
        case 'create':
            await cmdCreate();
            break;
        case 'qr': {
            const id = Number(args[0]);
            if (!id) { console.error('Usage: npm run admin -- qr <id>'); break; }
            await printQr(id);
            break;
        }
        case 'revoke': {
            const id = Number(args[0]);
            if (!id) { console.error('Usage: npm run admin -- revoke <id> [--shadow]'); break; }
            await cmdRevoke(id, args.includes('--shadow'));
            break;
        }
        case 'unshadow': {
            const userId = args[0];
            if (!userId) { console.error('Usage: npm run admin -- unshadow <userId>'); break; }
            await cmdUnshadow(userId);
            break;
        }
        case 'audit':
            await cmdAudit();
            break;
        default:
            console.log(`
Souply admin CLI
  npm run admin -- list
  npm run admin -- create
  npm run admin -- qr <id>
  npm run admin -- revoke <id>
  npm run admin -- revoke <id> --shadow
  npm run admin -- unshadow <userId>
  npm run admin -- audit
`);
    }

    rl.close();
    process.exit(0);
}

main().catch(err => { console.error(err); rl.close(); process.exit(1); });
