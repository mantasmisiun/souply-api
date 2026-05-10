import '../config/env.js';
import { runRimiPromoScraper } from './rimi/index.js';
import pool from '../config/db.js';

(async () => {
    try {
        await runRimiPromoScraper();
    } finally {
        await pool.end();
    }
})();
