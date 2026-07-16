import './config/env.js';
import './config/sentry.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as path from 'path';
import * as fsSync from 'fs';
import pool from './config/db.js';
import storeRoutes from './routes/storeRoutes.js';
import productRoutes from './routes/productRoutes.js';
import categoryRoutes from './routes/categoryRoutes.js';
import storeProductRoutes from './routes/storeProductRoutes.js';
import priceRoutes from './routes/priceRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { resolveLocale } from './middleware/locale.js';
import { versionGate } from './middleware/versionGate.js';
import appRoutes from './routes/appRoutes.js';
import joinRoutes from './routes/joinRoutes.js';
import userRoutes from './routes/userRoutes.js';
import basketRoutes from './routes/basketRoutes.js';
import basketItemRoutes from './routes/basketItemRoutes.js';
import basketTemplateRoutes from './routes/basketTemplateRoutes.js';
import authRoutes from './routes/authRoutes.js';
import shoppingListRoutes from './routes/shoppingListRoutes.js';
import shoppingListItemRoutes from './routes/shoppingListItemRoutes.js';
import receiptRoutes from './routes/receiptRoutes.js';
import swipeVoteRoutes from './routes/swipeVoteRoutes.js';
import orphanSwipeRoutes from './routes/orphanSwipeRoutes.js';
import swipeQueueRoutes from './routes/swipeQueueRoutes.js';
import geocodeRoutes from './routes/geocodeRoutes.js';
import parserTestRoutes from './routes/parserTestRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import adminInviteRoutes from './routes/adminInviteRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import betaSignupRoutes from './routes/betaSignupRoutes.js';
import { signupLimiter, publicLimiter } from './middleware/rateLimit.js';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './config/swagger.js';
import { refreshDiscountedSummary } from './models/productModel.js';
import { startVersionTelemetry } from './services/versionTelemetry.js';
import { Sentry } from './config/sentry.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the single reverse proxy (Nginx/Traefik) in front of the API so
// `req.ip` resolves to the real client IP — required for the per-IP rate
// limiter below to bucket per visitor rather than per proxy. Assumes ONE
// proxy hop; bump the number if another hop (e.g. Cloudflare) is added.
app.set('trust proxy', 1);

// Allow-list of origins permitted to talk to this API from a browser.
// Mobile app + scripts skip preflight; only the web client needs CORS.
//
//   - localhost (5173/5174 etc.) — Vite dev server + previews
//   - 127.0.0.1 variants — same, occasionally used by tooling
//   - CORS_ORIGINS env var — comma-separated extra origins
//     (e.g. "https://souply.lt,https://app.souply.lt" in prod)
//
// Credentials are enabled because production will send the auth cookie.
const envOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
const corsAllowList = new Set<string>([
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    ...envOrigins,
]);
// Security headers. CSP is disabled — this is a JSON/asset API, not an
// HTML origin, and the default CSP would block cross-origin embedding of
// served images (avatars, assets). crossOriginResourcePolicy is relaxed to
// 'cross-origin' so the app/web can load those images from another origin.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
    origin: (origin, cb) => {
        // Same-origin requests + non-browser clients (curl, mobile) send
        // no Origin header → always allow.
        if (!origin) return cb(null, true);
        cb(null, corsAllowList.has(origin));
    },
    credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(resolveLocale);

// SLOW-REQUEST DIAGNOSTIC (receipt-342 post-swipe hang): any request taking >3s logs its
// route + duration. The stall class here is DB lock contention (a vote's FOR UPDATE vs the
// autosave PUT touching the same ReceiptItem rows) — when it recurs, this names the exact
// endpoint + timing instead of a silent client spinner. Log-only, no behavior change.
app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - t0;
        if (ms > 3000) console.warn(`[SLOW] ${req.method} ${req.originalUrl} took ${ms}ms (status ${res.statusCode})`);
    });
    next();
});

// Client version gate — reads X-Client-Platform/Version and 426s a build strictly below the
// hard floor (or flags a soft nudge via header). FAIL-OPEN + exempts version-check/health,
// so it can never brick existing installs. Runs before the routers so every /api path is
// gated uniformly. See middleware/versionGate.ts + roadmap project_roadmap_version_gating.
app.use(versionGate);

