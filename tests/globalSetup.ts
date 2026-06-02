import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import mysql from 'mysql2/promise';

/**
 * Jest global setup.
 *
 * Integration tests run against a DEDICATED, otherwise-empty database
 * (DB_NAME in .env.test, e.g. `souply_test_ci`) — never the populated
 * `souply_test` mirror. Admin-queue endpoints query globally with a LIMIT,
 * so any real rows in the DB crowd out the test fixtures; isolation is the
 * only reliable fix.
 *
 * This hook bootstraps the schema on first use: if the target DB has no
 * tables it loads tests/schema/schema.sql (a structure-only dump). The DB
 * itself and the grant for DB_USER must be created once on the server by an
 * admin — see tests/schema/README.md.
 */
export default async function globalSetup() {
    dotenv.config({ path: resolve(process.cwd(), '.env.test') });

    const dbName = process.env.DB_NAME;
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: dbName,
        ssl: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false'
            ? { rejectUnauthorized: false }
            : undefined,
        multipleStatements: true,
    }).catch((e: any) => {
        if (e?.code === 'ER_BAD_DB_ERROR') {
            throw new Error(
                `Test database "${dbName}" does not exist. Create it once on the DB server:\n` +
                `  CREATE DATABASE ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n` +
                `  GRANT ALL PRIVILEGES ON ${dbName}.* TO '${process.env.DB_USER}'@'%';\n` +
                `  FLUSH PRIVILEGES;\n` +
                `Then re-run the tests — the schema loads automatically.`,
            );
        }
        throw e;
    });

    try {
        const [tables]: any = await conn.query('SHOW TABLES');
        if (tables.length === 0) {
            const schemaPath = resolve(process.cwd(), 'tests/schema/schema.sql');
            const schema = readFileSync(schemaPath, 'utf8');
            await conn.query('SET FOREIGN_KEY_CHECKS=0');
            await conn.query(schema);
            await conn.query('SET FOREIGN_KEY_CHECKS=1');
            const [after]: any = await conn.query('SHOW TABLES');
            // eslint-disable-next-line no-console
            console.log(`[testdb] bootstrapped ${dbName}: ${after.length} tables`);
        }
    } finally {
        await conn.end();
    }
}
