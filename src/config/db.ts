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
    waitForConnections: true,
    connectionLimit: 10,
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