// Per-IP rate limits on the public, unauthenticated endpoints (registered
// before the routers so they run first). Strict on the beta-signup form,
// moderate on the geocode proxy and OAuth sign-in.
app.use('/api/beta-signups', signupLimiter);
app.use('/api/geocode', publicLimiter);
app.use('/api/auth/oauth', publicLimiter);

app.use('/api', appRoutes);
app.use('/api', joinRoutes);
app.use('/api', storeRoutes);
app.use('/api', categoryRoutes);
app.use('/api', productRoutes);
app.use('/api', storeProductRoutes);
app.use('/api', priceRoutes);
// authRoutes BEFORE userRoutes: its specific /users/* paths
// (username-available, @:username, me/*) must match before userRoutes'
// generic GET /users/:id, which would otherwise swallow them (→ 404).
app.use('/api', authRoutes);
app.use('/api', userRoutes);
app.use('/api', basketRoutes);
app.use('/api', basketItemRoutes);
app.use('/api', basketTemplateRoutes);
app.use('/api', shoppingListRoutes);
app.use('/api', shoppingListItemRoutes);
app.use('/api', receiptRoutes);
app.use('/api', swipeVoteRoutes);
app.use('/api', orphanSwipeRoutes);
app.use('/api', swipeQueueRoutes);
app.use('/api', geocodeRoutes);
app.use('/api', parserTestRoutes);
app.use('/api', adminRoutes);
app.use('/api', adminInviteRoutes);
app.use('/api', uploadRoutes);
app.use('/api', betaSignupRoutes);

// Interactive API docs reveal the full surface — keep them off in
// production. Available in dev/test for local exploration.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (!IS_PRODUCTION) {
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// Dev-only: static-serve the PNGs produced by `npm run receipts:stage`
// so the phone-side batch screen can fetch manifest.json + images over
// HTTP. We keep the old ADB-push path out — Samsung and other OEMs
// silently restrict direct reads of /Android/data/<pkg>/ in FUSE even
// though the files land physically. HTTP avoids the whole dance.
// Resolve relative to process.cwd() rather than import.meta.url —
// cwd is `souply-api/` under both `npm run dev` (ts-node) and
// `npm start` (compiled dist/), whereas import.meta.url lands in
// different spots under those two setups because of our wider
// rootDir. Concretely: dev → /…/souply-api/src/index.ts; prod →
// /…/souply-api/dist/souply-api/src/index.js — different `../`
// counts. cwd sidesteps that.
const ASSETS_DIR = path.resolve(process.cwd(), 'assets');
app.use('/assets', express.static(ASSETS_DIR));

