import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { swipeLog, resetSwipeLog } from '../utils/swipeLogger.js';
import { getReceiptRelatednessScope, isCardRelated } from '../services/receiptRelatednessService.js';
import { fetchVotedPairKeys } from '../models/votedPairsModel.js';
import { fetchSlot1Rows, type RawSlot1Row } from '../models/slot1CandidateModel.js';
import { fetchAllSlot2Rows } from '../models/slot2CandidateModel.js';
import { fetchSlot3Rows } from '../models/slot3CandidateModel.js';
import { buildSlot2Queue } from '../services/slot2QueueBuilder.js';
import { buildSlot3Queue } from '../services/slot3QueueBuilder.js';
import { castSlot2Vote } from '../services/slot2VoteService.js';
import { castDirectSpPairVote } from '../services/directSpPairVoteService.js';
import { withDeadlockRetry } from '../utils/withDeadlockRetry.js';
import type { SwipeVote } from '../services/swipeVoteService.js';
import { getUserPointsProfile } from '../services/userPointsService.js';
import { refillUserOrphansIfMissing } from '../services/orphanRefillService.js';
import type { Locale } from '../middleware/locale.js';
import { capVoluntaryQueue, composeVoluntaryReceiptDeck } from '../../../shared/swipeQueueCap.js';
import { buildReceiptResolveCards } from '../services/receiptResolveQueueService.js';
import { buildSlot2cBackfill } from '../services/slot2cBackfillService.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

const VALID_VOTES: SwipeVote[] = ['identical', 'similar', 'different'];

// ── Types ──────────────────────────────────────────────────────────────────

interface SwipeCardSide {
    spId: number;
    productId: number;
    name: string;
    brandName: string | null;
    imageUrl: string | null;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    categoryId: number;
    categoryName: string;
}

