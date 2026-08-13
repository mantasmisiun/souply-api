import pool from '../config/db.js';
import {
    assertDeltaSumsToZero,
    assertSharesSum,
    computeShares,
    deriveLedgerState,
    LedgerError,
} from '../services/householdLedger.js';
import type {
    AdjustmentEvent,
    LedgerEvent,
    LedgerState,
    MemberId,
    ReceiptRecordedEvent,
} from '../services/householdLedger.js';

/**
 * HouseholdLedgerEvent — the append-only event log (spec §1.1, sql/household_ledger.sql).
 *
 * APPEND-ONLY IS THIS FILE'S JOB. There is no delete, and exactly ONE update:
 * `restateReceiptRecorded`, the §4.4 pre-lock correction, whose whole docstring
 * is the argument for why it is allowed to exist and what bounds it. Every
 * other query in here writes nothing but an INSERT. Balances are never stored:
 * `getLedgerState` folds the log every time (see services/householdLedger.ts),
 * so there is no cached number to go stale.
 *
 * Every write re-asserts §1.3's guarantee on the exact bytes being inserted and
 * THROWS on violation — a bad row in this table would skew every future balance
 * of that household forever, so it must never land.
 */

const TABLE = 'HouseholdLedgerEvent';

type AppendableType = LedgerEvent['type'];

/** Row shape as stored. */
interface LedgerRow {
    id: number;
    type: AppendableType;
    at: Date | string;
    payload: unknown;
}

const toIso = (at: Date | string): string =>
    at instanceof Date ? at.toISOString() : new Date(String(at).replace(' ', 'T')).toISOString();

/** MariaDB hands JSON back as a (sometimes double-encoded) string. */
const parsePayload = (raw: unknown): Record<string, unknown> => {
    let val: unknown = raw;
    for (let i = 0; i < 2 && typeof val === 'string'; i++) {
        try { val = JSON.parse(val); } catch { throw new LedgerError('ledger payload is not valid JSON'); }
    }
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
        throw new LedgerError('ledger payload is not a JSON object');
    }
    return val as Record<string, unknown>;
};

const rowToEvent = (row: LedgerRow): LedgerEvent => ({
    id: Number(row.id),
    at: toIso(row.at),
    type: row.type,
    ...parsePayload(row.payload),
} as LedgerEvent);

interface AppendArgs {
    householdId: number;
    type: AppendableType;
    at: Date;
    payload: Record<string, unknown>;
    receiptId?: number | null;
    settlementId?: string | null;
    actorUserId?: MemberId | null;
    /** Set only for the at-most-once event types. */
    dedupeKey?: string | null;
}

const isDuplicate = (e: unknown): boolean =>
    !!e && typeof e === 'object' && (e as { code?: string }).code === 'ER_DUP_ENTRY';

/**
 * The single INSERT path. When `dedupeKey` collides the append is a NO-OP and
 * the ALREADY-STORED event comes back — re-posting a receipt must not
 * double-count it, and re-confirming a settlement must not move money twice.
 */