// Dev-only batch/truth receipt static dirs — these can surface real
// receipt images + annotations, so never expose them in production.
if (!IS_PRODUCTION) {
    const RECEIPTS_STAGING_DIR = path.resolve(process.cwd(), 'receipts/_batch_staging');
    app.use('/receipts-batch', express.static(RECEIPTS_STAGING_DIR, { fallthrough: false }));

    // static-serve hand-annotated truth JSONs from
    // /home/.../Projects/shared/receipts/<chain>/<basename>.truth.json.
    // The phone's parser-test screen fetches these per receipt to score
    // V1 vs V2 against ground truth. Same cwd-anchored path strategy as
    // RECEIPTS_STAGING_DIR above — ../shared resolves to the repo's
    // cross-stack module dir from souply-api/.
    const TRUTH_DIR = path.resolve(process.cwd(), '../shared/receipts');
    app.use('/receipts-truth', express.static(TRUTH_DIR, { fallthrough: false }));

    // Item-truth writer: the batch DETAIL screen checkmarks products/footer
    // and posts the whole updated v2 truth file here. Written into
    // shared/receipts/<chain>/<base>.truth.json (git-versioned approvals,
    // served back by the /receipts-truth static route). truth=null deletes.
    app.post('/receipts-truth-set', express.json({ limit: '4mb' }), (req, res) => {
        try {
            const { chain, file, truth, platform } = req.body as { chain?: string; file?: string; truth?: any; platform?: string };
            if (!chain || !file || !/^[a-z]+$/.test(chain)) {
                res.status(400).json({ error: 'chain and file required' });
                return;
            }
            const base = path.basename(file).replace(/\.(pdf|png|jpg|jpeg)$/i, '');
            const dir = path.resolve(process.cwd(), '../shared/receipts', chain);
            // PER-PLATFORM truth: Android saves land in .truth.android.json
            // (its own OCR-flavor copy); iOS keeps the base file. Each combo
            // is scored against a truth in its own flavor.
            const suffix = platform === 'android' ? '.truth.android.json' : '.truth.json';
            const dest = path.join(dir, `${base}${suffix}`);
            if (truth === null) {
                fsSync.rmSync(dest, { force: true });
                console.log(`[truth-set] removed ${dest}`);
                res.json({ ok: true, removed: true });
                return;
            }
            if (!truth || truth.version !== 2 || !Array.isArray(truth.products)) {
                res.status(400).json({ error: 'truth must be a version-2 item-truth file (or null to delete)' });
                return;
            }
            fsSync.mkdirSync(dir, { recursive: true });
            fsSync.writeFileSync(dest, JSON.stringify(truth, null, 2) + '\n');
            console.log(`[truth-set] wrote ${dest} (${truth.products.length} product(s), footer=${truth.footer ? 'yes' : 'no'})`);
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ error: e?.message ?? 'write failed' });
        }
    });

    // Debug drop-box: the batch screen posts the ON-DEVICE-converted page
    // image here so the converted pixels can be inspected on the dev machine
    // (the native Core Image chain can't be observed any other way). Writes
    // to receipts/_logs/<chain>/<file>/device-converted-p<N>.png.
    app.post('/receipts-batch-debug', express.json({ limit: '64mb' }), (req, res) => {
        try {
            const { chain, file, page, pngBase64, meta } = req.body as {
                chain?: string; file?: string; page?: number; pngBase64?: string; meta?: any;
            };
            if (!chain || !file || !pngBase64 || !/^[a-z]+$/.test(chain)) {
                res.status(400).json({ error: 'chain, file, pngBase64 required' });
                return;
            }
            const safeFile = path.basename(file);
            const dir = path.resolve(process.cwd(), 'receipts/_logs', chain, safeFile);
            fsSync.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, `device-converted-p${page ?? 1}.png`);
            fsSync.writeFileSync(dest, Buffer.from(pngBase64, 'base64'));
            if (meta !== undefined) {
                fsSync.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
            }
            console.log(`[batch-debug] wrote ${dest}${meta !== undefined ? ' (+meta)' : ''}`);
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ error: e?.message ?? 'write failed' });
        }
    });
}

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

// Sentry's error handler captures any error reaching here before our own
// handler formats the JSON response. No-op when Sentry is disabled (dev/test).
Sentry.setupExpressErrorHandler(app);

// Error handler must be last
app.use(errorHandler);

export default app;
if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        refreshDiscountedSummary().catch(e => console.error('[Startup] Discounts summary refresh failed:', e.message));
        startVersionTelemetry(); // periodic flush of the client-version distribution buffer
    });

    // Scheduler (store scrapers, discount-refresh cron, daily Telegram digest)
    // runs in PRODUCTION ONLY — staging/dev must never scrape the stores.
    // Explicit ENABLE_SCHEDULER wins; otherwise default to NODE_ENV==='production'.
    // Staging is NODE_ENV=production too, so .env.staging sets ENABLE_SCHEDULER=false.
    // (The boot refreshDiscountedSummary above still runs everywhere — it only
    // re-aggregates existing price data, it does not scrape.)
    const schedulerEnabled = process.env.ENABLE_SCHEDULER
        ? process.env.ENABLE_SCHEDULER === 'true'
        : process.env.NODE_ENV === 'production';
    if (schedulerEnabled) {
        void import('./scrapers/scheduler.js').then(() => console.log('[Scheduler] enabled'));
    } else {
        console.log('[Scheduler] disabled (non-production)');
    }

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