interface SwipeQueueCard {
    cardId: string;
    slot: 1 | 2 | 3;
    score: number;
    left: SwipeCardSide;
    right: SwipeCardSide;
    slot2Meta?: {
        sameChain: boolean;
        conflictDetected: boolean;
    };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function canonicalKey(spA: number, spB: number): string {
    return `${Math.min(spA, spB)}-${Math.max(spA, spB)}`;
}

/**
 * Build the Slot 1 card list from raw DB rows.
 * Deduplicates (same canonical pair from multiple anchors), filters voted
 * pairs, and sorts descending by cross-chain similarity score.
 */
function buildSlot1Queue(
    rows: RawSlot1Row[],
    votedPairKeys: Set<string>,
    label = 'global',
): SwipeQueueCard[] {
    const seen = new Set<string>();
    const items: SwipeQueueCard[] = [];
    let dup = 0, voted = 0;

    // [GLOBAL-QUEUE] funnel — CONSOLE-visible (unlike swipeLog, which only writes
    // swipe-debug.log): for every cross-chain "related" candidate pair, why it does or
    // doesn't become a swipe card. Answers "what was considered + why N available". The
    // deeper per-anchor GENERATION trace (why only N raw pairs exist) is [Slot1] in
    // swipe-debug.log.
    console.log(`[GLOBAL-QUEUE] slot1 (${label}): ${rows.length} raw cross-chain candidate pair(s) generated`);

    for (const row of rows) {
        const key = canonicalKey(row.leftSpId, row.rightSpId);
        const pair = `SP${row.leftSpId} ${JSON.stringify(row.left?.name)} ⇄ SP${row.rightSpId} ${JSON.stringify(row.right?.name)} score=${row.score.toFixed(3)}`;
        if (seen.has(key)) { dup++; console.log(`[GLOBAL-QUEUE]   ✗ ${pair} → SKIP duplicate pair (same SPs from another anchor)`); continue; }
        if (votedPairKeys.has(key)) { voted++; console.log(`[GLOBAL-QUEUE]   ✗ ${pair} → SKIP already-voted (no-repeat: you swiped this pair before)`); continue; }
        seen.add(key);

        // Enforce canonical (smaller spId = left) for consistent card rendering.
        const isCanonical = row.leftSpId < row.rightSpId;
        const leftSpId  = isCanonical ? row.leftSpId  : row.rightSpId;
        const rightSpId = isCanonical ? row.rightSpId : row.leftSpId;
        const leftSide  = isCanonical ? row.left      : row.right;
        const rightSide = isCanonical ? row.right     : row.left;

        items.push({
            cardId: key,
            slot: 1,
            score: row.score,
            left:  { spId: leftSpId,  ...leftSide },
            right: { spId: rightSpId, ...rightSide },
        });
        console.log(`[GLOBAL-QUEUE]   ✓ ${pair} → SERVED`);
    }

    items.sort((a, b) => b.score - a.score);
    console.log(`[GLOBAL-QUEUE]   => ${items.length} slot1 card(s) available (filtered ${dup} duplicate, ${voted} already-voted)`);
    return items;
}

/** Parse spIdA, spIdB from a canonical cardId string. Returns null on invalid input. */
function parseCardId(cardId: unknown): { spIdA: number; spIdB: number } | null {
    if (typeof cardId !== 'string') return null;
    const parts = cardId.split('-');
    if (parts.length !== 2) return null;
    const spIdA = parseInt(parts[0], 10);
    const spIdB = parseInt(parts[1], 10);
    if (!Number.isFinite(spIdA) || !Number.isFinite(spIdB)) return null;
    return { spIdA, spIdB };
}

// ── Pipeline diagnostics ───────────────────────────────────────────────────

async function logReceiptPipeline(receiptId: number): Promise<void> {
    // Show receipt metadata
    const [receiptRows]: any = await pool.query(
        `SELECT r.id, r.mandatorySwipesRequired, r.mandatorySwipesCompleted,
                r.storeId, s.chainId, sc.name AS chainName
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.id = ?`,
        [receiptId],
    );
    const rec = (receiptRows as any[])[0];
    if (rec) {
        swipeLog(`[Pipeline] receipt ${receiptId}: storeId=${rec.storeId ?? 'NULL'} chain=${rec.chainName ?? 'NONE'}(${rec.chainId ?? '?'}) mandatory=${rec.mandatorySwipesCompleted}/${rec.mandatorySwipesRequired}`);
    }

    // Show every ReceiptSwipeCandidate for this receipt
    const [candidates]: any = await pool.query(
        `SELECT rsc.storeProductId, rsc.matchScore, rsc.autoMatched,
                COALESCE(sp.storeProductName, p.name) AS spName,
                sp.chainId, sc.name AS chainName
           FROM ReceiptSwipeCandidate rsc
           JOIN StoreProduct sp ON sp.id = rsc.storeProductId
           JOIN Product p ON p.id = sp.productId
           JOIN StoreChain sc ON sc.id = sp.chainId
          WHERE rsc.receiptId = ?
          ORDER BY rsc.matchScore DESC`,
        [receiptId],
    );
    swipeLog(`[Pipeline] ReceiptSwipeCandidate rows: ${(candidates as any[]).length}`);
    for (const c of candidates as any[]) {
        const flags = `autoMatched=${c.autoMatched} score=${Number(c.matchScore).toFixed(3)} chain=${c.chainName}(${c.chainId})`;
        swipeLog(`[Pipeline]   spId=${c.storeProductId} "${c.spName}" — ${flags}`);
    }

    // Show every Price row saved for this receipt
    const [prices]: any = await pool.query(
        `SELECT pr.storeProductId, pr.price,
                COALESCE(sp.storeProductName, p.name) AS spName,
                sp.chainId, sc.name AS chainName, p.categoryId, cat.name AS catName
           FROM Price pr
           JOIN StoreProduct sp ON sp.id = pr.storeProductId
           JOIN Product p ON p.id = sp.productId
           JOIN StoreChain sc ON sc.id = sp.chainId
           JOIN Category cat ON cat.id = p.categoryId
          WHERE pr.receiptId = ?`,
        [receiptId],
    );
    swipeLog(`[Pipeline] Price rows saved: ${(prices as any[]).length}`);
    for (const p of prices as any[]) {
        swipeLog(`[Pipeline]   spId=${p.storeProductId} "${p.spName}" price=${p.price} chain=${p.chainName} cat=${p.catName}(${p.categoryId})`);
    }
}

// ── Controllers ────────────────────────────────────────────────────────────

/**
 * Assemble the prioritised swipe cards (slot 2 → 1 → 3) for a user, applying the
 * relatedness gate when `relatedTo` is set. Extracted so BOTH GET /swipe-queue and
 * the voluntary-count endpoint build the queue through ONE code path — the count
 * and the served queue can never drift. Returns the cards + pre-gate slot counts.
 */
export async function buildSwipeQueueItems(
    userId: string,
    receiptIdParam: number | undefined,
    relatedTo: number | undefined,
    locale: Locale,
): Promise<{ items: SwipeQueueCard[]; slotCounts: { slot1: number; slot2: number; slot3: number } }> {
    // votedPairKeys is fetched FIRST (cheap indexed read) so slot-2a can advance a
    // rejected top OSC candidate to the orphan's next-ranked one (reject → next):
    // without the voted set, 2a would re-emit the voted rank-1 pair only for
    // buildSlot2Queue to drop it, hiding the orphan forever instead of offering #2.
    const votedPairKeys = await fetchVotedPairKeys(userId);
    const [slot1Rows, slot2Rows, slot3Rows] = await Promise.all([
        fetchSlot1Rows(userId, receiptIdParam, locale),
        fetchAllSlot2Rows(userId, receiptIdParam, locale, votedPairKeys),
        fetchSlot3Rows(userId, receiptIdParam, locale),
    ]);

    const slot2Items = buildSlot2Queue(slot2Rows, votedPairKeys);
    const slot1Items = buildSlot1Queue(slot1Rows, votedPairKeys, receiptIdParam !== undefined ? `receipt-anchored r${receiptIdParam}` : 'global');
    const slot3Items = buildSlot3Queue(slot3Rows, votedPairKeys);

    const slot2Cards: SwipeQueueCard[] = slot2Items.map(item => ({
        cardId: item.cardId,
        slot: 2 as const,
        score: item.score,
        left:  { spId: item.orphanSpId,    ...item.orphan },
        right: { spId: item.candidateSpId, ...item.candidate },
        slot2Meta: { sameChain: item.sameChain, conflictDetected: item.conflictDetected },
    }));
    const slot3Cards: SwipeQueueCard[] = slot3Items.map(item => ({
        cardId: item.cardId,
        slot: 3 as const,
        score: item.score,
        left:  { spId: item.spIdA, ...item.left },
        right: { spId: item.spIdB, ...item.right },
    }));

    let items: SwipeQueueCard[] = [...slot2Cards, ...slot1Items, ...slot3Cards];

    if (relatedTo !== undefined && Number.isFinite(relatedTo)) {
        const scope = await getReceiptRelatednessScope(relatedTo, pool);
        const before = items.length;
        const slot1Before = items.filter((c) => c.slot === 1).length;
        items = items.filter((c) =>
            isCardRelated({ categoryId: c.left.categoryId, name: c.left.name, imageUrl: c.left.imageUrl }, scope) ||
            isCardRelated({ categoryId: c.right.categoryId, name: c.right.name, imageUrl: c.right.imageUrl }, scope),
        );
        const slot1After = items.filter((c) => c.slot === 1).length;
        swipeLog(`[Relatedness] relatedTo=${relatedTo} scope: ${scope.categoryIds.size} cats, ${scope.lineNames.length} line-names → kept ${items.length}/${before}`);
        if (slot1Before !== slot1After) {
            console.log(`[GLOBAL-QUEUE] relatedness gate (relatedTo=${relatedTo}): dropped ${slot1Before - slot1After} slot1 card(s) not related to the receipt → ${slot1After} kept`);
        }
    }

    return { items, slotCounts: { slot1: slot1Items.length, slot2: slot2Items.length, slot3: slot3Items.length } };
}

/** Voluntary slot-2c fetch depth. Bounds the receipt-scoped orphan backfill so it
 *  can fill leftover voluntary capacity (receipt budget 9, cap 10) while reliably
 *  surfacing the receipt's OWN 688 orphan seeds (prioritised inside the builder). */
const VOLUNTARY_SLOT2C_K = RECOGNITION.queue.voluntaryReceiptHalf;

/**
 * Receipt-scoped Slot-2c orphan backfill shaped as voluntary SwipeQueueCards —
 * the SAME buildSlot2cBackfill the mandatory queue uses (mandatoryQueueService
 * Stage 3), mirrored into the VOLUNTARY receipt pool so the receipt's own 688
 * orphan lines reliably appear instead of only ever showing in the mandatory
 * session. Cards are ordinary slot-2 cards, so the slot2 vote endpoint and the
 * no-repeat ledgers (voted-pairs via fetchVotedPairKeys + OrphanSwipeCandidate.
 * resolved, both applied inside buildSlot2cBackfill) handle them unchanged and
 * nothing re-shows after resolution. `existingCardIds` dedups against any 2a/2b
 * card of the same canonical pair already in the pool. Fail-open: any error
 * yields [] so the queue still serves. The cap is enforced downstream by
 * capVoluntaryQueue — these cards only ever fill leftover capacity.
 */
export async function buildVoluntarySlot2cCards(
    userId: string,
    receiptId: number,
    locale: Locale,
    existingCardIds: Set<string> = new Set(),
): Promise<SwipeQueueCard[]> {
    try {
        const backfill = await buildSlot2cBackfill(userId, receiptId, VOLUNTARY_SLOT2C_K, locale);
        const out: SwipeQueueCard[] = [];
        for (const item of backfill) {
            if (existingCardIds.has(item.cardId)) continue;
            existingCardIds.add(item.cardId);
            out.push({
                cardId: item.cardId,
                slot: 2 as const,
                score: item.score,
                left: { spId: item.orphanSpId, ...item.orphan },
                right: { spId: item.candidateSpId, ...item.candidate },
                slot2Meta: { sameChain: item.sameChain, conflictDetected: item.conflictDetected },
            });
        }
        return out;
    } catch (e) {
        console.warn('[voluntary-slot2c] backfill failed (non-fatal):', (e as Error)?.message ?? e);
        return [];
    }
}

/**
 * GET /api/users/:userId/swipe-queue
 *
 * Returns a prioritised list of swipe cards for the user:
 *   Slot 2 (orphan rescue) → Slot 1 (cross-chain identity) → Slot 3 (same-chain dedup)
 *
 * Cards contain only product identity (name, image, brand, chain).
 * Price and pack-size are intentionally excluded to prevent economic bias.
 */
export const getSwipeQueue = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
        if (!userId) {
            res.status(400).json({ error: 'userId is required' });
            return;
        }

