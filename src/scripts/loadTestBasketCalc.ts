/**
 * Concurrency / load test for the basket price calc (dev DB only).
 *
 *   npx tsx src/scripts/loadTestBasketCalc.ts
 *
 * Simulates N people hitting "Stores" at the same instant. Fires N concurrent
 * calculateBasketForStores() calls (same shared DB pool the HTTP endpoint uses)
 * at rising concurrency levels and reports success/failure/latency — so a pool
 * exhaustion ("Queue limit reached") or crash shows up as failures, not a hang.
 */
import 'dotenv/config';
import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import { calculateBasketForStores } from '../services/basketCalculationService.js';

const VILNIUS = { lat: 54.6872, lng: 25.2797 };
const BASKET_SIZE = Number(process.env.LT_BASKET ?? 40);
// A logged-in viewer WITH real equivalence data → the personal-merge tier does
// real work (heaviest fan-out). Override with LT_VIEWER.
const VIEWER = process.env.LT_VIEWER ?? '67b7cfaa-2069-4d3b-aa6e-c752f9c7c1f8';
const LEVELS = (process.env.LT_LEVELS ?? '10,25,50,75,100').split(',').map(Number);

const ms = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;
const pct = (arr: number[], p: number) => arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

async function pickItems() {
    const [rows]: any = await pool.query(
        `SELECT p.id, p.name FROM Product p
           JOIN StoreProduct sp ON sp.productId = p.id
          WHERE p.mergedIntoId IS NULL AND p.name IS NOT NULL AND p.name <> ''
            AND p.categoryId <> ?
          GROUP BY p.id HAVING COUNT(DISTINCT sp.chainId) >= 3
          ORDER BY p.id LIMIT ?`,
        [MatchThresholds.nepriskirtaCategoryId, BASKET_SIZE],
    );
    return rows.map((r: any) => ({
        productId: Number(r.id), quantity: 1, matchMode: 'sku' as const,
        name: String(r.name), anchorAmount: null, anchorUnit: null,
    }));
}

async function oneCall(items: any[]): Promise<{ ok: boolean; ms: number; err?: string }> {
    const t0 = process.hrtime();
    try {
        const res = await calculateBasketForStores(0, { lat: VILNIUS.lat, lng: VILNIUS.lng, items, userId: VIEWER });
        return { ok: Array.isArray(res) && res.length > 0, ms: ms(process.hrtime(t0)) };
    } catch (e: any) {
        return { ok: false, ms: ms(process.hrtime(t0)), err: String(e?.message ?? e) };
    }
}

async function main() {
    const items = await pickItems();
    console.log(`Load test — basket ${items.length} items, viewer=logged-in, pool: connLimit=${process.env.DB_POOL_SIZE || 20} queueLimit=${process.env.DB_QUEUE_LIMIT || 256}`);
    // Warm the catalog cache once so we measure steady-state, not the cold load.
    await oneCall(items);

    for (const n of LEVELS) {
        const wall0 = process.hrtime();
        const results = await Promise.all(Array.from({ length: n }, () => oneCall(items)));
        const wall = ms(process.hrtime(wall0));
        const ok = results.filter(r => r.ok).length;
        const failed = results.filter(r => !r.ok);
        const lat = results.map(r => r.ms);
        const errs = new Map<string, number>();
        for (const f of failed) errs.set(f.err ?? 'empty-result', (errs.get(f.err ?? 'empty-result') ?? 0) + 1);
        const flag = ok === n ? '✅' : '❌';
        console.log(`\n${flag} concurrency ${String(n).padStart(2)} | ok ${ok}/${n} | wall ${wall.toFixed(0)}ms | latency p50 ${pct(lat, 0.5).toFixed(0)} / p95 ${pct(lat, 0.95).toFixed(0)} / max ${Math.max(...lat).toFixed(0)}ms`);
        for (const [e, c] of errs) console.log(`     ↳ ${c}× ${e.slice(0, 90)}`);
    }

    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