const append = async (args: AppendArgs): Promise<LedgerEvent> => {
    const { householdId, type, at, payload } = args;
    if (!Number.isInteger(householdId) || householdId <= 0) {
        throw new LedgerError(`householdId must be a positive integer, got ${JSON.stringify(householdId)}`);
    }
    try {
        const [res]: any = await pool.query(
            `INSERT INTO ${TABLE} (householdId, type, at, receiptId, settlementId, actorUserId, payload, dedupeKey)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                householdId,
                type,
                at,
                args.receiptId ?? null,
                args.settlementId ?? null,
                args.actorUserId ?? null,
                JSON.stringify(payload),
                args.dedupeKey ?? null,
            ],
        );
        return { id: Number(res.insertId), at: at.toISOString(), type, ...payload } as LedgerEvent;
    } catch (e) {
        if (isDuplicate(e) && args.dedupeKey) {
            const existing = await getEventByDedupeKey(householdId, args.dedupeKey);
            if (existing) return existing;
        }
        throw e;
    }
};

const getEventByDedupeKey = async (householdId: number, dedupeKey: string): Promise<LedgerEvent | null> => {
    const [rows]: any = await pool.query(
        `SELECT id, type, at, payload FROM ${TABLE} WHERE householdId = ? AND dedupeKey = ? LIMIT 1`,
        [householdId, dedupeKey],
    );
    return rows.length ? rowToEvent(rows[0]) : null;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every event for a household, in log order. `at` first (§1.4: events are
 * ordered by server timestamp), `id` as the tie-break so the order is TOTAL and
 * the fold is deterministic even for events written in the same millisecond.
 * Served straight off idx_hle_household (householdId, at, id).
 */
export const getLedgerEvents = async (householdId: number): Promise<LedgerEvent[]> => {
    const [rows]: any = await pool.query(
        `SELECT id, type, at, payload FROM ${TABLE} WHERE householdId = ? ORDER BY at ASC, id ASC`,
        [householdId],
    );
    return (rows as LedgerRow[]).map(rowToEvent);
};

/** Balances + membership + pending settlements, folded fresh from the log. */
export const getLedgerState = async (householdId: number): Promise<LedgerState> =>
    deriveLedgerState(await getLedgerEvents(householdId));

/**
 * One stored event plus the columns that are NOT part of the folded event.
 *
 * `actorUserId` is lifted out rather than merged into `LedgerEvent`: the fold
 * must never see it (an `adjustment` and a `member_left` would start carrying
 * an extra member id into `deriveLedgerState`'s switch), but the history feed
 * cannot say WHO made an adjustment without it — `adjustment`'s payload
 * deliberately has no actor field. Two shapes, one row.
 */
export interface LedgerEventRecord {
    event: LedgerEvent;
    /** Payer / joiner / leaver / proposer / confirmer. NULL on old or system rows. */
    actorUserId: MemberId | null;
}

export interface LedgerEventPage {
    records: LedgerEventRecord[];
    /** Opaque keyset cursor for the NEXT (older) page; null when the log ends. */
    nextCursor: string | null;
}

/** Bounds on `limit` — a caller cannot ask for the whole log in one request. */
export const LEDGER_PAGE_DEFAULT = 20;
export const LEDGER_PAGE_MAX = 50;

/**
 * The cursor's timestamp is carried as the DATABASE'S OWN STRING, never as an
 * ISO instant.
 *
 * `at` is DATETIME(3) and the pool is pinned to `timezone: '+02:00'` while the
 * server runs UTC (config/db.ts — the same trap documented on
 * receiptFamilyScope's 72 h window). Round-tripping `at` out through the driver
 * as a Date and back in as a parameter puts two timezone conversions either
 * side of a `<` comparison, and a two-hour skew in a keyset cursor does not
 * error — it silently skips or repeats a page. Formatting in SQL and comparing
 * against a string literal keeps both sides in the column's own frame, with no
 * conversion anywhere in the path.
 */
const CURSOR_AT_FORMAT = '%Y-%m-%d %H:%i:%s.%f';

interface Cursor { d: string; id: number; }

const encodeCursor = (atRaw: string, id: number): string =>
    Buffer.from(JSON.stringify({ d: atRaw, id } as Cursor), 'utf8').toString('base64url');

/** Malformed → treated as absent (the storeProductMatchModel precedent): a bad
 *  cursor restarts the feed rather than 500ing on a value the client can't fix. */
const decodeCursor = (raw: string | undefined): Cursor | null => {
    if (!raw) return null;
    try {
        const { d, id } = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (typeof d !== 'string' || !Number.isInteger(id)) return null;
        return { d, id };
    } catch { return null; }
};

/**
 * A PAGE of the log, NEWEST FIRST — the read behind the §5.2 history feed.
 *
 * `getLedgerEvents` above deliberately stays unpaginated: the fold needs every
 * event or the balances are wrong. This is the other direction — a feed a human
 * scrolls — and the log grows forever, so it must not be loaded whole.
 *
 * The order is the EXACT REVERSE of the fold's total order (`at ASC, id ASC`):
 * `at DESC, id DESC`, keyset-paginated on the same `(at, id)` pair. Reversing
 * the fold's order rather than inventing one matters — `at` is caller-supplied
 * on every append, so an id-only cursor would disagree with the order the
 * balances are derived in, and an entry could sort into a different position in
 * the feed than it occupies in the ledger. Served off idx_hle_household
 * (householdId, at, id), backwards.
 *
 * Keyset, not OFFSET: an append landing while the user scrolls shifts every
 * offset by one and duplicates a row across pages. `(at, id)` is unique and
 * immutable, so a page boundary means the same thing forever.
 *
 * `types` is an ALLOWLIST, applied in SQL. The feed renders four kinds and
 * filtering client-side would make `limit` meaningless (a page of 20 could
 * return 3 entries once a household's proposals outnumber its confirms).
 *
 * limit+1 is fetched to detect a next page without a second COUNT.
 */
export const getLedgerEventsPage = async (
    householdId: number,
    opts: { limit?: number; cursor?: string; types?: AppendableType[] } = {},
): Promise<LedgerEventPage> => {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? LEDGER_PAGE_DEFAULT) || LEDGER_PAGE_DEFAULT, 1), LEDGER_PAGE_MAX);

    const where: string[] = ['householdId = ?'];
    const params: any[] = [householdId];
    if (opts.types && opts.types.length > 0) {
        where.push('type IN (?)');
        params.push(opts.types);
    }
    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
        where.push('(at < ? OR (at = ? AND id < ?))');
        params.push(cursor.d, cursor.d, cursor.id);
    }
    params.push(limit + 1);

    const [rows]: any = await pool.query(
        `SELECT id, type, at, payload, actorUserId,
                DATE_FORMAT(at, '${CURSOR_AT_FORMAT}') AS atRaw
           FROM ${TABLE}
          WHERE ${where.join(' AND ')}
          ORDER BY at DESC, id DESC
          LIMIT ?`,
        params,
    );
    const all = rows as (LedgerRow & { atRaw: string; actorUserId: string | null })[];
    const page = all.slice(0, limit);
    const last = page[page.length - 1];
    return {
        records: page.map((r) => ({
            event: rowToEvent(r),
            actorUserId: r.actorUserId ? String(r.actorUserId) : null,
        })),
        nextCursor: all.length > limit && last ? encodeCursor(last.atRaw, Number(last.id)) : null,
    };
};

/**
 * The `settlement_proposed` events behind a set of settlement ids.
 *
 * A `settlement_confirmed` payload carries only `{ settlementId, by }` — the
 * amount and the two parties live on the PROPOSAL (see
 * `appendSettlementConfirmed`: not repeating the amount is what stops a confirm
 * disagreeing with what was proposed). The feed renders confirmations, so it
 * has to look the proposals up; and because a page boundary can fall between a
 * proposal and its confirmation, it cannot rely on both being in the same page.
 * One indexed batch lookup off idx_hle_settlement, bounded by the page size.
 */
export const getSettlementProposals = async (
    householdId: number, settlementIds: string[],
): Promise<Map<string, { from: MemberId; to: MemberId; amountCents: number; by: MemberId }>> => {
    const out = new Map<string, { from: MemberId; to: MemberId; amountCents: number; by: MemberId }>();
    const ids = Array.from(new Set(settlementIds)).filter(Boolean);
    if (ids.length === 0) return out;
    const [rows]: any = await pool.query(
        `SELECT settlementId, payload FROM ${TABLE}
          WHERE householdId = ? AND type = 'settlement_proposed' AND settlementId IN (?)`,
        [householdId, ids],
    );
    for (const r of rows as { settlementId: string; payload: unknown }[]) {
        const p = parsePayload(r.payload) as unknown as {
            from: MemberId; to: MemberId; amountCents: number; by: MemberId;
        };
        out.set(String(r.settlementId), {
            from: p.from, to: p.to, amountCents: p.amountCents, by: p.by,
        });
    }
    return out;
};

export interface PendingProposal {
    householdId: number;
    settlementId: string;
    from: MemberId;
    to: MemberId;
    amountCents: number;
    /** Who proposed — the OTHER party is the one who must confirm (§3.2.1). */
    by: MemberId;
    proposedAt: string;
}

/**
 * Every settlement proposed before `proposedBefore` and not yet confirmed,
 * ACROSS ALL HOUSEHOLDS. This is the 7-day auto-confirm sweeper's only input
 * (§3.2.2); the age cutoff is pushed into SQL so the job never drags the whole
 * proposal history into memory just to discard it.
 *
 * A read, not a write — the append-only property is untouched.
 */
export const getPendingProposals = async (proposedBefore: Date): Promise<PendingProposal[]> => {
    const [rows]: any = await pool.query(
        `SELECT p.householdId, p.at, p.payload
           FROM ${TABLE} p
          WHERE p.type = 'settlement_proposed'
            AND p.at < ?
            AND NOT EXISTS (
                SELECT 1 FROM ${TABLE} c
                 WHERE c.householdId = p.householdId
                   AND c.settlementId = p.settlementId
                   AND c.type = 'settlement_confirmed')
          ORDER BY p.at ASC, p.id ASC`,
        [proposedBefore],
    );
    return (rows as { householdId: number; at: Date | string; payload: unknown }[]).map((r) => {
        const p = parsePayload(r.payload) as unknown as {
            settlementId: string; from: MemberId; to: MemberId; amountCents: number; by: MemberId;
        };
        return {
            householdId: Number(r.householdId),
            settlementId: p.settlementId,
            from: p.from,
            to: p.to,
            amountCents: p.amountCents,
            by: p.by,
            proposedAt: toIso(r.at),
        };
    });
};

/** Whether a receipt has already been counted into the ledger (§8: it then can never be deleted). */
export const isReceiptRecorded = async (householdId: number, receiptId: number): Promise<boolean> => {
    const [rows]: any = await pool.query(
        `SELECT 1 FROM ${TABLE} WHERE householdId = ? AND receiptId = ? AND type = 'receipt_recorded' LIMIT 1`,
        [householdId, receiptId],
    );
    return rows.length > 0;
};

/** The receipt's own `receipt_recorded`, or null when it was never counted. */
export const getReceiptRecordedEvent = async (
    householdId: number, receiptId: number,
): Promise<ReceiptRecordedEvent | null> => {
    const [rows]: any = await pool.query(
        `SELECT id, type, at, payload FROM ${TABLE}
          WHERE householdId = ? AND receiptId = ? AND type = 'receipt_recorded'
          ORDER BY at ASC, id ASC LIMIT 1`,
        [householdId, receiptId],
    );
    return rows.length ? (rowToEvent(rows[0]) as ReceiptRecordedEvent) : null;
};

/** Every `adjustment` written against a receipt, in log order (§4.4 audit trail). */
export const getReceiptAdjustmentEvents = async (
    householdId: number, receiptId: number,
): Promise<AdjustmentEvent[]> => {
    const [rows]: any = await pool.query(
        `SELECT id, type, at, payload FROM ${TABLE}
          WHERE householdId = ? AND receiptId = ? AND type = 'adjustment'
          ORDER BY at ASC, id ASC`,
        [householdId, receiptId],
    );
    return (rows as LedgerRow[]).map(rowToEvent) as AdjustmentEvent[];
};

/**
 * §4.4(a) — "the receipt being included in a settlement".
 *
 * No settlement ever references a receipt: a settlement clears a BALANCE, and a
 * balance is a fold over many receipts. So "included in a settlement" can only
 * mean POSITIONAL — a receipt was included in every settlement confirmed after
 * it entered the log, because its amount was part of the balance that
 * settlement cleared. Hence: locked once a `settlement_confirmed` sits AFTER
 * this receipt's `receipt_recorded` in the log.
 *
 * The comparison is `(at, id)` — byte-for-byte the total order
 * `getLedgerEvents` folds in (`ORDER BY at ASC, id ASC`), and the same reason
 * that order is total: `at` is the §1.4 server timestamp and `id` breaks ties
 * within a millisecond. It is NOT `id` alone, which would be wrong: `at` is
 * caller-supplied on every append, so a row inserted later can legitimately
 * carry an earlier timestamp, and id-order and fold-order then disagree.
 *
 * The direction matters as much as the comparison. A settlement confirmed
 * BEFORE the receipt was recorded cannot have included it — without that half,
 * one historical settlement would lock every future receipt of that household
 * forever.
 *
 * Done as ONE self-join so the comparison happens on the native DATETIME(3)
 * columns inside the DB: round-tripping `at` out to an ISO string and back
 * through mysql2 would put a timezone conversion in the middle of a lock
 * decision.
 */
export const isReceiptSettlementLocked = async (
    householdId: number, receiptId: number,
): Promise<boolean> => {
    const [rows]: any = await pool.query(
        `SELECT 1
           FROM ${TABLE} r
           JOIN ${TABLE} c
             ON c.householdId = r.householdId
            AND c.type = 'settlement_confirmed'
            AND (c.at > r.at OR (c.at = r.at AND c.id > r.id))
          WHERE r.householdId = ? AND r.receiptId = ? AND r.type = 'receipt_recorded'
          LIMIT 1`,
        [householdId, receiptId],
    );
    return rows.length > 0;
};

// ---------------------------------------------------------------------------
// Appends (§1.1)
// ---------------------------------------------------------------------------

/**
 * §1.3 — split the family subtotal and store the shares ON the event.
 *
 * `computeShares` throws unless the split adds up, and `assertSharesSum` runs
 * again on the payload object that is about to be serialised. Both are THROWS,
 * not logs: there is no safe way to record a receipt whose shares do not sum to
 * its amount.
 *
 * `participants` is the set captured AT UPLOAD TIME (§1.1) — that is the whole
 * mechanism by which later joins and leaves never re-split a past trip.
 */
export const appendReceiptRecorded = async (args: {
    householdId: number;
    receiptId: number;
    payer: MemberId;
    /** FAMILY subtotal (§4.3), integer cents. */
    amountCents: number;
    participants: MemberId[];
    at?: Date;
}): Promise<LedgerEvent> => {
    const shares = computeShares(args.receiptId, args.amountCents, args.participants);
    const payload = {
        receiptId: args.receiptId,
        payer: args.payer,
        amountCents: args.amountCents,
        shares,
    };
    // Belt and braces: assert on the object that is actually being written.
    assertSharesSum(payload.amountCents, payload.shares);
    return append({
        householdId: args.householdId,
        type: 'receipt_recorded',
        at: args.at ?? new Date(),
        payload,
        receiptId: args.receiptId,
        actorUserId: args.payer,
        dedupeKey: `receipt:${args.receiptId}`,
    });
};

export const appendMemberJoined = async (args: {
    householdId: number; member: MemberId; at?: Date;
}): Promise<LedgerEvent> => append({
    householdId: args.householdId,
    type: 'member_joined',
    at: args.at ?? new Date(),
    payload: { member: args.member },
    actorUserId: args.member,
});

export const appendMemberLeft = async (args: {
    householdId: number; member: MemberId; at?: Date;
}): Promise<LedgerEvent> => append({
    householdId: args.householdId,
    type: 'member_left',
    at: args.at ?? new Date(),
    payload: { member: args.member },
    actorUserId: args.member,
});

/**
 * §3.2.1 — "Mark as settled" writes ONLY this. It moves no money; the
 * counterparty (or the 7-day lapse) has to confirm before anything changes.
 */
export const appendSettlementProposed = async (args: {
    householdId: number;
    settlementId: string;
    from: MemberId;
    to: MemberId;
    amountCents: number;
    by: MemberId;
    at?: Date;
}): Promise<LedgerEvent> => {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
        throw new LedgerError(`settlement amountCents must be a positive integer, got ${JSON.stringify(args.amountCents)}`);
    }
    if (args.from === args.to) throw new LedgerError('a settlement needs two distinct parties');
    return append({
        householdId: args.householdId,
        type: 'settlement_proposed',
        at: args.at ?? new Date(),
        payload: {
            settlementId: args.settlementId,
            from: args.from,
            to: args.to,
            amountCents: args.amountCents,
            by: args.by,
        },
        settlementId: args.settlementId,
        actorUserId: args.by,
        dedupeKey: `propose:${args.settlementId}`,
    });
};

/**
 * The ONLY event that moves a settlement's money (§1.2).
 *
 * The amount is NOT repeated here — it is read from the proposal during the
 * fold, so a confirm can never disagree with what was proposed. Confirming
 * something that was never proposed throws rather than inventing a transfer.
 *
 * `by` is recorded for the history feed and ignored by the fold, which is what
 * makes the phase-2 auto-confirm job state-identical to a manual confirm.
 */
export const appendSettlementConfirmed = async (args: {
    householdId: number; settlementId: string; by: MemberId; at?: Date;
}): Promise<LedgerEvent> => {
    const proposal = await getEventByDedupeKey(args.householdId, `propose:${args.settlementId}`);
    if (!proposal) {
        throw new LedgerError(`cannot confirm settlement ${args.settlementId}: no proposal in this household`);
    }
    return append({
        householdId: args.householdId,
        type: 'settlement_confirmed',
        at: args.at ?? new Date(),
        payload: { settlementId: args.settlementId, by: args.by },
        settlementId: args.settlementId,
        actorUserId: args.by,
        dedupeKey: `confirm:${args.settlementId}`,
    });
};

/**
 * §4.4/§8 — the ONLY way to correct a receipt that is already in the ledger.
 * Receipts are never deleted and never rewritten; an adjustment redistributes
 * with an audit trail, so `deltaByMember` MUST sum to zero (asserted, throws).
 *
 * Repeatable by design (no dedupeKey): a receipt can be corrected more than
 * once.
 */
export const appendAdjustment = async (args: {
    householdId: number;
    receiptId: number;
    reason: string;
    deltaByMember: Record<MemberId, number>;
    actorUserId?: MemberId;
    at?: Date;
    /**
     * The receipt's family subtotal AFTER this correction, and the re-split of
     * its FROZEN participant set at that amount (§4.4). The fold ignores both —
     * it applies `deltaByMember` and nothing else — but they are what makes the
     * receipt's current ledger state readable without reverse-engineering it
     * out of a chain of deltas, and what a second adjustment computes its own
     * delta against. Written together or not at all.
     */
    amountCents?: number;
    shares?: Record<MemberId, number>;
    previousAmountCents?: number;
}): Promise<LedgerEvent> => {
    assertDeltaSumsToZero(args.deltaByMember);
    const payload: Record<string, unknown> = {
        receiptId: args.receiptId,
        reason: args.reason,
        deltaByMember: args.deltaByMember,
    };
    if (args.amountCents !== undefined || args.shares !== undefined) {
        if (args.amountCents === undefined || args.shares === undefined) {
            throw new LedgerError('adjustment amountCents and shares must be written together');
        }
        // The same write-time guarantee receipt_recorded gets (§1.3): a restated
        // split that does not add up would silently skew every later correction.
        assertSharesSum(args.amountCents, args.shares);
        payload.amountCents = args.amountCents;
        payload.shares = args.shares;
        if (args.previousAmountCents !== undefined) payload.previousAmountCents = args.previousAmountCents;
    }
    return append({
        householdId: args.householdId,
        type: 'adjustment',
        at: args.at ?? new Date(),
        payload,
        receiptId: args.receiptId,
        actorUserId: args.actorUserId ?? null,
    });
};

/**
 * §4.4 PRE-LOCK ONLY — restate a receipt's family subtotal in place.
 *
 * THE ONE MUTATION IN THIS FILE, and it needs justifying against the
 * append-only rule stated at the top.
 *
 * §4.4 draws the line itself: after the lock a re-categorisation "emits a
 * visible `adjustment` event INSTEAD OF silently rewriting history" — which is
 * to say that before the lock, silently rewriting history is the specified
 * behaviour. The grace window exists precisely because nobody has acted on the
 * number yet: no settlement has been confirmed against it and it is less than
 * 72 h old, so there is no history worth auditing, only a number the user is
 * still finishing. Emitting an adjustment there would fill the family's history
 * feed with "Peter moved Coffee to personal" entries for what is, at that
 * point, ordinary data entry.
 *
 * The alternative — appending a superseding `receipt_recorded` and teaching the
 * fold to keep only the last one per receipt — is the purer event-sourced
 * answer, and I rejected it deliberately: it would change `deriveLedgerState`,
 * the most load-bearing pure function in the subsystem, and it would weaken the
 * `receipt:<id>` dedupe key that stops a re-posted receipt double-counting.
 *
 * What keeps this safe is that it is not a general-purpose update:
 *   · It touches ONLY `payload`, only on `type='receipt_recorded'`, only for
 *     one (householdId, receiptId). `at` and `id` are untouched, so the
 *     receipt's POSITION in the log — the thing §4.4(a) is decided on — cannot
 *     be moved by a restatement.
 *   · It re-checks the lock INSIDE the transaction, holding the row with
 *     FOR UPDATE, so a settlement confirming concurrently cannot be overtaken.
 *   · It refuses outright once any `adjustment` exists for the receipt: the two
 *     correction mechanisms must never both be in play on one receipt.
 *   · The participant set and the payer are taken from the STORED event and
 *     never re-derived from current membership (§1.1: a trip from before Laura
 *     left still splits three ways, forever). Only the amount, and the re-split
 *     of that same frozen set, change.
 *   · `computeShares` asserts the new split adds up before anything is written.
 *
 * Returns the restated event, or null when the receipt was never recorded.
 * Throws (LedgerError) when the receipt is no longer restatable.
 */
export const restateReceiptRecorded = async (args: {
    householdId: number;
    receiptId: number;
    amountCents: number;
}): Promise<ReceiptRecordedEvent | null> => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows]: any = await conn.query(
            `SELECT id, type, at, payload FROM ${TABLE}
              WHERE householdId = ? AND receiptId = ? AND type = 'receipt_recorded'
              ORDER BY at ASC, id ASC LIMIT 1 FOR UPDATE`,
            [args.householdId, args.receiptId],
        );
        if (!rows.length) { await conn.rollback(); return null; }
        const current = rowToEvent(rows[0]) as ReceiptRecordedEvent;

        const [locked]: any = await conn.query(
            `SELECT 1 FROM ${TABLE} c
              WHERE c.householdId = ? AND c.type = 'settlement_confirmed'
                AND (c.at > ? OR (c.at = ? AND c.id > ?)) LIMIT 1`,
            [args.householdId, rows[0].at, rows[0].at, rows[0].id],
        );
        if (locked.length) {
            await conn.rollback();
            throw new LedgerError(
                `receipt ${args.receiptId} is settlement-locked and cannot be restated — use an adjustment`);
        }
        const [adjusted]: any = await conn.query(
            `SELECT 1 FROM ${TABLE} WHERE householdId = ? AND receiptId = ? AND type = 'adjustment' LIMIT 1`,
            [args.householdId, args.receiptId],
        );
        if (adjusted.length) {
            await conn.rollback();
            throw new LedgerError(
                `receipt ${args.receiptId} already carries adjustments and cannot be restated`);
        }

        // The FROZEN participant set (§1.1) — read off the stored shares, never
        // re-derived from who happens to be in the household right now.
        const participants = Object.keys(current.shares);
        const shares = computeShares(args.receiptId, args.amountCents, participants);
        const payload = {
            receiptId: args.receiptId,
            payer: current.payer,
            amountCents: args.amountCents,
            shares,
        };
        assertSharesSum(payload.amountCents, payload.shares);
        await conn.query(
            `UPDATE ${TABLE} SET payload = ? WHERE id = ?`,
            [JSON.stringify(payload), rows[0].id],
        );
        await conn.commit();
        return { ...current, ...payload } as ReceiptRecordedEvent;
    } catch (e) {
        try { await conn.rollback(); } catch { /* already rolled back */ }
        throw e;
    } finally {
        conn.release();
    }
};