        // When a receiptId is supplied the client is in the pre-comparison
        // mandatory flow. Slot 1 anchors to ONLY that receipt's SPs so older
        // receipts don't inject unrelated cross-chain pairs. Slot 3 always uses
        // its standard logic (receipt-anchored first, then global scoped to the
        // same chains) so there are always enough cards to reach 3 — private-label
        // products that have no cross-chain match fall back to global same-chain fill.
        const receiptIdParam = typeof req.query.receiptId === 'string' && req.query.receiptId.length > 0
            ? Number(req.query.receiptId)
            : undefined;
        // `voluntary=1` is set by the Nepriskirta-modal pink button. All three
        // slots still fire so the client's `capVoluntaryQueue` has a receipt-
        // anchored pool to draw from. For a RECEIPT-scoped voluntary session the
        // deck is relevance-only (this receipt's crops + 688 rescues + anchored
        // identity cards, slot 2 → 1 → 3, no global fill); only the no-receipt
        // community path draws the global pool. We also fire an on-demand refill of
        // OrphanSwipeCandidate for the user's missing orphans — the current response
        // uses whatever OSC rows already exist; the refill benefits the next visit.
        const voluntary = req.query.voluntary === '1' || req.query.voluntary === 'true';

        resetSwipeLog(`swipe-queue userId=${userId} receiptId=${receiptIdParam ?? 'none'} voluntary=${voluntary}`);

