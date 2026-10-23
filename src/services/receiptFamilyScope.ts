import pool from '../config/db.js';
import { isHouseholdMember } from '../models/householdModel.js';
import {
    computeFamilySubtotalCents,
    getScopedReceiptItems,
    lineTotalCents,
    setReceiptItemsScope,
} from '../models/receiptItemModel.js';
import type { ScopedItemRow } from '../models/receiptItemModel.js';
import {
    appendAdjustment,
    getReceiptAdjustmentEvents,
    getReceiptRecordedEvent,
    isReceiptRecorded,
    isReceiptSettlementLocked,
    restateReceiptRecorded,
} from '../models/householdLedgerModel.js';
import { computeShares, LedgerError } from './householdLedger.js';
import type { MemberId } from './householdLedger.js';
import { HouseholdActionError } from './householdMembership.js';

/**
 * FAMILY vs PERSONAL ITEMS — spec §4 (server half).
 *
 * §4.1/§4.2 are UI affordances; this file is the data model they sit on:
 *
 *   §4.3  only FAMILY items reach the ledger — the family subtotal, never the
 *         receipt grand total (the sum itself lives in receiptItemModel, next
 *         to the rows it sums).
 *   §4.4  the re-categorisation lock window, and what a toggle does either side
 *         of it: a silent restatement before, a visible `adjustment` after.
 *   §4.5  the non-participant read path: family items only, no grand total, no
 *         image.
 *   §8    a receipt already counted into the ledger cannot be deleted.
 *
 * THE ASYMMETRY THAT DECIDES §4.5. A "participant" in ledger terms is someone
 * who shares the COST of a receipt. That is not the same as someone entitled to
 * see what was on it: personal items are, by definition, the uploader's own
 * business, and the whole point of §4 is that they stay that way while the
 * family cost is shared. So the line this file draws is the UPLOADER vs
 * EVERYONE ELSE, not participant vs non-participant — a co-participant has no
 * more claim on the payer's personal spend than anyone else does. §3.3's "all
 * members have full rights to view and adjust items on any family trip" is
 * honoured over the FAMILY items, which are the only ones the shared money is
 * computed from.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** §4.4(b) / §9 — the fixed 72 h backstop. Not configurable. */
export const RECATEGORISATION_WINDOW_MS = 3 * DAY_MS;

// ---------------------------------------------------------------------------
// Receipt → trip → household
// ---------------------------------------------------------------------------

export interface ReceiptScopeContext {
    receiptId: number;
    /** The receipt's owner — the same subject `requireReceiptOwner` binds to. */
    ownerUserId: string;
    /** Which member uploaded it; falls back to the owner on pre-2.0 rows. */
    uploaderUserId: string;
    tripId: number | null;
    /** NULL when the trip is personal (or there is no trip): no ledger, no sharing. */
    householdId: number | null;
    uploadedAt: Date;
    receiptDate: Date | null;
    storeName: string | null;
    chainName: string | null;
    userDeletedAt: Date | null;
    /**
     * §4.4(b) — HAS THE 72 h WINDOW CLOSED? Decided by the DATABASE, comparing
     * `uploadedAt` against its own `NOW()`, never in JS.
     *
     * This is not defensiveness, it is a bug that was actually here: the pool is
     * pinned to `timezone: '+02:00'` (config/db.ts) while the dev MariaDB runs
     * on SYSTEM = UTC, so every DATETIME the driver hands back is a real instant
     * two hours (three, in summer time) EARLIER than the one stored. Comparing
     * that skewed Date against a correct `new Date()` on the API host made every
     * receipt look hours older than it is, and receipts locked early — silently,
     * and only for the ones near the boundary. Both sides of the comparison are
     * now the same clock in the same frame, so the driver's timezone setting
     * cannot affect the decision at all.
     *
     * `uploadedAt`/`receiptDate` below still carry the driver's conversion. They
     * are DISPLAY values, on the same footing as every other timestamp this API
     * already serves; nothing is decided on them.
     */
    recatWindowExpired: boolean;
    windowClosesAt: Date;
}

const toDate = (v: unknown): Date =>
    v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));

