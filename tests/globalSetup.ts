import { readFileSync } from 'fs';
import { resolve } from 'path';

export default async function globalSetup() {
    const envFile = readFileSync(resolve(process.cwd(), '.env.test'), 'utf-8');
    
    for (const line of envFile.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [key, ...rest] = trimmed.split('=');
        process.env[key.trim()] = rest.join('=').trim();
    }
}