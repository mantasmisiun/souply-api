/**
 * Cross-chain rescue: user-confirmed PROVISIONAL StoreProduct mints + their
 * promotion to the global catalog.
 *
 * Flow: a receipt line with NO same-chain match but a viable cross-chain
 * candidate gets a swipe card (crop vs the other chain's SP — see
 * receiptResolveQueueService). An "identical" swipe calls mintProvisionalSp:
 * a new SP in the receipt's chain, copied name/photo, attached to the SAME
 * Product — but `provisional`, visible only to the minting user (excluded from
 * matching, comparisons and the discounts summary) until corroborated.
 *
 * Promotion (checkAndPromoteProvisionalSp): the per-SP confirms live in the
 * vocabulary tables (each identical swipe records a chain-scoped alias vote).
 * Two users fuzzy-matching the SAME catalog SP does not prove they bought the
 * same product — the proof is PRINT-vs-PRINT: a chain's receipt line for a
 * given product is deterministic, so two users' OCR aliases for the same
 * product differ only by OCR noise. Promotion therefore requires a CLUSTER of
 * mutually-similar aliases (confusion-weighted similarity ≥ clusterSim) held
 * by ≥ promoteDistinctUsers distinct users, with paid-price corroboration:
 * prices within priceAgreeRatio promote at K users; disagreeing prices demand
 * promoteUsersOnPriceDisagree users instead.
 */
import pool from '../config/db.js';
import { normalizeProductName } from '../utils/productNameNormalize.js';
import { weightedLevenshtein } from '../utils/ocrConfusions.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { orderPair, upsertMatchVote, applyAggregateDelta, getMatchAggregate } from '../models/storeProductMatchModel.js';
import { upsertEquivalence } from '../models/userEquivalenceModel.js';
import { reevaluateMerge } from './swipeVoteService.js';

type Connection = typeof pool | any;

const CFG = RECOGNITION.crossChainMint;

export interface MintResult {
    storeProductId: number;
    /** true = an existing SP (provisional twin or a real same-chain SP) was reused. */
    reused: boolean;
    provisional: boolean;
    /** Set when a NAME-twin (same-chain SP of a DIFFERENT Product) was reused: the
     *  caller routes the user's identical as a pair vote (twin ↔ source) so the
     *  community ledger can merge the Products (688 absorb included). */
    twin?: { twinProductId: number; sourceProductId: number; sourceSpId: number };
}

/**
 * Mint (or converge on) the receipt-chain SP for a confirmed cross-chain match.
 * Dedupe order:
 *   1. a NON-provisional same-chain SP of the same Product+size → reuse it
 *      (the catalog already has the product; no mint needed),
 *   2. an existing provisional SP minted from the same source → reuse it —
 *      this is how a SECOND user's confirm lands on the SAME provisional SP,
 *   3. otherwise INSERT the provisional SP (copied name/photo, same Product).
 */