/**
 * The whole chain in one query: Receipt.tripId → Trip.householdId
 * (sql/trip_foundation.sql). Every join is LEFT — a receipt with no trip, or a
 * trip with no household, is an ordinary personal receipt, not an error.
 */
export const getReceiptScopeContext = async (receiptId: number): Promise<ReceiptScopeContext | null> => {
    const [rows]: any = await pool.query(
        `SELECT r.id, r.userId, r.uploaderUserId, r.tripId, r.uploadedAt, r.receiptDate,
                r.userDeletedAt, t.householdId, s.name AS storeName, sc.name AS chainName,
                (r.uploadedAt <= DATE_SUB(NOW(), INTERVAL ? SECOND)) AS recatWindowExpired,
                DATE_ADD(r.uploadedAt, INTERVAL ? SECOND) AS windowClosesAt
           FROM Receipt r
           LEFT JOIN Trip t ON t.id = r.tripId
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.id = ?`,
        [RECATEGORISATION_WINDOW_MS / 1000, RECATEGORISATION_WINDOW_MS / 1000, receiptId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
        receiptId: Number(r.id),
        ownerUserId: String(r.userId),
        uploaderUserId: r.uploaderUserId ? String(r.uploaderUserId) : String(r.userId),
        tripId: r.tripId == null ? null : Number(r.tripId),
        householdId: r.householdId == null ? null : Number(r.householdId),
        uploadedAt: toDate(r.uploadedAt),
        receiptDate: r.receiptDate == null ? null : toDate(r.receiptDate),
        storeName: r.storeName == null ? null : String(r.storeName),
        chainName: r.chainName == null ? null : String(r.chainName),
        userDeletedAt: r.userDeletedAt == null ? null : toDate(r.userDeletedAt),
        recatWindowExpired: Number(r.recatWindowExpired) === 1,
        windowClosesAt: toDate(r.windowClosesAt),
    };
};

// ---------------------------------------------------------------------------
// §4.4 The lock window
// ---------------------------------------------------------------------------

export type ScopeLockReason =
    /** Never counted into a ledger — there is no balance to protect. */
    | 'not-recorded'
    /** Inside the window: a toggle silently restates the receipt. */
    | 'open'
    /** §4.4(a) — a settlement was confirmed after this receipt was recorded. */
    | 'settled'
    /** §4.4(b) — more than 72 h since upload. */
    | 'expired';

export interface ScopeLockState {
    householdId: number | null;
    /** Is this receipt in a household ledger at all? */
    recorded: boolean;
    /** True once a toggle must go through an `adjustment` instead of a restatement. */
    locked: boolean;
    reason: ScopeLockReason;
    /** When the 72 h backstop closes; null when the receipt was never recorded. */
    windowClosesAt: string | null;
}

/**
 * §4.4 — editable until the EARLIER of (a) inclusion in a settlement or
 * (b) 72 h after upload.
 *
 * A receipt with no `receipt_recorded` is NOT locked and never will be by this
 * function, whatever its age. The lock exists to protect a balance; a receipt
 * that has never been counted into one has nothing to protect, and "locking" it
 * would only mean refusing to let someone tidy up an old personal receipt while
 * emitting an `adjustment` into a household ledger that does not exist. The
 * 72 h clock starts mattering the moment the receipt enters a ledger.
 *
 * The lock is MONOTONIC: `at` never moves, upload time never moves, and a
 * confirmed settlement is never un-confirmed. Once locked, always locked —
 * which is what lets the restatement path assume it will never meet a receipt
 * that already carries adjustments.
 */
export const getScopeLockState = async (ctx: ReceiptScopeContext): Promise<ScopeLockState> => {
    if (ctx.householdId == null) {
        return { householdId: null, recorded: false, locked: false, reason: 'not-recorded', windowClosesAt: null };
    }
    const recorded = await isReceiptRecorded(ctx.householdId, ctx.receiptId);
    if (!recorded) {
        return {
            householdId: ctx.householdId, recorded: false, locked: false,
            reason: 'not-recorded', windowClosesAt: null,
        };
    }
    const windowClosesAt = ctx.windowClosesAt.toISOString();
    // (a) is checked before (b) only because it is the more informative answer
    // to show a user; §4.4 takes the EARLIER of the two and both are terminal.
    if (await isReceiptSettlementLocked(ctx.householdId, ctx.receiptId)) {
        return { householdId: ctx.householdId, recorded: true, locked: true, reason: 'settled', windowClosesAt };
    }
    return {
        householdId: ctx.householdId, recorded: true, locked: ctx.recatWindowExpired,
        reason: ctx.recatWindowExpired ? 'expired' : 'open', windowClosesAt,
    };
};

// ---------------------------------------------------------------------------
// The receipt's CURRENT ledger position
// ---------------------------------------------------------------------------

interface EffectiveReceiptLedger {
    payer: MemberId;
    amountCents: number;
    /** The FROZEN participant set (§1.1), as its materialised shares. */
    shares: Record<MemberId, number>;
}

/**
 * What this receipt currently contributes to the balances: the
 * `receipt_recorded` payload, overridden by the last `adjustment` that restated
 * it (§4.4).
 *
 * An adjustment that moved money WITHOUT recording the resulting amount+shares
 * makes the receipt's current split unknowable — a later correction computed
 * against a guessed baseline would put a wrong delta into the log and the error
 * would compound silently. So that case THROWS rather than guesses. Every
 * adjustment this codebase writes carries both fields.
 */
const effectiveReceiptLedger = async (
    householdId: number, receiptId: number,
): Promise<EffectiveReceiptLedger | null> => {
    const recorded = await getReceiptRecordedEvent(householdId, receiptId);
    if (!recorded) return null;
    let out: EffectiveReceiptLedger = {
        payer: recorded.payer,
        amountCents: recorded.amountCents,
        shares: recorded.shares,
    };
    for (const adj of await getReceiptAdjustmentEvents(householdId, receiptId)) {
        const p = adj as unknown as { amountCents?: number; shares?: Record<MemberId, number> };
        if (p.amountCents === undefined || p.shares === undefined) {
            throw new LedgerError(
                `adjustment ${adj.id} on receipt ${receiptId} carries no restated amount/shares — ` +
                `the receipt's current split cannot be determined`);
        }
        out = { payer: out.payer, amountCents: p.amountCents, shares: p.shares };
    }
    return out;
};

/**
 * The zero-sum delta that moves a receipt from `amountCents` to `newAmountCents`
 * (§4.4), over its FROZEN participant set.
 *
 *   payer      : += (new − old)
 *   each share : -= (newShare − oldShare)
 *
 * Sums to zero BY CONSTRUCTION, because `sum(shares) === amountCents` holds on
 * both sides (§1.3): (new − old) − (new − old) = 0. It is not zero-sum because
 * we checked afterwards; the check in `appendAdjustment` is there to catch a
 * corrupt input, not to make the arithmetic true.
 *
 * The participant set comes from the OLD shares and is never re-derived from
 * current membership — a member who joined after this trip must not be dragged
 * into it, and one who has left must not be dropped out of it (§1.1, §3.5).
 */
export const computeScopeAdjustmentDelta = (
    receiptId: number,
    current: EffectiveReceiptLedger,
    newAmountCents: number,
): { deltaByMember: Record<MemberId, number>; shares: Record<MemberId, number> } => {
    const participants = Object.keys(current.shares);
    const shares = computeShares(receiptId, newAmountCents, participants);
    const deltaByMember: Record<MemberId, number> = {};
    const bump = (m: MemberId, v: number): void => { deltaByMember[m] = (deltaByMember[m] ?? 0) + v; };
    bump(current.payer, newAmountCents - current.amountCents);
    for (const m of participants) bump(m, -(shares[m] - current.shares[m]));
    return { deltaByMember, shares };
};

// ---------------------------------------------------------------------------
// §4.1/§4.2/§4.4 The toggle
// ---------------------------------------------------------------------------

export interface ScopeChangeResult {
    receiptId: number;
    /** Only the lines whose flag actually flipped — a no-op toggle does nothing. */
    changedLineIdxs: number[];
    isPersonal: boolean;
    familySubtotalCents: number;
    previousFamilySubtotalCents: number | null;
    /**
     * What happened to the ledger:
     *   'none'     — the receipt is not in a ledger (or nothing changed).
     *   'restated' — pre-lock: the receipt_recorded amount was silently corrected.
     *   'adjusted' — post-lock: a visible `adjustment` was appended (§4.4).
     */
    ledger: 'none' | 'restated' | 'adjusted';
    adjustment: { reason: string; deltaByMember: Record<MemberId, number> } | null;
    lock: ScopeLockState;
}

/** §3.3 — the uploader, or any member of the household the trip belongs to. */
const assertMayAdjust = async (ctx: ReceiptScopeContext, actorUserId: string): Promise<void> => {
    if (ctx.ownerUserId === actorUserId || ctx.uploaderUserId === actorUserId) return;
    if (ctx.householdId != null && await isHouseholdMember(ctx.householdId, actorUserId)) return;
    // 404, not 403: a stranger must not be able to probe which receipt ids exist.
    throw new HouseholdActionError(404, 'not-found');
};

const summarise = (names: string[], isPersonal: boolean): string => {
    const label = isPersonal ? 'to-personal' : 'to-family';
    const joined = names.filter(Boolean).join(', ');
    return joined ? `${label}: ${joined}`.slice(0, 500) : label;
};

/**
 * §4.1/§4.2 — flip one line or many (the bulk-edit path is the same call with a
 * longer list), then reconcile the ledger.
 *
 * The order is deliberate: the ITEM rows are written first, then the ledger is
 * brought in line with them. The items are the source of truth for the family
 * subtotal (§4.3); the ledger is a projection of them. Doing it the other way
 * round would leave a ledger amount that no set of items justifies if the
 * second write failed.
 */
export const setReceiptItemScope = async (args: {
    receiptId: number;
    actorUserId: string;
    lineIdxs: number[];
    isPersonal: boolean;
}): Promise<ScopeChangeResult> => {
    const ctx = await getReceiptScopeContext(args.receiptId);
    if (!ctx) throw new HouseholdActionError(404, 'not-found');
    await assertMayAdjust(ctx, args.actorUserId);

    const items = await getScopedReceiptItems(args.receiptId);
    const known = new Set(items.map(i => i.lineIdx));
    const targets = Array.from(new Set(args.lineIdxs)).filter(i => known.has(i));
    if (targets.length === 0) throw new HouseholdActionError(400, 'no-such-lines');

    let lock = await getScopeLockState(ctx);
    const before = lock.householdId != null && lock.recorded
        ? await effectiveReceiptLedger(lock.householdId, args.receiptId)
        : null;

    const changedLineIdxs = await setReceiptItemsScope(args.receiptId, targets, args.isPersonal);
    const familySubtotalCents = await computeFamilySubtotalCents(args.receiptId);

    if (changedLineIdxs.length === 0 || before === null || lock.householdId == null) {
        return {
            receiptId: args.receiptId, changedLineIdxs, isPersonal: args.isPersonal,
            familySubtotalCents, previousFamilySubtotalCents: before?.amountCents ?? null,
            ledger: 'none', adjustment: null, lock,
        };
    }

    const names = items.filter(i => changedLineIdxs.includes(i.lineIdx)).map(i => i.name);
    const householdId = lock.householdId;

    if (!lock.locked) {
        // Inside the window (§4.4): silently restate. No history entry — nobody
        // has acted on this number yet.
        //
        // The restatement re-checks the lock inside its own transaction, so a
        // settlement confirming in the gap between `getScopeLockState` above and
        // the UPDATE makes it throw. That is NOT an error to surface: the item
        // rows are already written, and failing here would leave the ledger
        // disagreeing with the items it is a projection of. The settlement
        // simply means we are now on the other side of the lock, so fall
        // through and do what that side does — append the adjustment.
        try {
            await restateReceiptRecorded({
                householdId, receiptId: args.receiptId, amountCents: familySubtotalCents,
            });
            return {
                receiptId: args.receiptId, changedLineIdxs, isPersonal: args.isPersonal,
                familySubtotalCents, previousFamilySubtotalCents: before.amountCents,
                ledger: 'restated', adjustment: null, lock,
            };
        } catch (e) {
            if (!(e instanceof LedgerError)) throw e;
            lock = { ...lock, locked: true, reason: 'settled' };
        }
    }

    // Locked (§4.4): the re-categorisation still works, but it moves balances
    // with an audit trail everyone can see.
    const reason = summarise(names, args.isPersonal);
    const { deltaByMember, shares } = computeScopeAdjustmentDelta(args.receiptId, before, familySubtotalCents);
    await appendAdjustment({
        householdId,
        receiptId: args.receiptId,
        reason,
        deltaByMember,
        actorUserId: args.actorUserId,
        amountCents: familySubtotalCents,
        shares,
        previousAmountCents: before.amountCents,
    });
    return {
        receiptId: args.receiptId, changedLineIdxs, isPersonal: args.isPersonal,
        familySubtotalCents, previousFamilySubtotalCents: before.amountCents,
        ledger: 'adjusted', adjustment: { reason, deltaByMember }, lock,
    };
};

// ---------------------------------------------------------------------------
// §4.5 The non-participant read path
// ---------------------------------------------------------------------------

export interface FamilyReceiptItemView {
    lineIdx: number;
    name: string;
    price: number | null;
    promoPrice: number | null;
    quantity: number | null;
    unit: string | null;
    amount: number | null;
    sizeUnit: string | null;
    isWeighable: boolean;
    storeProductId: number | null;
    matchedName: string | null;
    storeProductImageUrl: string | null;
    categoryId: number | null;
    categoryName: string | null;
    categoryL2Name: string | null;
    lineTotalCents: number;
}

export interface FamilyReceiptStats {
    itemCount: number;
    /** Identical to the view's familySubtotalCents — family items only. */
    subtotalCents: number;
    promoItemCount: number;
    promoSavingsCents: number;
    categoryBreakdown: { name: string; totalCents: number }[];
}

export interface FamilyReceiptView {
    receiptId: number;
    tripId: number | null;
    householdId: number;
    storeName: string | null;
    chainName: string | null;
    receiptDate: string | null;
    uploadedAt: string;
    uploaderUserId: string;
    familyItems: FamilyReceiptItemView[];
    /** §4.3 — visible BY DESIGN. The grand total is what must never be. */
    familySubtotalCents: number;
    stats: FamilyReceiptStats;
    lock: ScopeLockState;
}

/** §4.5 — stats "computed over family items only". */
const familyStats = (familyItems: ScopedItemRow[]): FamilyReceiptStats => {
    const catMap = new Map<string, number>();
    let subtotalCents = 0;
    let promoItemCount = 0;
    let promoSavingsCents = 0;
    for (const it of familyItems) {
        const cents = lineTotalCents(it);
        subtotalCents += cents;
        const promo = it.promoPrice ?? 0;
        const regular = it.price ?? 0;
        if (promo > 0 && regular > promo) {
            promoItemCount += 1;
            promoSavingsCents += Math.max(0, Math.round((regular - promo) * (it.quantity || 1) * 100));
        }
        const cat = it.categoryL2Name || it.categoryName || 'Nepriskirta';
        catMap.set(cat, (catMap.get(cat) ?? 0) + cents);
    }
    return {
        itemCount: familyItems.length,
        subtotalCents,
        promoItemCount,
        promoSavingsCents,
        categoryBreakdown: Array.from(catMap.entries())
            .map(([name, totalCents]) => ({ name, totalCents }))
            .sort((a, b) => b.totalCents - a.totalCents || (a.name < b.name ? -1 : 1)),
    };
};

/**
 * §4.5 — what a household member who did NOT upload the receipt may read.
 *
 * BUILT AS AN ALLOWLIST, NOT A REDACTION. Every field below is named
 * explicitly; the Receipt row is never spread. That is the point: the existing
 * `GET /receipts/:id` returns `SELECT r.*`, so a redaction-based version of
 * this endpoint would start leaking the day somebody adds a column, and the
 * leak would be silent. Adding a field here takes a deliberate edit.
 *
 * DELIBERATELY ABSENT, and why:
 *   · `parsedData` in any form — it carries `footer.total`, THE printed grand
 *     total, plus totalSavings / comboDiscount / appliedDiscounts /
 *     maximaMoney / loyalty / reconDelta, several of which reconstruct it.
 *     The family subtotal is visible by design, so a grand total anywhere here
 *     gives personal spend away by subtraction. It is the whole reason this is
 *     a separate response object rather than a filtered receipt.
 *   · `savedAmount` — a Receipt COLUMN, and the one that would have ridden in
 *     unnoticed on `r.*`. It is savings against market averages over ALL items,
 *     personal ones included, so it is a (noisy) function of the grand total.
 *   · personal items, and any count or total of them — a personal item count
 *     plus the family subtotal is a partial disclosure for no product value.
 *   · `filePath` / any image URL — §4.5's third bullet. The image shows the
 *     personal items in printed form; `GET /receipts/:id/image` stays bound to
 *     `requireReceiptOwner`, so a non-uploader gets 403 there.
 *   · the comparison basket (`currentChain.total`) — a whole-receipt total by
 *     another name; that route also stays owner-bound.
 *
 * Returns null when the viewer may not see it — the caller answers 404 for
 * both "no such receipt" and "not your household", so neither is probeable.
 */
export const getFamilyReceiptView = async (args: {
    receiptId: number;
    viewerUserId: string;
}): Promise<FamilyReceiptView | null> => {
    const ctx = await getReceiptScopeContext(args.receiptId);
    if (!ctx) return null;
    // Not a family trip → there is no family view of it, for anybody.
    if (ctx.householdId == null) return null;
    if (ctx.userDeletedAt != null) return null;
    if (!await isHouseholdMember(ctx.householdId, args.viewerUserId)) return null;

    const familyItems = (await getScopedReceiptItems(args.receiptId)).filter(i => !i.isPersonal);
    const stats = familyStats(familyItems);
    return {
        receiptId: ctx.receiptId,
        tripId: ctx.tripId,
        householdId: ctx.householdId,
        storeName: ctx.storeName,
        chainName: ctx.chainName,
        receiptDate: ctx.receiptDate ? ctx.receiptDate.toISOString() : null,
        uploadedAt: ctx.uploadedAt.toISOString(),
        uploaderUserId: ctx.uploaderUserId,
        familyItems: familyItems.map(i => ({
            lineIdx: i.lineIdx,
            name: i.name,
            price: i.price,
            promoPrice: i.promoPrice,
            quantity: i.quantity,
            unit: i.unit,
            amount: i.amount,
            sizeUnit: i.sizeUnit,
            isWeighable: i.isWeighable,
            storeProductId: i.matchedSpId,
            matchedName: i.matchedName,
            storeProductImageUrl: i.storeProductImageUrl,
            categoryId: i.categoryId,
            categoryName: i.categoryName,
            categoryL2Name: i.categoryL2Name,
            lineTotalCents: lineTotalCents(i),
        })),
        familySubtotalCents: stats.subtotalCents,
        stats,
        lock: await getScopeLockState(ctx),
    };
};

// ---------------------------------------------------------------------------
// §8 Receipt deletion
// ---------------------------------------------------------------------------

/**
 * §8 — "A receipt that has been counted into the ledger CANNOT be deleted. It
 * can only be corrected via an `adjustment` event."
 *
 * Deleting it would strand its shares: the fold would keep applying an event
 * whose receipt no longer exists, or — worse, if the event went too — silently
 * move every member's balance with nothing in the history to explain it. The
 * correction path (§4.4) exists exactly so that the honest version of "this
 * receipt was wrong" is available without deleting anything.
 *
 * Throws HouseholdActionError(423) so the controller answers Locked, matching
 * the existing "too late to remove this scan" gate on the same route.
 */
export const assertReceiptDeletable = async (receiptId: number): Promise<void> => {
    const ctx = await getReceiptScopeContext(receiptId);
    if (!ctx || ctx.householdId == null) return;
    if (await isReceiptRecorded(ctx.householdId, receiptId)) {
        throw new HouseholdActionError(423, 'receipt-counted-in-ledger');
    }
};
