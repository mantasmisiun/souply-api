/**
 * Basket-calc benchmark + match-quality probe (dev DB only).
 *
 *   npx tsx src/scripts/basketCalcBenchmark.ts
 *
 * Pulls 40 varied real Products (spread across categories, a mix of weighable
 * and fixed-pack), builds a basket, prices it across the 10 nearest Vilnius
 * stores, and reports: wall time (cold vs warm catalog cache), the tier each
 * item resolved at, and the matched StoreProduct name/price per item.
 */
import 'dotenv/config';
import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import { calculateBasketForStores } from '../services/basketCalculationService.js';

const VILNIUS = { lat: 54.6872, lng: 25.2797 };
const N = 40;

function ms(t: [number, number]): number {
    return t[0] * 1000 + t[1] / 1e6;
}

async function pickProducts() {
    // Candidate pool: products carried by ≥3 chains (genuinely comparable),
    // with a real name. Grab enough to stratify across categories.
    const [rows]: any = await pool.query(
        `SELECT p.id, p.name, p.categoryId,
                MAX(sp.isWeighable) AS weighable,
                COUNT(DISTINCT sp.chainId) AS chains
           FROM Product p
           JOIN StoreProduct sp ON sp.productId = p.id
          WHERE p.mergedIntoId IS NULL
            AND p.name IS NOT NULL AND p.name <> ''
            AND p.categoryId <> ?
          GROUP BY p.id
         HAVING chains >= 3
          ORDER BY chains DESC, p.id`,
        [MatchThresholds.nepriskirtaCategoryId],
    );

    // Round-robin across categories for variety; guarantee some weighable items.
    const byCat = new Map<number, any[]>();
    for (const r of rows) {
        const c = Number(r.categoryId);
        if (!byCat.has(c)) byCat.set(c, []);
        byCat.get(c)!.push(r);
    }
    const cats = [...byCat.keys()];
    const picked: any[] = [];
    const seen = new Set<number>();
    let i = 0;
    while (picked.length < N && cats.length) {
        const cat = cats[i % cats.length];
        const bucket = byCat.get(cat)!;
        const next = bucket.shift();
        if (next && !seen.has(next.id)) { picked.push(next); seen.add(next.id); }
        if (!bucket.length) cats.splice(cats.indexOf(cat), 1); else i++;
    }
    // Ensure at least ~8 weighable items are present (swap in from the pool).
    const weCount = picked.filter(p => p.weighable).length;
    if (weCount < 8) {
        const extra = rows.filter((r: any) => r.weighable && !seen.has(r.id)).slice(0, 8 - weCount);
        for (const e of extra) { picked.pop(); picked.push(e); seen.add(e.id); }
    }
    return picked.slice(0, N);
}

async function main() {
    const products = await pickProducts();
    const items = products.map((p, idx) => {
        const weighable = !!p.weighable;
        // Quantities are in CANONICAL units (kg/l/count). Weighable → 0.5/1 kg;
        // fixed-pack → 1 canonical unit (avoids the artifact where "2" means 2 kg
        // of an 80 g bar = ~24 packs). Realistic per-pack quantities are the
        // app's job to convert; this benchmark targets timing + match quality.
        const quantity = weighable ? (idx % 2 === 0 ? 0.5 : 1) : 1;
        return {
            productId: Number(p.id),
            quantity,
            matchMode: 'sku' as const,
            name: String(p.name),
            anchorAmount: null,
            anchorUnit: null,
        };
    });

    console.log(`Basket: ${items.length} products | weighable: ${products.filter(p => p.weighable).length} | categories: ${new Set(products.map(p => p.categoryId)).size}`);

    const opts = { lat: VILNIUS.lat, lng: VILNIUS.lng, items, userId: undefined };

    // Cold run — catalog cache empty (first getCachedChainCandidates hits DB).
    const c0 = process.hrtime();
    const cold = await calculateBasketForStores(0, opts);
    const coldMs = ms(process.hrtime(c0));

    // Warm runs — catalog cache hot; isolates the compute cost.
    const warmTimes: number[] = [];
    let warm: any = cold;
    for (let k = 0; k < 3; k++) {
        const w0 = process.hrtime();
        warm = await calculateBasketForStores(0, opts);
        warmTimes.push(ms(process.hrtime(w0)));
    }
    const warmAvg = warmTimes.reduce((a, b) => a + b, 0) / warmTimes.length;

    console.log(`\n⏱  cold: ${coldMs.toFixed(0)} ms | warm avg: ${warmAvg.toFixed(0)} ms (runs: ${warmTimes.map(t => t.toFixed(0)).join(', ')}) | stores priced: ${cold.length}`);

    // Tier distribution across ALL (store × item) resolutions.
    const tierOf = (it: any): string =>
        it.isMissing ? 'MISSING'
            : it.isCrossChainAverage ? 'TIER4-xchain'
                : it.isSubstituted ? 'TIER3-substitute'
                    : Number(it.resolvedProductId) === Number(it.productId) ? 'TIER1-exact'
                        : 'TIER2-linked/base';
    const dist = new Map<string, number>();
    let cells = 0;
    for (const store of warm) {
        for (const it of store.items) {
            dist.set(tierOf(it), (dist.get(tierOf(it)) ?? 0) + 1);
            cells++;
        }
    }
    console.log(`\nTier distribution (${cells} store×item cells):`);
    for (const [t, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${t.padEnd(20)} ${n}  (${((n / cells) * 100).toFixed(1)}%)`);
    }

    // Per-item quality at the CHEAPEST store (most representative single basket).
    const cheapest = [...warm].sort((a, b) => a.total - b.total)[0];
    console.log(`\nCheapest store: ${cheapest.chainName} #${cheapest.storeId} — total €${cheapest.total} | missing: ${cheapest.missingItemNames.length} | approx: ${cheapest.isApproximated}`);
    console.log(`\n${'PRODUCT'.padEnd(42)} ${'QTY'.padEnd(5)} ${'TIER'.padEnd(20)} ${'MATCHED'.padEnd(42)} ${'€EFF'.padEnd(7)} LINE`);
    for (const it of cheapest.items) {
        const name = String(it.productName).slice(0, 40).padEnd(42);
        const qty = String(it.quantity).padEnd(5);
        const tier = tierOf(it).padEnd(20);
        const matched = String(it.storeProductName ?? '—').slice(0, 40).padEnd(42);
        const eff = (it.effectivePrice != null ? it.effectivePrice.toFixed(2) : '—').padEnd(7);
        const line = it.totalPrice != null ? `€${it.totalPrice.toFixed(2)}` : '—';
        console.log(`${name} ${qty} ${tier} ${matched} ${eff} ${line}`);
    }

    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
