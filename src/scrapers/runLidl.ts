import '../config/env.js';
import { runLidlPromoScraper } from './lidl/index.js';
import pool from '../config/db.js';

(async () => {
    try {
        await runLidlPromoScraper();
    } finally {
        await pool.end();
    }
})();
