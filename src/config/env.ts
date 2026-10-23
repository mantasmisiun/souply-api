import dotenv from 'dotenv';

// DOTENV_CONFIG_PATH is dotenv's own override (also honoured by every
// `import 'dotenv/config'` script) — the local stack sets it to .env.local.
const envFile = process.env.DOTENV_CONFIG_PATH
    || (process.env.NODE_ENV === 'test' ? '.env.test' : '.env');

dotenv.config({ path: envFile });

const required = [
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_NAME',
] as const;

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
    console.error(
        `[env] Missing required environment variables: ${missing.join(', ')}\n` +
        `[env] Check your ${envFile} file.`
    );
    process.exit(1);
}

console.log(`[env] Loaded ${envFile} (DB: ${process.env.DB_NAME})`);