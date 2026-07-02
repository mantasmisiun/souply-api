import pool from '../config/db.js';

/**
 * Client version telemetry (Phase 5). The version-gate middleware sees the X-Client-Platform/
 * Version headers on every request; this buffers a daily per-(platform, version) count IN
 * MEMORY and flushes it to ClientVersionSighting on an interval — so the request hot path
 * never does a DB write. The rollup answers the one operational question that gates a
 * contract: "have the old versions drained yet?"
 *
 * Fail-safe throughout: a flush error keeps the buffer for the next tick; a bad header is
 * ignored. Telemetry must never affect request handling.
 */

type Platform = 'ios' | 'android' | 'web';
const VALID: Platform[] = ['ios', 'android', 'web'];

// key = `${platform}|${version}|${day}` → count since last flush.
const buffer = new Map<string, number>();

const today = (): string => new Date().toISOString().slice(0, 10);

/** Record one sighting. Cheap (a Map bump); no I/O. Ignores unknown platforms / blank versions. */
export function recordSighting(platformRaw: string | undefined, version: string | undefined): void {
    if (!platformRaw || !version) return;
    const platform = platformRaw.toLowerCase() as Platform;
    if (!VALID.includes(platform)) return;
    const v = version.slice(0, 32);
    const key = `${platform}|${v}|${today()}`;
    buffer.set(key, (buffer.get(key) ?? 0) + 1);
}

/** Flush the buffer to the DB (drain-then-write so concurrent bumps aren't lost on error). */
export async function flushSightings(): Promise<void> {
    if (buffer.size === 0) return;
    const entries = [...buffer.entries()];
    buffer.clear();
    try {
        // One multi-row upsert accumulating onto the daily counter.
        const values = entries.map(([key, count]) => {
            const [platform, version, day] = key.split('|');
            return [platform, version, day, count];
        });
        await pool.query(
            `INSERT INTO ClientVersionSighting (platform, version, day, requests)
                 VALUES ?
             ON DUPLICATE KEY UPDATE requests = requests + VALUES(requests)`,
            [values],
        );
    } catch {
        // Write failed (DB blip / un-migrated table) — put the counts back so the next flush
        // retries them instead of dropping the data.
        for (const [key, count] of entries) {
            buffer.set(key, (buffer.get(key) ?? 0) + count);
        }
    }
}

const FLUSH_INTERVAL_MS = 60_000;
let started = false;

/** Start the periodic flush. Idempotent; the interval is unref'd so it never holds the
 *  process open (tests, graceful shutdown). No-op under NODE_ENV=test to keep suites clean. */
export function startVersionTelemetry(): void {
    if (started || process.env.NODE_ENV === 'test') return;
    started = true;
    const timer = setInterval(() => { void flushSightings(); }, FLUSH_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

export interface VersionDistributionRow {
    platform: Platform;
    version: string;
    day: string;
    requests: number;
}

/** Distribution over the last `days` days, newest first — for the admin query surface. */
export async function getClientVersionDistribution(days = 14): Promise<VersionDistributionRow[]> {
    const [rows]: any = await pool.query(
        `SELECT platform, version, day, requests
           FROM ClientVersionSighting
          WHERE day >= (CURRENT_DATE - INTERVAL ? DAY)
          ORDER BY day DESC, platform, requests DESC`,
        [days],
    );
    return (rows as any[]).map((r) => ({
        platform: r.platform,
        version: r.version,
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
        requests: Number(r.requests),
    }));
}
