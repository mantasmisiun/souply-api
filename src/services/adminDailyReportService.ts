import pool from '../config/db.js';
import { notifyTelegram, resolveEnv } from '../scrapers/shared/telegramAlert.js';
import { drainFailOpen } from './failOpenMetrics.js';

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

/** Last-24h unprocessable-receipt failures for this environment (status='new'). */
async function queryFailedReceiptCounts(): Promise<{ total: number; byReason: Record<string, number> }> {
    try {
        const [rows]: any = await pool.query(
            `SELECT failReason, COUNT(*) AS n
               FROM FailedReceiptLog
              WHERE environment = ?
                AND status = 'new'
                AND createdAt > NOW() - INTERVAL 24 HOUR
              GROUP BY failReason`,
            [resolveEnv()],
        );
        const byReason: Record<string, number> = {};
        let total = 0;
        for (const r of rows ?? []) {
            const n = Number(r.n ?? 0);
            byReason[r.failReason] = n;
            total += n;
        }
        return { total, byReason };
    } catch (e: any) {
        // Un-migrated DB (missing column/table) → no failed section, don't crash.
        if (e?.code === 'ER_NO_SUCH_TABLE' || e?.code === 'ER_BAD_FIELD_ERROR') return { total: 0, byReason: {} };
        throw e;
    }
}

const FAIL_REASON_LT: Record<string, string> = {
    ocr_no_text: 'OCR be teksto',
    ocr_error: 'OCR klaida',
    chain_unrecognized: 'Neatpažintas tinklas',
    store_unrecognized: 'Neatpažinta parduotuvė',
    parse_failed: 'Nepavyko išanalizuoti',
    mask_failed: 'Nepavyko paslėpti kortelės',
};

function formatDigest(
    counts: PendingCounts,
    failed: { total: number; byReason: Record<string, number> },
    failOpen: Record<string, number> = {},
): string {
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

    if (failed.total > 0) {
        lines.push('');
        lines.push('🧾 <b>Nepavykę kvitai (24h)</b>');
        lines.push(`Iš viso: <b>${failed.total}</b>`);
        for (const [reason, n] of Object.entries(failed.byReason)) {
            if (n > 0) lines.push(`• ${FAIL_REASON_LT[reason] ?? reason}: ${n}`);
        }
    }

    // Fail-open counters: silent best-effort failures (fallback propagation, points,
    // alias learning, orphan refill, per-line resolver) that would otherwise only reach
    // stdout. A non-zero here means a background subsystem is degrading while users still
    // get 201s — worth eyeballing. Since restart resets the counters, treat this as a
    // "within-the-day" signal, not an exact daily total.
    const failOpenEntries = Object.entries(failOpen).filter(([, n]) => n > 0);
    if (failOpenEntries.length > 0) {
        lines.push('');
        lines.push('⚠️ <b>Fail-open įvykiai (nuo paleidimo)</b>');
        for (const [site, n] of failOpenEntries) lines.push(`• ${site}: ${n}`);
    }
    return lines.join('\n');
}

export async function sendDailyReceiptIssuesReport(): Promise<void> {
    try {
        const counts = await queryPendingCounts();
        const failed = await queryFailedReceiptCounts();
        const failOpen = drainFailOpen();
        const failOpenTotal = Object.values(failOpen).reduce((a, b) => a + b, 0);
        // Skip only when the Žymos inbox, the failed-receipt log AND the fail-open
        // counters are all quiet, so the digest still fires on a silent background outage.
        if (counts.total === 0 && failed.total === 0 && failOpenTotal === 0) {
            console.log('[adminDailyReport] nothing pending (issues + failures + fail-open) — skipping digest');
            return;
        }
        const msg = formatDigest(counts, failed, failOpen);
        await notifyTelegram(msg);
        console.log(`[adminDailyReport] sent — issues total=${counts.total} last24h=${counts.last24h} failed24h=${failed.total}`);
    } catch (e: any) {
        console.error('[adminDailyReport] failed —', e?.message ?? e);
    }
}
