import dotenv from 'dotenv';
import { resolve } from 'path';

export default async function globalSetup() {
    dotenv.config({ path: resolve(process.cwd(), '.env.test') });
}
