import pool from '../config/db.js';
import { getMembership } from '../models/householdModel.js';
import { getLedgerEventsPage, getSettlementProposals } from '../models/householdLedgerModel.js';
import type { LedgerEventRecord } from '../models/householdLedgerModel.js';
import { AUTO_CONFIRM_ACTOR } from './householdLedger.js';
import type { LedgerEvent, MemberId } from './householdLedger.js';
import { getMemberLabels } from './householdMembership.js';

/**
 * FAMILY SHOPPING §5.2 — THE HISTORY FEED.
 *
 * The History tab could previously only show what is LIVE: the balances, the
 * pending settlements and the members currently in the leaving state, all of
 * which fall out of `getHouseholdLedgerView`. §5.2 asks for the past as well —
 * "Laura settled €7.00 with John", "Laura left the family" — and the past is
 * exactly the append-only log (§1.1). This file is the read model over it: the
 * same events the balances are folded from, resolved to labels and rendered
 * newest-first.
 *
 * IT DERIVES NOTHING AND WRITES NOTHING. Every number here is read off a stored
 * event; no balance is recomputed, no share is re-divided (§1.3), and the log
 * is untouched. If this file disappeared, not one balance would change.
 *
 * ── §4.5 VISIBILITY, WHICH IS THE PART TO GET RIGHT ────────────────────────
 *
 * §4.5 forbids a member seeing another member's personal items, and — the
 * subtle half — the receipt GRAND TOTAL, because the family subtotal is visible
 * by design and grand − family = personal spend.
 *
 * The feed is safe BY CONSTRUCTION, not by filtering, and that is worth stating
 * precisely because it is easy to erode:
 *   · The ledger physically cannot store a grand total. The only money a
 *     `receipt_recorded` carries is `amountCents`, and `recordFamilyReceipt`
 *     derives that from `computeFamilySubtotalCents` — the sum of the receipt's
 *     FAMILY-scoped ReceiptItem rows. Same for an `adjustment`'s restated
 *     amount, and a settlement's amount is a transfer between two members, not
 *     a receipt figure at all. There is no column, and no payload field, in
 *     which a grand total could be sitting.
 *   · Therefore the ONLY way this endpoint could leak one is by JOINING it back
 *     in. So the single join it makes — receiptId → store name — is an
 *     ALLOWLIST of two columns, `Store.name` and `StoreChain.name`, and the
 *     Receipt row is never selected, never spread. Not `r.*` (which carries
 *     `savedAmount`, a noisy function of the grand total over ALL items), not
 *     `parsedData` (which carries `footer.total` outright, plus totalSavings /
 *     comboDiscount / reconDelta, several of which reconstruct it), and no
 *     ReceiptItem row at any point — so no personal item, and no count of them.
 *   · The two fields it does take are already served to this exact audience by
 *     `GET /receipts/:id/family` (§4.5's own allowlist, receiptFamilyScope).
 *     The feed is a strict SUBSET of what a household member can already read
 *     about the same receipt, so it widens nobody's view by a single field.
 *
 * Adding a field here is therefore a deliberate act, and the test to apply is
 * the same one §4.5 applies: could a member subtract it from the family
 * subtotal and learn what someone else bought for themselves?
 *
 * ── WHO MAY READ IT ────────────────────────────────────────────────────────
 *
 * Members of the household, and nobody else. Enforced by SELF-SCOPING rather
 * than by a membership check on a supplied id: the household is resolved from
 * the caller's own `HouseholdMember` row, so there is no household id in the
 * URL for anyone to tamper with and no cross-household read to get wrong. A
 * caller with no household gets 404 — the same shape as the rest of
 * `/households/mine`.
 */

/** What kind of thing happened — the card the client renders. */
export type HistoryEntryKind =
    /** A family receipt entered the ledger (§1.1 receipt_recorded). */
    | 'receipt'
    /** A settlement was CONFIRMED (§3.2.1). Proposals never appear — see below. */
    | 'settlement'
    | 'member_joined'
    | 'member_left'
    /** §4.4 — a post-lock re-categorisation, visible by design. */
    | 'adjustment';

export interface HistoryParty {
    userId: MemberId;
    label: string;
}

