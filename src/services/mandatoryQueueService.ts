import pool from '../config/db.js';
import { getVotedPairKeysForUser } from '../models/receiptSwipeCandidateModel.js';
import { buildReceiptResolveCards, type ReceiptImageDims } from './receiptResolveQueueService.js';
import { buildSwipeQueueItems } from '../controllers/swipeQueueController.js';
import { buildSlot2cBackfill } from './slot2cBackfillService.js';
import { getResolvedLineIdxSet } from '../models/receiptLineResolutionModel.js';
import { capMandatoryQueue } from '../../../shared/swipeQueueCap.js';
import type { Locale } from '../middleware/locale.js';

/**
 * ONE-SHOT MANDATORY QUEUE — server-side assembly of the whole 3-card session that
 * the client previously stitched from four SEQUENTIAL requests (receipt swipe-queue
 * → relatedTo top-up → resolve-queue → orphan-backfill; measured ~4s worst case
 * behind 4 RTTs). Assembly here runs the independent parts in PARALLEL and applies
 * the exact same composition rules the client used:
 *
 *   1. receipt-anchored pair cards; if < 3, blend the relatedTo-gated global pool;
 *   2. capMandatoryQueue (slot 2 → 1 → 3 priority, cap 3);
 *   3. PREPEND the Card-B resolve cards (your own receipt's lines first), cap 3;
 *   4. still < 3 → Slot-2c receipt-scoped orphan backfill.
 *
 * SNAPSHOT CACHE (the "match is the trigger" model): the save flow calls
 * `prewarmMandatoryQueue` post-commit — matching has already run, so the card set
 * is known the moment the receipt lands. The GET then serves the snapshot after a
 * cheap REVALIDATION against the live ledgers (resolved lines + voted pairs), so a
 * vote can never resurrect a spent card. Revalidation-on-read replaces explicit
 * invalidation hooks — no write path needs to know about the cache.
 */

export interface MandatoryQueuePayload {
    cards: any[];
    image: ReceiptImageDims | null;
    slotCounts: { slot1: number; slot2: number; slot3: number };
    builtAt: number;
}

const SNAPSHOT_TTL_MS = 15 * 60_000;
const snapshots = new Map<number, { userId: string; payload: MandatoryQueuePayload }>();

const isReceiptCard = (c: any) => c?.cardKind === 'receipt';

async function assembleMandatoryQueue(
    userId: string,
    receiptId: number,
    locale: Locale,
): Promise<MandatoryQueuePayload> {
    // Stage 1 (parallel): receipt-anchored + relatedness-gated pair cards (the exact
    // build the client's first mandatory fetch used: swipe-queue?receiptId&relatedTo)
    // + the Card-B resolve cards.
    const [anchored, resolve] = await Promise.all([
        buildSwipeQueueItems(userId, receiptId, receiptId, locale),
        buildReceiptResolveCards(receiptId, pool),
    ]);
    const receiptItems = anchored.items;

    // Stage 2: relatedTo-gated global top-up only when the receipt pool is thin
    // (the expensive global build is skipped entirely on well-supplied receipts).
    let augmented = receiptItems;
    if (augmented.length < 3) {
        try {
            const { items: extras } = await buildSwipeQueueItems(userId, undefined, receiptId, locale);
            const seen = new Set(augmented.map((c: any) => c.cardId));
            const merged = [...augmented];
            for (const c of extras) {
                if (merged.length >= 3) break;
                if (seen.has(c.cardId)) continue;
                seen.add(c.cardId);
                merged.push(c);
            }
            augmented = merged;
        } catch (e) {
            console.warn('[mandatory-queue] relatedTo top-up failed (non-fatal):', (e as Error)?.message ?? e);
        }
    }
    let cards: any[] = capMandatoryQueue({ receiptItems: augmented }).items;
    if (resolve.cards.length > 0) cards = [...resolve.cards, ...cards].slice(0, 3);

    // Stage 3: Slot-2c receipt-scoped orphan backfill for any remaining free slots.
    if (cards.length < 3) {
        try {
            const backfill = await buildSlot2cBackfill(userId, receiptId, 3 - cards.length, locale);
            const seen = new Set(cards.map((c: any) => c.cardId));
            for (const item of backfill) {
                if (cards.length >= 3) break;
                if (seen.has(item.cardId)) continue;
                seen.add(item.cardId);
                cards.push({
                    cardId: item.cardId,
                    slot: 2 as const,
                    score: item.score,
                    left: { spId: item.orphanSpId, ...item.orphan },
                    right: { spId: item.candidateSpId, ...item.candidate },
                    slot2Meta: { sameChain: item.sameChain, conflictDetected: item.conflictDetected },
                });
            }
        } catch (e) {
            console.warn('[mandatory-queue] slot2c backfill failed (non-fatal):', (e as Error)?.message ?? e);
        }
    }
    return { cards, image: resolve.image, slotCounts: anchored.slotCounts, builtAt: Date.now() };
}

