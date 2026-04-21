import dotenv from 'dotenv';

dotenv.config({
    path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env'
});

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
        `[env] Check your ${process.env.NODE_ENV === 'test' ? '.env.test' : '.env'} file.`
    );
    process.exit(1);
}

console.log(`[env] Loaded ${process.env.NODE_ENV === 'test' ? '.env.test' : '.env'} (DB: ${process.env.DB_NAME})`);