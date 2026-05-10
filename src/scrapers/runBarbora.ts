import '../config/env.js';
import { runBarboraPromoScraper } from './barbora/index.js';
import pool from '../config/db.js';

(async () => {
    try {
        await runBarboraPromoScraper();
    } finally {
        await pool.end();
    }
})();
