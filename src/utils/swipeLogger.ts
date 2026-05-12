import fs from 'fs';
import path from 'path';

const LOG_PATH = path.resolve(process.cwd(), 'swipe-debug.log');

fs.writeFileSync(LOG_PATH, `=== swipe debug log started ${new Date().toISOString()} ===\n`);

export function resetSwipeLog(label: string): void {
    fs.writeFileSync(LOG_PATH, `=== ${label} ${new Date().toISOString()} ===\n`);
}

export function swipeLog(msg: string): void {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}
