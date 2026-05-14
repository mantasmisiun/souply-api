import './config/env.js';
import express from 'express';
import * as path from 'path';
import pool from './config/db.js';
import storeRoutes from './routes/storeRoutes.js';
import productRoutes from './routes/productRoutes.js';
import categoryRoutes from './routes/categoryRoutes.js';
import storeProductRoutes from './routes/storeProductRoutes.js';
import priceRoutes from './routes/priceRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { resolveLocale } from './middleware/locale.js';
import userRoutes from './routes/userRoutes.js';
import basketRoutes from './routes/basketRoutes.js';
import basketItemRoutes from './routes/basketItemRoutes.js';
import shoppingListRoutes from './routes/shoppingListRoutes.js';
import shoppingListItemRoutes from './routes/shoppingListItemRoutes.js';
import receiptRoutes from './routes/receiptRoutes.js';
import swipeVoteRoutes from './routes/swipeVoteRoutes.js';
import orphanSwipeRoutes from './routes/orphanSwipeRoutes.js';
import swipeQueueRoutes from './routes/swipeQueueRoutes.js';
import geocodeRoutes from './routes/geocodeRoutes.js';
import parserTestRoutes from './routes/parserTestRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './config/swagger.js';
import './scrapers/scheduler.js';
import { warmDiscountsCache } from './models/productModel.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(resolveLocale);

app.use('/api', storeRoutes);
app.use('/api', categoryRoutes);
app.use('/api', productRoutes);
app.use('/api', storeProductRoutes);
app.use('/api', priceRoutes);
app.use('/api', userRoutes);
app.use('/api', basketRoutes);
app.use('/api', basketItemRoutes);
app.use('/api', shoppingListRoutes);
app.use('/api', shoppingListItemRoutes);
app.use('/api', receiptRoutes);
app.use('/api', swipeVoteRoutes);
app.use('/api', orphanSwipeRoutes);
app.use('/api', swipeQueueRoutes);
app.use('/api', geocodeRoutes);
app.use('/api', parserTestRoutes);
app.use('/api', adminRoutes);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Dev-only: static-serve the PNGs produced by `npm run receipts:stage`
// so the phone-side batch screen can fetch manifest.json + images over
// HTTP. We keep the old ADB-push path out — Samsung and other OEMs
// silently restrict direct reads of /Android/data/<pkg>/ in FUSE even
// though the files land physically. HTTP avoids the whole dance.
// Resolve relative to process.cwd() rather than import.meta.url —
// cwd is `basket-api/` under both `npm run dev` (ts-node) and
// `npm start` (compiled dist/), whereas import.meta.url lands in
// different spots under those two setups because of our wider
// rootDir. Concretely: dev → /…/basket-api/src/index.ts; prod →
// /…/basket-api/dist/basket-api/src/index.js — different `../`
// counts. cwd sidesteps that.
const RECEIPTS_STAGING_DIR = path.resolve(process.cwd(), 'receipts/_batch_staging');
app.use('/receipts-batch', express.static(RECEIPTS_STAGING_DIR, { fallthrough: false }));

// Dev-only: static-serve hand-annotated truth JSONs from
// /home/.../Projects/shared/receipts/<chain>/<basename>.truth.json.
// The phone's parser-test screen fetches these per receipt to score
// V1 vs V2 against ground truth. Same cwd-anchored path strategy as
// RECEIPTS_STAGING_DIR above — ../shared resolves to the repo's
// cross-stack module dir from basket-api/.
const TRUTH_DIR = path.resolve(process.cwd(), '../shared/receipts');
app.use('/receipts-truth', express.static(TRUTH_DIR, { fallthrough: false }));

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

// 404 handler for unknown routes
app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Error handler must be last
app.use(errorHandler);

export default app;
if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        warmDiscountsCache().catch(e => console.error('[Startup] Discounts cache warm failed:', e.message));
    });

    // Admin work-queue lease sweeper. Runs hourly inside this process —
    // expired leases get marked abandoned so their SPs return to the
    // global queue for other admins. No separate cron because the work
    // is one UPDATE.
    const HOUR_MS = 60 * 60 * 1000;
    const sweeper = setInterval(() => {
        import('./models/adminLeaseModel.js')
            .then(m => m.sweepExpiredLeases())
            .then(n => { if (n > 0) console.log(`[adminLease] swept ${n} expired leases`); })
            .catch(e => console.error('[adminLease] sweeper failed:', e.message));
    }, HOUR_MS);
    sweeper.unref();
}
