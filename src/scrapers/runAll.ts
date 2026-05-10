import '../config/env.js';
import pool from '../config/db.js';
import { runBarboraPromoScraper } from './barbora/index.js';
import { runIkiPromoScraper } from './iki/index.js';
import { runNorfaPromoScraper } from './norfa/index.js';
import { runRimiPromoScraper } from './rimi/index.js';
import { runLidlPromoScraper } from './lidl/index.js';

(async () => {
    try {
        await runBarboraPromoScraper();
        await runIkiPromoScraper();
        await runNorfaPromoScraper();
        await runRimiPromoScraper();
        await runLidlPromoScraper();
    } finally {
        await pool.end();
    }
})();