        if (receiptIdParam !== undefined) {
            await logReceiptPipeline(receiptIdParam);
        }

        if (voluntary) {
            // Fire-and-forget refill. Loading the snapshot (~100k Products +
            // trigram index) is heavy and we don't want to block the queue
            // response on it. The user will benefit from the refill on
            // their NEXT request — the current response uses whatever OSC
            // rows already exist. This is the right trade-off because
            // most voluntary visits land on already-seeded orphans
            // anyway (the seed script runs nightly).
            refillUserOrphansIfMissing(userId)
                .then(n => { if (n > 0) swipeLog(`[Voluntary] background refill produced ${n} OSC rows`); })
                .catch(e => swipeLog(`[Voluntary] background refill failed: ${(e as Error).message}`));
        }

        // Relatedness gate: a receipt-SCOPED fetch (receiptId present) gates to ITS OWN
        // receipt even when the client didn't pass `relatedTo`; only the global pool
        // (receiptId=none) stays ungated. Item assembly + the gate live in
        // buildSwipeQueueItems so the voluntary-count endpoint uses the same path.
        const relatedToParam = typeof req.query.relatedTo === 'string' && req.query.relatedTo.length > 0
            ? Number(req.query.relatedTo)
            : undefined;
        const relatedTo = relatedToParam ?? receiptIdParam;
        if (relatedTo === undefined || !Number.isFinite(relatedTo)) {
            swipeLog(`[Relatedness] relatedTo NOT supplied — global cards UNGATED (receiptId=${receiptIdParam ?? 'none'})`);
        }

