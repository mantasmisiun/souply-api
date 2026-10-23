import mysql from 'mysql2/promise';

/**
 * Column names that always hold a JSON ARRAY in this codebase (built via
 * JSON_ARRAYAGG / JSON_OBJECT). We normalise them centrally so every
 * query returns a real array regardless of engine:
 *
 *   - MySQL (Basket_DB) reports these as the JSON type and auto-parses.
 *   - MariaDB (souply_production / souply_test) stores JSON as LONGTEXT,
 *     so the driver hands them back as STRINGS (sometimes double-encoded).
 *     That string reaching a client `.map()/.slice()` crashed the
 *     discounts screen and broke product-image rendering.
 *
 * Keyed on the column NAME (the SELECT alias), so it works whether the
 * engine tags the column JSON or TEXT. Everything else falls through to
 * mysql2's default casting via next().
 */
const JSON_ARRAY_FIELDS = new Set(['imageUrls', 'chainLogos']);

/**
 * Column names that hold a JSON OBJECT (not an array). Same MariaDB-as-string
 * problem as the array fields, but we normalise to an object (or null) instead
 * of an array. `coverImage` = { kind: 'preset'|'emoji', ... }.
 */
const JSON_OBJECT_FIELDS = new Set(['coverImage', 'templateCoverImage']);

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // The schema is utf8mb4, but mysql2 defaults the CONNECTION to utf8mb3 (3-byte)
    // unless told otherwise — so 4-byte chars (emoji in template names/covers)
    // get mangled or truncated in transit: an emoji cover corrupts the
    // coverImage JSON → CHECK(json_valid) rejects the INSERT (save fails), and
    // an emoji name is truncated → empty/garbled. Pin the connection to utf8mb4.
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 20,
    // Bound the acquisition queue so extreme overload SHEDS (fails fast) instead of
    // hanging forever, but keep it deep enough to ABSORB a legitimate user spike:
    // when N people hit "Stores" at once, each basket calc fires ~8 short queries,
    // and at the instant they all start the first-query burst = N acquisitions.
    // queueLimit must exceed (peak concurrent requests − connectionLimit) or those
    // requests fail with "Queue limit reached" rather than queueing. 256 absorbs a
    // ~275-request simultaneous spike (well past the ~10-30 real concurrency), while
    // still capping a pathological receipt-burst runaway. Tune via DB_QUEUE_LIMIT.
    queueLimit: Number(process.env.DB_QUEUE_LIMIT) || 256,
    timezone: process.env.DB_TIMEZONE || '+02:00',
    ssl: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ? { rejectUnauthorized: false } : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeCast: (field: any, next: () => any) => {
        if (JSON_ARRAY_FIELDS.has(field.name)) {
            const raw: string | null = field.string();
            if (raw == null) return null;
            // Decode up to twice — MariaDB has occasionally handed these
            // back double-encoded — and guarantee an array out.
            let val: unknown = raw;
            for (let i = 0; i < 2 && typeof val === 'string'; i++) {
                try { val = JSON.parse(val as string); } catch { return []; }
            }
            return Array.isArray(val) ? val : [];
        }
        if (JSON_OBJECT_FIELDS.has(field.name)) {
            const raw: string | null = field.string();
            if (raw == null) return null;
            let val: unknown = raw;
            for (let i = 0; i < 2 && typeof val === 'string'; i++) {
                try { val = JSON.parse(val as string); } catch { return null; }
            }
            return val && typeof val === 'object' && !Array.isArray(val) ? val : null;
        }
        return next();
    },
});

export default pool;
