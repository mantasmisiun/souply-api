import '../config/env.js';
import { runNorfaPromoScraper } from './norfa/index.js';
import pool from '../config/db.js';

(async () => {
    try {
        await runNorfaPromoScraper();
    } finally {
        await pool.end();
    }
})();