        const { items, slotCounts } = await buildSwipeQueueItems(userId, receiptIdParam, relatedTo, req.locale);

        // VOLUNTARY receipt pool: PREPEND the receipt-scoped Slot-2c orphan backfill so
        // the receipt's own 688 orphan lines reach the voluntary session too (the
        // mandatory queue already does this; the voluntary build previously never did).
        // Prepended (not appended) so the receipt's OWN 688 rescues (slot-2c, seeds
        // first) rank AHEAD of the precomputed 2a/2b slot-2 cards within slot 2 — the
        // client's capVoluntaryQueue regroups by slot and takes them in this order, so
        // the receipt's uncategorised items are never crowded out. Cross-slot order is
        // irrelevant (regrouped); only the within-slot-2 order matters. Mirrored in
        // getVoluntaryQueueCount so the badge equals what opens.
        let outItems = items;
        if (voluntary && receiptIdParam !== undefined && Number.isFinite(receiptIdParam)) {
            const slot2c = await buildVoluntarySlot2cCards(
                userId, receiptIdParam, req.locale, new Set(items.map((c) => c.cardId)),
            );
            if (slot2c.length > 0) {
                outItems = [...slot2c, ...items];
                swipeLog(`[Voluntary] slot-2c backfill prepended ${slot2c.length} receipt-orphan card(s) (ranked ahead of 2a/2b in slot 2)`);
            }
        }

        swipeLog(`[SwipeQueue] userId=${userId} receiptId=${receiptIdParam ?? 'none'} → slot1=${slotCounts.slot1} slot2=${slotCounts.slot2} slot3=${slotCounts.slot3} total=${outItems.length}`);
        for (const card of outItems) {
            swipeLog(`[SwipeQueue]   [slot${card.slot}] "${card.left.name}" (${card.left.chainName}) vs "${card.right.name}" (${card.right.chainName}) score=${card.score.toFixed(3)}`);
        }
        // CONSOLE summary (the per-card list above is in swipe-debug.log). This is the POOL the
        // client draws from — the client mixes it with Card-B crop cards and caps the session via
        // capVoluntaryQueue (shared/swipeQueueCap.ts). So a low slot1 here = few related candidates
        // existed, NOT a cap; a high slot1 that still serves few on-device = the client cap.
        console.log(`[GLOBAL-QUEUE] pool for receipt ${receiptIdParam ?? 'none'}: slot1(cross-chain related)=${slotCounts.slot1} · slot2(orphan-rescue)=${slotCounts.slot2} · slot3(same-chain dedup)=${slotCounts.slot3} · total=${outItems.length}`);

