import '../config/env.js';
import { runIkiPromoScraper } from './iki/index.js';
import pool from '../config/db.js';

(async () => {
    try {
        await runIkiPromoScraper();
    } finally {
        await pool.end();
    }
})();
