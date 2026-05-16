import pool from '../config/db.js';
import { notifyTelegram } from '../scrapers/shared/telegramAlert.js';

/**
 * Daily 20:00 Europe/Vilnius Telegram digest of pending
 * `ReceiptLineIssue` rows (the Žymos inbox).
 *
 * Two windows in one message:
 *   • Total pending — how many cards are sitting in Žymos right now
 *   • Last 24h     — how many of those were freshly flagged since
 *                    yesterday's 20:00 digest
 *
 * Per-flag-type breakdown (name / amount / price / discount / image)
 * comes from a single SUM-over-JSON-extract query. A row with two
 * flags set counts in both buckets — that matches what the admin
 * sees in Žymos, where one card surfaces under multiple sub-flags.
 *
 * If `total === 0` the digest is skipped to avoid Telegram-spamming
 * during quiet stretches. A non-zero last24h alone (rare — would
 * require quick admin turnaround inside one window) still sends.
 */

interface PendingCounts {
    total: number;
    last24h: number;
    byFlag: {
        name: number;
        amount: number;
        price: number;
        discount: number;
        image: number;
    };
}

async function queryPendingCounts(): Promise<PendingCounts> {
    const [[totals]]: any = await pool.query(
        `SELECT
            COUNT(*) AS total,
            SUM(JSON_EXTRACT(flags, '$.name')     = TRUE) AS name_count,
            SUM(JSON_EXTRACT(flags, '$.amount')   = TRUE) AS amount_count,
            SUM(JSON_EXTRACT(flags, '$.price')    = TRUE) AS price_count,
            SUM(JSON_EXTRACT(flags, '$.discount') = TRUE) AS discount_count,
            SUM(JSON_EXTRACT(flags, '$.image')    = TRUE) AS image_count
           FROM ReceiptLineIssue
          WHERE status = 'pending'`,
    );
    const [[last24]]: any = await pool.query(
        `SELECT COUNT(*) AS n
           FROM ReceiptLineIssue
          WHERE status = 'pending'
            AND createdAt > NOW() - INTERVAL 24 HOUR`,
    );
    return {
        total: Number(totals?.total ?? 0),
        last24h: Number(last24?.n ?? 0),
        byFlag: {
            name: Number(totals?.name_count ?? 0),
            amount: Number(totals?.amount_count ?? 0),
            price: Number(totals?.price_count ?? 0),
            discount: Number(totals?.discount_count ?? 0),
            image: Number(totals?.image_count ?? 0),
        },
    };
}

function formatDigest(counts: PendingCounts): string {
    // HTML mode — `notifyTelegram` already sets parse_mode=HTML.
    const lines: string[] = [];
    lines.push('📋 <b>Vartotojų pranešimai</b>');
    lines.push(`Naujų per parą: <b>${counts.last24h}</b> (iš viso laukia: <b>${counts.total}</b>)`);
    lines.push('');
    const { byFlag } = counts;
    if (byFlag.name > 0)     lines.push(`• Pavadinimas: ${byFlag.name}`);
    if (byFlag.amount > 0)   lines.push(`• Kiekis: ${byFlag.amount}`);
    if (byFlag.price > 0)    lines.push(`• Kaina: ${byFlag.price}`);
    if (byFlag.discount > 0) lines.push(`• Nuolaida: ${byFlag.discount}`);
    if (byFlag.image > 0)    lines.push(`• Nuotrauka: ${byFlag.image}`);
    lines.push('');
    lines.push('Eik į Žymos kortelę administratoriaus paneleje.');
    return lines.join('\n');
}

export async function sendDailyReceiptIssuesReport(): Promise<void> {
    try {
        const counts = await queryPendingCounts();
        if (counts.total === 0) {
            console.log('[adminDailyReport] no pending ReceiptLineIssues — skipping Telegram digest');
            return;
        }
        const msg = formatDigest(counts);
        await notifyTelegram(msg);
        console.log(`[adminDailyReport] sent — total=${counts.total} last24h=${counts.last24h}`);
    } catch (e: any) {
        console.error('[adminDailyReport] failed —', e?.message ?? e);
    }
}