        res.json({ items: outItems, slotCounts });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/users/:userId/voluntary-queue-count?receiptId=…
 *
 * SINGLE SOURCE OF TRUTH for the "Improve price comparison" button's badge. Runs the
 * EXACT receipt-scoped voluntary served-queue assembly server-side — the receipt's own
 * relatedTo-gated pool + slot-2c through capVoluntaryQueue in relevance-only mode (NO
 * global fill), plus up to voluntaryCropComfortCap prepended Card-B crop cards — and
 * returns the final count. The button hides at 0 and shows a number that equals what
 * actually opens (kills the "advertises 10 → opens empty" divergence, which came from
 * the old count omitting the relatedTo gate AND the resolve-queue cards).
 */
export const getVoluntaryQueueCount = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
        if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
        const receiptId = typeof req.query.receiptId === 'string' && req.query.receiptId.length > 0
            ? Number(req.query.receiptId)
            : undefined;
        if (receiptId === undefined || !Number.isFinite(receiptId)) {
            res.status(400).json({ error: 'receiptId is required' });
            return;
        }

        // Mirror SwipeQueue.loadQueue's RECEIPT-SCOPED voluntary branch exactly
        // (relevance-only — NO global "community" pool):
        //   receiptItems = swipe-queue(receiptId, relatedTo=receiptId) + slot-2c (seeds first)
        //   capVoluntaryQueue({receiptItems, globalItems:[], receiptScoped:true});
        //   then prepend ≤voluntaryCropComfortCap Card-B crops, cap 10.
        const receiptPool = await buildSwipeQueueItems(userId, receiptId, receiptId, req.locale);
        // PREPEND the SAME receipt-scoped Slot-2c backfill the served queue adds (seeds
        // ranked ahead of 2a/2b in slot 2) so this count equals what actually opens.
        const slot2c = await buildVoluntarySlot2cCards(
            userId, receiptId, req.locale, new Set(receiptPool.items.map((c) => c.cardId)),
        );
        const receiptItems = slot2c.length > 0 ? [...slot2c, ...receiptPool.items] : receiptPool.items;
        const capped = capVoluntaryQueue({ receiptItems, globalItems: [], receiptScoped: true }).items;

        // Crops (Card-B) fill FIRST up to the comfort cap; the remainder is the capped
        // slot pool. Matches the client's `[...crops.slice(0,cap), ...capped].slice(0,10)`.
        const cropCap = RECOGNITION.queue.voluntaryCropComfortCap;
        const conn = await (pool as any).getConnection();
        let cardBCount = 0;
        try {
            const { cards } = await buildReceiptResolveCards(receiptId, conn, cropCap, /* quiet */ true);
            cardBCount = cards.length;
        } finally {
            conn.release();
        }

        // Count via the SAME shared merge the served client deck uses (crops up to the
        // comfort cap, then slot cards, cap 10) so the badge can never diverge from what
        // actually opens — placeholder crop ids stand in for the cardBCount crop cards.
        const cropPlaceholders = Array.from({ length: cardBCount }, (_, i) => ({ cardId: `crop-${i}` }));
        const count = composeVoluntaryReceiptDeck(cropPlaceholders, capped, cropCap).length;
        res.json({ count });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/users/:userId/swipe-vote
 *
 * Vote handler for Slot 1 and Slot 3 cards (direct SP pair, no rescue logic).
 * Body: { spIdA: number, spIdB: number, vote: 'identical'|'similar'|'different', dwellMs: number }
 */
export const submitDirectVote = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
        if (!userId) {
            res.status(400).json({ error: 'userId is required' });
            return;
        }

        const { spIdA, spIdB, vote, dwellMs, receiptId } = req.body ?? {};

        if (!VALID_VOTES.includes(vote)) {
            res.status(400).json({ error: 'vote must be identical, similar, or different' });
            return;
        }
        if (!Number.isFinite(spIdA) || !Number.isFinite(spIdB)) {
            res.status(400).json({ error: 'spIdA and spIdB must be numbers' });
            return;
        }