export interface HouseholdHistoryEntry {
    /** The ledger event id — stable, and the feed's React key. */
    id: number;
    at: string;
    kind: HistoryEntryKind;
    /**
     * INTEGER CENTS (§1.3), or null for the entries that carry no money.
     * A family subtotal or a settlement amount — never a receipt grand total
     * (see the §4.5 note above; the ledger has no grand total to give).
     */
    amountCents: number | null;
    /** Who acted: the payer, the joiner/leaver, the debtor, the adjuster. */
    actor: HistoryParty | null;
    /** The other side, on the entries that have one (a settlement's payee). */
    counterparty: HistoryParty | null;
    receiptId: number | null;
    settlementId: string | null;
    storeName: string | null;
    chainName: string | null;
    /** §4.4 audit trail — the human reason, on adjustments only. */
    reason: string | null;
    /**
     * §4.4 — how the correction moved each member, summing to zero. Present on
     * adjustments only. Not a disclosure: it is a redistribution of the FAMILY
     * subtotal between members who all see each other's balances anyway, and
     * "balances move with an audit trail" is the whole point of the event.
     */
    deltaByMember: Record<MemberId, number> | null;
    /**
     * The rendered line, e.g. "Laura atsiskaitė su John".
     *
     * THE AMOUNT IS NOT IN THE TITLE, deliberately, even though §5.2 writes the
     * example as "Laura settled €7.00 with John". §5.2 also says the feed uses
     * the same card component as the Shopping screen, and that card has its own
     * amount slot — so the client composes the spec's sentence from `title` +
     * `amountCents` and keeps money formatting (locale, separator, currency)
     * in the one place that already owns it. §1.3's rule that display rounding
     * is presentation-only points the same way: the server ships integer cents.
     */
    title: string;
    /** Secondary line: the store, the reason, or how a settlement was confirmed. */
    subtitle: string | null;
}

export interface HouseholdHistoryPage {
    householdId: number;
    entries: HouseholdHistoryEntry[];
    /** Pass back as `?cursor=` for the next (older) page. Null = end of the log. */
    nextCursor: string | null;
}

/**
 * The event types the feed renders — an ALLOWLIST pushed down into SQL.
 *
 * `settlement_proposed` IS ABSENT, and that is a §3.2.1 requirement, not a
 * tidiness one. A proposal moves NO money ("Mark as settled" is one signature
 * of two); showing it in the history — the record of what has happened —
 * would tell John that Laura settled with him when she has done nothing of the
 * sort, and one party could clear a debt in the other's eyes unilaterally. The
 * pending proposal is live state and already surfaces, correctly labelled as
 * awaiting confirmation, in `getHouseholdLedgerView().pendingSettlements`.
 *
 * A confirmation therefore appears EXACTLY ONCE: `settlement_confirmed` is
 * deduped at the database by the `confirm:<settlementId>` key, so a manual
 * confirm racing the 7-day sweeper cannot produce two entries.
 */
const FEED_TYPES = [
    'receipt_recorded',
    'settlement_confirmed',
    'member_joined',
    'member_left',
    'adjustment',
] as const;

/**
 * receiptId → store, as a TWO-COLUMN ALLOWLIST. See the §4.5 note at the top of
 * the file for why this is the one join the feed is allowed to make and why it
 * must never grow to `SELECT r.*`.
 */
const receiptStores = async (
    receiptIds: number[],
): Promise<Map<number, { storeName: string | null; chainName: string | null }>> => {
    const out = new Map<number, { storeName: string | null; chainName: string | null }>();
    const ids = Array.from(new Set(receiptIds)).filter((v) => Number.isInteger(v) && v > 0);
    if (ids.length === 0) return out;
    const [rows]: any = await pool.query(
        `SELECT r.id, s.name AS storeName, sc.name AS chainName
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.id IN (?)`,
        [ids],
    );
    for (const r of rows as any[]) {
        out.set(Number(r.id), {
            storeName: r.storeName == null ? null : String(r.storeName),
            chainName: r.chainName == null ? null : String(r.chainName),
        });
    }
    return out;
};

/** Every member id an entry could need a label for. */
const partiesOf = (rec: LedgerEventRecord): MemberId[] => {
    const ev = rec.event;
    const ids: (MemberId | null)[] = [rec.actorUserId];
    if (ev.type === 'receipt_recorded') ids.push(ev.payer);
    if (ev.type === 'member_joined' || ev.type === 'member_left') ids.push(ev.member);
    // A settlement_confirmed's parties live on its PROPOSAL; they are collected
    // separately once the proposals are resolved.
    return ids.filter((v): v is MemberId => !!v && v !== AUTO_CONFIRM_ACTOR);
};

const party = (
    userId: MemberId | null | undefined, labels: Map<MemberId, string>,
): HistoryParty | null =>
    userId ? { userId, label: labels.get(userId) ?? 'Narys' } : null;

/** Adjustments carry their restated family subtotal; older ones may not. */
const adjustmentAmount = (ev: LedgerEvent): number | null => {
    const p = ev as unknown as { amountCents?: unknown };
    return typeof p.amountCents === 'number' ? p.amountCents : null;
};