export const mintProvisionalSp = async (
    chainId: number,
    sourceSpId: number,
    userId: string,
    conn: Connection,
): Promise<MintResult | null> => {
    const [srcRows]: any = await conn.query(
        `SELECT id, productId, chainId, storeProductName, brandName, amount, unit,
                isWeighable, imageUrl
           FROM StoreProduct WHERE id = ? LIMIT 1`,
        [sourceSpId],
    );
    const src = srcRows?.[0];
    if (!src || Number(src.chainId) === chainId) return null; // gone, or not actually cross-chain

    // 1. Real same-chain SP for this Product (+size when both sides know it).
    const [realRows]: any = await conn.query(
        `SELECT id FROM StoreProduct
          WHERE chainId = ? AND productId = ? AND provisional = 0
            AND (amount IS NULL OR ? IS NULL OR amount = ?)
            AND (unit   IS NULL OR ? IS NULL OR unit   = ?)
          LIMIT 1`,
        [chainId, src.productId, src.amount, src.amount, src.unit, src.unit],
    );
    if (realRows?.[0]) {
        return { storeProductId: Number(realRows[0].id), reused: true, provisional: false };
    }

    // 1.5 NAME-twin: a same-chain SP whose brand-stripped catalog name matches the
    // source's (receipt-346 morkos: IKI already had "Plautos morkos CLEVER" on its own
    // orphan Product island — minting would duplicate it). Catalog-vs-catalog text on
    // both sides, so the bar is tight; each side's own brandName tokens are stripped
    // first (store brands like CLEVER are naming noise, not identity). Amount/weighable
    // compatibility enforced when both sides know them — "Plautos morkos 500g" is not a
    // twin of a 1kg pack.
    const stripBrand = (name: string, brand: string | null): string => {
        let n = normalizeProductName(name ?? '');
        if (brand) {
            for (const tok of normalizeProductName(brand).split(' ')) {
                if (tok.length >= 3) n = n.split(' ').filter(t => t !== tok).join(' ');
            }
        }
        return n.trim();
    };
    const srcName = stripBrand(src.storeProductName, src.brandName ?? null);
    if (srcName) {
        const [chainSps]: any = await conn.query(
            `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName, sp.amount, sp.unit,
                    sp.isWeighable
               FROM StoreProduct sp
               JOIN Product p ON p.id = sp.productId AND p.mergedIntoId IS NULL
              WHERE sp.chainId = ? AND sp.provisional = 0`,
            [chainId],
        );
        let best: any = null; let bestSim = 0;
        for (const c of chainSps ?? []) {
            if (!!c.isWeighable !== !!src.isWeighable) continue;
            if (c.amount != null && src.amount != null &&
                (Number(c.amount) !== Number(src.amount) || (c.unit ?? null) !== (src.unit ?? null))) continue;
            const cName = stripBrand(String(c.storeProductName ?? ''), c.brandName ?? null);
            if (!cName) continue;
            const d = weightedLevenshtein(srcName, cName);
            const simV = 1 - d / Math.max(srcName.length, cName.length);
            if (simV > bestSim) { bestSim = simV; best = c; }
        }
        if (best && bestSim >= CFG.sameChainTwinSim) {
            console.log(`[MINT] name-twin reuse: SP ${best.id} "${best.storeProductName}" (sim ${bestSim.toFixed(2)}) — no duplicate minted`);
            return {
                storeProductId: Number(best.id), reused: true, provisional: false,
                twin: { twinProductId: Number(best.productId), sourceProductId: Number(src.productId), sourceSpId: sourceSpId },
            };
        }
    }

    // 2. Provisional twin minted from the same source (any owner — convergence point).
    const [twinRows]: any = await conn.query(
        `SELECT id FROM StoreProduct
          WHERE chainId = ? AND provisional = 1 AND mintedFromSpId = ?
          LIMIT 1`,
        [chainId, sourceSpId],
    );
    if (twinRows?.[0]) {
        return { storeProductId: Number(twinRows[0].id), reused: true, provisional: true };
    }

    // 3. Fresh provisional mint — same Product, copied identity.
    const [ins]: any = await conn.query(
        `INSERT INTO StoreProduct
            (productId, chainId, storeProductName, brandName, amount, unit, isWeighable,
             imageUrl, provisional, provisionalOwnerUserId, mintedFromSpId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [src.productId, chainId, src.storeProductName, src.brandName ?? null,
         src.amount ?? null, src.unit ?? null, src.isWeighable ?? 0,
         src.imageUrl ?? null, userId, sourceSpId],
    );
    console.log(`[MINT] provisional SP ${ins.insertId} in chain ${chainId} from cross-chain SP ${sourceSpId} ("${src.storeProductName}") by user ${userId}`);
    return { storeProductId: Number(ins.insertId), reused: false, provisional: true };
};

/**
 * Route a cross-chain 'identical' that landed on a NAME-twin as a standard PAIR VOTE
 * (twin ↔ source): personal equivalence edge immediately (the user's own view unifies —
 * the 688 pull), global tally + reevaluateMerge so the community threshold performs the
 * Product merge / orphan-island absorb exactly like a slot-card vote would.
 */
export const recordTwinPairVote = async (
    userId: string,
    twin: { twinProductId: number; sourceProductId: number; sourceSpId: number },
    twinSpId: number,
    receiptId: number | null,
    conn: Connection,
): Promise<void> => {
    if (!userId) return;
    const { spIdA, spIdB } = orderPair(twinSpId, twin.sourceSpId);
    const { previousVote } = await upsertMatchVote(userId, spIdA, spIdB, 'identical', null, receiptId, true, conn);
    if (previousVote === null) {
        await applyAggregateDelta(spIdA, spIdB, 'identical', +1, conn);
    } else if (previousVote !== 'identical') {
        await applyAggregateDelta(spIdA, spIdB, previousVote, -1, conn);
        await applyAggregateDelta(spIdA, spIdB, 'identical', +1, conn);
    }
    await upsertEquivalence(userId, twinSpId, twin.sourceSpId, 'same', conn);
    const agg = await getMatchAggregate(spIdA, spIdB, conn);
    await reevaluateMerge(spIdA, spIdB, agg, conn, undefined, undefined);
    console.log(`[MINT] twin pair vote recorded: SP(${spIdA},${spIdB}) by ${userId}`);
};

const sim = (a: string, b: string): number => {
    if (!a || !b) return 0;
    const d = weightedLevenshtein(a, b);
    return 1 - d / Math.max(a.length, b.length);
};

/**
 * Promotion check — run after every 'identical' confirm that lands on a
 * provisional SP. Reads the SP's alias confirms, clusters them by mutual
 * print-vs-print similarity, applies the price-corroboration rule, and
 * promotes (provisional → global) when a cluster qualifies. Idempotent.
 */
export const checkAndPromoteProvisionalSp = async (
    spId: number,
    conn: Connection,
): Promise<boolean> => {
    const [spRows]: any = await conn.query(
        `SELECT provisional FROM StoreProduct WHERE id = ? LIMIT 1`, [spId]);
    if (!spRows?.[0] || Number(spRows[0].provisional) !== 1) return false;

    // Every identical confirm: who, with which OCR print, on which receipt.
    const [confirms]: any = await conn.query(
        `SELECT a.normalizedAlias, v.userId, v.receiptId
           FROM StoreProductReceiptAlias a
           JOIN StoreProductReceiptAliasVote v ON v.aliasId = a.id
          WHERE a.storeProductId = ? AND v.vote = 'identical'`,
        [spId],
    );
    if (!confirms || confirms.length < CFG.promoteDistinctUsers) return false;

    // Paid unit price per confirm (promo if the line had one) — the receipt line
    // this confirm linked to THIS SP.
    const entries: { alias: string; userId: string; paid: number | null }[] = [];
    for (const c of confirms) {
        let paid: number | null = null;
        if (c.receiptId != null) {
            const [ri]: any = await conn.query(
                `SELECT price, promoPrice FROM ReceiptItem
                  WHERE receiptId = ? AND matchedSpId = ? LIMIT 1`,
                [c.receiptId, spId],
            );
            const row = ri?.[0];
            if (row) {
                const v = row.promoPrice != null ? Number(row.promoPrice) : Number(row.price);
                paid = Number.isFinite(v) && v > 0 ? v : null;
            }
        }
        entries.push({ alias: normalizeProductName(String(c.normalizedAlias ?? '')), userId: String(c.userId), paid });
    }

    // Greedy mutual-similarity clustering over the confirms.
    const clusters: { members: typeof entries }[] = [];
    for (const e of entries) {
        const home = clusters.find(cl => cl.members.every(m => sim(m.alias, e.alias) >= CFG.clusterSim));
        if (home) home.members.push(e);
        else clusters.push({ members: [e] });
    }

    for (const cl of clusters) {
        const users = new Set(cl.members.map(m => m.userId));
        if (users.size < CFG.promoteDistinctUsers) continue;
        const paids = cl.members.map(m => m.paid).filter((v): v is number => v != null);
        const pricesAgree = paids.length >= 2 &&
            Math.max(...paids) / Math.min(...paids) <= CFG.priceAgreeRatio;
        const needed = pricesAgree ? CFG.promoteDistinctUsers : CFG.promoteUsersOnPriceDisagree;
        if (users.size >= needed) {
            await conn.query(
                `UPDATE StoreProduct SET provisional = 0, provisionalOwnerUserId = NULL WHERE id = ?`,
                [spId],
            );
            console.log(`[MINT] PROMOTED provisional SP ${spId} → global (cluster of ${users.size} users, pricesAgree=${pricesAgree})`);
            return true;
        }
    }
    return false;
};