        // Deadlock-retried: the vote txn's demotion (SELECT … FOR UPDATE on ReceiptItem)
        // can deadlock against a concurrent autosave's replaceReceiptItems — the whole
        // vote transaction is rolled back by MySQL, so the only correct recovery is to
        // re-run the entire vote (receipt-232's lost third-card vote).
        const result = await withDeadlockRetry(() => castDirectSpPairVote({
            userId,
            spIdA: Number(spIdA),
            spIdB: Number(spIdB),
            vote,
            dwellMs: Number.isFinite(dwellMs) ? Number(dwellMs) : 0,
            // Optional — present when the card came from a receipt's swipe queue;
            // lets a 'different' vote demote the rejected line back to OCR.
            receiptId: Number.isFinite(receiptId) ? Number(receiptId) : null,
        }), { label: `direct vote ${spIdA}-${spIdB}` });

        const { level } = await getUserPointsProfile(userId);
        res.json({ ...result, level });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/users/:userId/swipe-vote/slot2
 *
 * Vote handler for Slot 2 cards (orphan rescue). Requires knowing which SP
 * is the orphan so the rescue logic executes on the correct side.
 * Body: {
 *   orphanSpId: number,
 *   candidateSpId: number,
 *   vote: 'identical'|'similar'|'different',
 *   dwellMs: number,
 *   conflictDetected: boolean,
 *   sameChain: boolean
 * }
 */
export const submitSlot2Vote = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
        if (!userId) {
            res.status(400).json({ error: 'userId is required' });
            return;
        }

        const { orphanSpId, candidateSpId, vote, dwellMs, conflictDetected, sameChain } =
            req.body ?? {};

        if (!VALID_VOTES.includes(vote)) {
            res.status(400).json({ error: 'vote must be identical, similar, or different' });
            return;
        }
        if (!Number.isFinite(orphanSpId) || !Number.isFinite(candidateSpId)) {
            res.status(400).json({ error: 'orphanSpId and candidateSpId must be numbers' });
            return;
        }

        const result = await castSlot2Vote({
            userId,
            orphanSpId: Number(orphanSpId),
            candidateSpId: Number(candidateSpId),
            vote,
            dwellMs: Number.isFinite(dwellMs) ? Number(dwellMs) : 0,
            conflictDetected: !!conflictDetected,
            sameChain: !!sameChain,
        });

        const { level } = await getUserPointsProfile(userId);
        res.json({ ...result, level });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/users/:userId/receipts/:receiptId/orphan-backfill?k=N
 *
 * Slot 2c — receipt-scoped orphan BACKFILL for the mandatory session. The client
 * calls this ONLY when the receipt's own pool (Card-B + slots) left free mandatory
 * slots; the response fills them with orphan-rescue cards RELATED to the receipt
 * (its category family + chain; name+price composite; highest pair wins). Cards
 * are ordinary slot-2 cards — the existing slot2 vote endpoint + no-repeat ledger
 * handle them unchanged. Serves fewer than k (or none) when nothing clears the
 * floor: an honest short session beats junk.
 */
export const getOrphanBackfill = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
        const receiptId = Number(req.params.receiptId);
        const k = Math.min(3, Math.max(1, Number(req.query.k) || 1));
        if (!userId || !Number.isFinite(receiptId) || receiptId <= 0) {
            res.status(400).json({ error: 'userId and receiptId are required' });
            return;
        }
        // Ownership: the receipt must belong to the (token-pinned) user.
        const [own]: any = await pool.query('SELECT userId FROM Receipt WHERE id = ?', [receiptId]);
        if (!own?.[0] || String(own[0].userId) !== userId) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        const items = await buildSlot2cBackfill(userId, receiptId, k, req.locale);
        res.json({
            items: items.map((item) => ({
                cardId: item.cardId,
                slot: 2 as const,
                score: item.score,
                left: { spId: item.orphanSpId, ...item.orphan },
                right: { spId: item.candidateSpId, ...item.candidate },
                slot2Meta: { sameChain: item.sameChain, conflictDetected: item.conflictDetected },
            })),
        });
    } catch (error) {
        next(error);
    }
};