/**
 * §5.2 — the household's event log as a display-ready feed, newest first.
 *
 * Four queries, flat: the page, the proposals its confirmations point at, the
 * stores its receipts point at, and the labels. No per-entry lookup, so the
 * cost is the same for a page of 20 as for a page of 1.
 *
 * Returns null when the caller is in no household — the controller answers 404
 * for that, exactly like the rest of `/households/mine`.
 */
export const getHouseholdHistoryFeed = async (args: {
    userId: MemberId;
    limit?: number;
    cursor?: string;
}): Promise<HouseholdHistoryPage | null> => {
    const membership = await getMembership(args.userId);
    if (!membership) return null;
    const householdId = membership.householdId;

    const page = await getLedgerEventsPage(householdId, {
        limit: args.limit,
        cursor: args.cursor,
        types: [...FEED_TYPES],
    });

    const settlementIds = page.records
        .map((r) => (r.event.type === 'settlement_confirmed' ? r.event.settlementId : null))
        .filter((v): v is string => !!v);
    const proposals = await getSettlementProposals(householdId, settlementIds);

    const receiptIds = page.records
        .map((r) => (r.event.type === 'receipt_recorded' || r.event.type === 'adjustment'
            ? r.event.receiptId : null))
        .filter((v): v is number => v != null);
    const stores = await receiptStores(receiptIds);

    const labelIds = page.records.flatMap(partiesOf);
    for (const p of proposals.values()) labelIds.push(p.from, p.to);
    const labels = await getMemberLabels(labelIds);

    const entries: HouseholdHistoryEntry[] = page.records.map((rec) => {
        const ev = rec.event;
        const base = {
            id: ev.id,
            at: ev.at,
            amountCents: null as number | null,
            actor: null as HistoryParty | null,
            counterparty: null as HistoryParty | null,
            receiptId: null as number | null,
            settlementId: null as string | null,
            storeName: null as string | null,
            chainName: null as string | null,
            reason: null as string | null,
            deltaByMember: null as Record<MemberId, number> | null,
            subtitle: null as string | null,
        };

        switch (ev.type) {
            case 'receipt_recorded': {
                const store = stores.get(ev.receiptId);
                const actor = party(ev.payer, labels);
                return {
                    ...base,
                    kind: 'receipt',
                    // §4.3 — the FAMILY subtotal. The ledger holds nothing else.
                    amountCents: ev.amountCents,
                    actor,
                    receiptId: ev.receiptId,
                    storeName: store?.storeName ?? null,
                    chainName: store?.chainName ?? null,
                    title: `${actor?.label ?? 'Narys'} apsipirko`,
                    subtitle: store?.storeName ?? store?.chainName ?? null,
                };
            }
            case 'settlement_confirmed': {
                const p = proposals.get(ev.settlementId);
                const from = party(p?.from, labels);
                const to = party(p?.to, labels);
                return {
                    ...base,
                    kind: 'settlement',
                    amountCents: p?.amountCents ?? null,
                    // The debtor acts; the payee is the counterparty. `by` (who
                    // signed the confirmation) is not a party — it is either the
                    // counterparty or the sweeper, and saying so belongs in the
                    // subtitle, not in a member slot.
                    actor: from,
                    counterparty: to,
                    settlementId: ev.settlementId,
                    title: from && to
                        ? `${from.label} atsiskaitė su ${to.label}`
                        : 'Atsiskaityta',
                    subtitle: ev.by === AUTO_CONFIRM_ACTOR ? 'Patvirtinta automatiškai' : null,
                };
            }
            case 'member_joined': {
                const actor = party(ev.member, labels);
                return {
                    ...base,
                    kind: 'member_joined',
                    actor,
                    title: `${actor?.label ?? 'Narys'} prisijungė prie šeimos`,
                };
            }
            case 'member_left': {
                const actor = party(ev.member, labels);
                return {
                    ...base,
                    kind: 'member_left',
                    actor,
                    title: `${actor?.label ?? 'Narys'} išėjo iš šeimos`,
                };
            }
            default: {
                // `adjustment` — the only remaining member of FEED_TYPES.
                const adj = ev as Extract<LedgerEvent, { type: 'adjustment' }>;
                const store = stores.get(adj.receiptId);
                const actor = party(rec.actorUserId, labels);
                return {
                    ...base,
                    kind: 'adjustment',
                    amountCents: adjustmentAmount(adj),
                    actor,
                    receiptId: adj.receiptId,
                    storeName: store?.storeName ?? null,
                    chainName: store?.chainName ?? null,
                    reason: adj.reason ?? null,
                    deltaByMember: adj.deltaByMember ?? null,
                    title: actor
                        ? `${actor.label} pakeitė kvito prekes`
                        : 'Kvito prekės pakeistos',
                    subtitle: adj.reason ?? null,
                };
            }
        }
    });

    return { householdId, entries, nextCursor: page.nextCursor };
};