/**
 * REVALIDATE a snapshot against the live ledgers: drop Card-B lines the user has
 * since resolved and pair cards whose (sp,sp) pair has since been voted. Cheap
 * (two indexed reads) — this is what lets the cache skip invalidation hooks.
 */
async function revalidate(userId: string, receiptId: number, payload: MandatoryQueuePayload): Promise<MandatoryQueuePayload> {
    const [resolved, votedPairs] = await Promise.all([
        getResolvedLineIdxSet(receiptId, pool),
        getVotedPairKeysForUser(userId),
    ]);
    const cards = payload.cards.filter((c: any) => {
        if (isReceiptCard(c)) return !resolved.has(Number(c.receiptLineIdx));
        const a = Number(c?.left?.spId), b = Number(c?.right?.spId);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
        return !votedPairs.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
    });
    return { ...payload, cards };
}

/**
 * PREWARM (the save-time trigger): build + cache the receipt's mandatory queue the
 * moment the save commits. Fire-and-forget from the save flow — a failure only
 * means the GET builds live. Also warms the chain-shaped slot-3 caches so even a
 * cold live build after a server restart is fast.
 */
export async function prewarmMandatoryQueue(userId: string, receiptId: number, locale: Locale = 'lt'): Promise<void> {
    try {
        const payload = await assembleMandatoryQueue(userId, receiptId, locale);
        snapshots.set(receiptId, { userId, payload });
        console.log(`[mandatory-queue] prewarmed r${receiptId}: ${payload.cards.length} card(s)`);
    } catch (e) {
        console.warn('[mandatory-queue] prewarm failed (non-fatal):', (e as Error)?.message ?? e);
    }
}

/** Serve the mandatory queue: fresh snapshot (revalidated) when available, live build otherwise. */
export async function getMandatoryQueue(userId: string, receiptId: number, locale: Locale = 'lt'): Promise<MandatoryQueuePayload & { fromSnapshot: boolean }> {
    const snap = snapshots.get(receiptId);
    if (snap && snap.userId === userId && Date.now() - snap.payload.builtAt < SNAPSHOT_TTL_MS) {
        const revalidated = await revalidate(userId, receiptId, snap.payload);
        // A vote consumed cards since the snapshot: if enough remain, serve them; a
        // fully-consumed snapshot falls through to a live rebuild (new cards may
        // exist, e.g. a demotion opened an orphan-rescue opportunity).
        if (revalidated.cards.length > 0) {
            console.log(`[mandatory-queue] r${receiptId}: snapshot HIT (${revalidated.cards.length}/${snap.payload.cards.length} card(s) after revalidation)`);
            return { ...revalidated, fromSnapshot: true };
        }
        snapshots.delete(receiptId);
    }
    const payload = await assembleMandatoryQueue(userId, receiptId, locale);
    snapshots.set(receiptId, { userId, payload });
    return { ...payload, fromSnapshot: false };
}

/** Test seam. */
export function _clearMandatoryQueueSnapshots(): void {
    snapshots.clear();
}
