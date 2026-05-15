import pool from '../config/db.js';
import {
    fetchImageCandidatesBySpIds,
    type AdminImageCandidate,
} from './adminImageQueueModel.js';

/**
 * Queue model for the admin Flags inbox.
 *
 * The Flags tab is the sole owner of `ReceiptLineIssue` rows with
 * `status = 'pending'`. The image and amount tabs explicitly exclude
 * flagged SPs from their pickers — see `adminImageQueueModel` /
 * `adminAmountQueueModel`.
 *
 * Queue key is `(receiptId, receiptLineIdx)` — multiple users can
 * flag the same line; one card represents all complaints about that
 * line and resolves every matching row in one transaction.
 *
 * Card payload bundles everything the unified card UI needs:
 *   - The SP behind that receipt line (name, brand, amount/unit/isWeighable, image)
 *   - The flag rollup (which of name/price/amount/discount/image were set)
 *   - The Price row from that specific receipt (for the price + discount sub-sections)
 *   - The user count (how many distinct users flagged the line)
 *   - The receipt-crop URL (client fetches the cropped JPEG separately)
 */

export interface FlagBundle {
    flagKey: string;                    // composite `${receiptId}-${lineIdx}` — used by claim/release/confirm endpoints
    receiptId: number;
    lineIdx: number;
    spId: number;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    /** Canonical Product behind the current SP — the "what we think
     *  it is" label the user saw in the app and flagged. The Pavadinimas
     *  search field is initialised against this. */
    productId: number;
    productName: string;
    /** Current category of the matched Product. The Kategorija picker
     *  is initialised against this; admin can change it. */
    categoryId: number | null;
    categoryName: string;
    /** Number of distinct users that flagged this line. */
    userCount: number;
    /** Which fields users have flagged. A line gets one card; the
     *  card sub-sections render per-flag basis off this rollup. */
    flagged: {
        name: boolean;
        amount: boolean;
        price: boolean;
        discount: boolean;
        image: boolean;
    };
    /** Current state on the SP — the admin's "before" snapshot.
     *  `storeProductName` is the chain-specific OCR'd label (drives
     *  the "Atpažintas tekstas" field); `name` is the same value
     *  COALESCED with Product.name for back-compat with the card
     *  header. */
    sp: {
        name: string;
        storeProductName: string | null;
        brandName: string | null;
        amount: number | null;
        unit: string | null;
        isWeighable: boolean;
        imageUrl: string | null;
    };
    /** Price row for this specific receipt line. price/discount
     *  sub-sections show these read-only with a "mark suspect" toggle. */
    receiptPrice: {
        priceId: number | null;
        price: number | null;
        promoPrice: number | null;
        priceVerified: boolean;
    };
    /** Cross-chain siblings, BaseProductLink siblings, and pending
     *  user uploads — same set the Images tab shows. The Flags-tab
     *  card renders these as a thumbnail strip with the current
     *  image highlighted, so the admin can fix a flagged image
     *  inline without bouncing to the Images tab. */
    imageCandidates: AdminImageCandidate[];
    /** Earliest createdAt across the matching flag rows — controls ordering. */
    flaggedAt: string;
}

/**
 * Picker returns a list of `(receiptId, lineIdx)` keys ready for the
 * lease layer. The actual row hydration runs after the lease records
 * are inserted (so we know exactly which keys are leased to the
 * admin).
 */
export interface FlagPickKey {
    receiptId: number;
    lineIdx: number;
}

/**
 * Build the candidate list:
 *   - GROUP BY (receiptId, receiptLineIdx) to dedupe across users
 *   - filter to status='pending'
 *   - exclude keys with an active lease in queueKind='flag'
 *   - exclude keys with a recently-resolved (flag_*) admin action in
 *     the last 90 days (same anti-resurface rule as amounts)
 *   - ORDER BY earliest flag createdAt DESC (newest first)
 */
export async function pickFlagQueueKeys(args: {
    batchSize: number;
    excludeKeys?: FlagPickKey[];
}): Promise<FlagPickKey[]> {
    const wanted = Math.max(1, args.batchSize);
    const exclude = (args.excludeKeys ?? []);

    // Build the optional NOT IN list as a flat pair-list. MySQL
    // doesn't have row-tuple NOT IN with prepared placeholders that
    // mysql2 accepts cleanly, so we expand to OR clauses.
    const excludeClauses = exclude.length > 0
        ? ' AND NOT (' +
            exclude.map(() => '(rli.receiptId = ? AND rli.receiptLineIdx = ?)').join(' OR ')
          + ')'
        : '';
    const excludeParams: any[] = [];
    for (const k of exclude) { excludeParams.push(k.receiptId, k.lineIdx); }

    const [rows]: any = await pool.query(
        `SELECT rli.receiptId, rli.receiptLineIdx,
                MIN(rli.createdAt) AS flaggedAt
           FROM ReceiptLineIssue rli
          WHERE rli.status = 'pending'
            AND NOT EXISTS (
                SELECT 1 FROM AdminCardLease l
                 WHERE l.queueKind = 'flag'
                   AND l.completedAt IS NULL
                   AND l.abandonedAt IS NULL
                   AND l.expiresAt > NOW()
                   -- AdminCardLease.spId stores the composite key
                   -- encoded as (receiptId * 1_000 + lineIdx) for
                   -- the flag queue, since the lease table is keyed
                   -- on a single bigint. Decode by reversing the math.
                   AND FLOOR(l.spId / 1000) = rli.receiptId
                   AND (l.spId MOD 1000) = rli.receiptLineIdx
            )
            AND NOT EXISTS (
                SELECT 1 FROM AdminAuditLog a
                 WHERE a.targetType = 'ReceiptLineIssue'
                   AND a.targetId = (rli.receiptId * 1000 + rli.receiptLineIdx)
                   AND a.action IN ('flag_resolve', 'flag_dismiss', 'flag_skip')
                   AND a.reversedAt IS NULL
                   AND a.createdAt > NOW() - INTERVAL 90 DAY
            )
            ${excludeClauses}
          GROUP BY rli.receiptId, rli.receiptLineIdx
          ORDER BY flaggedAt DESC
          LIMIT ?`,
        [...excludeParams, wanted],
    );

    return (rows as any[]).map(r => ({
        receiptId: Number(r.receiptId),
        lineIdx: Number(r.receiptLineIdx),
    }));
}

/**
 * Encode/decode helpers for stuffing the `(receiptId, lineIdx)` key
 * into `AdminCardLease.spId`. The lease table is single-int-keyed
 * (SP-shaped) so flag-queue leases pack the composite key as
 * `receiptId * 1000 + lineIdx`. lineIdx is single-digit double-digit
 * in practice (rare receipt has >30 lines, never >999).
 */
const FLAG_KEY_MUL = 1000;
export function encodeFlagKey(receiptId: number, lineIdx: number): number {
    if (lineIdx >= FLAG_KEY_MUL) {
        throw new Error(`lineIdx ${lineIdx} exceeds flag-key encoding capacity`);
    }
    return receiptId * FLAG_KEY_MUL + lineIdx;
}
export function decodeFlagKey(spId: number): FlagPickKey {
    return { receiptId: Math.floor(spId / FLAG_KEY_MUL), lineIdx: spId % FLAG_KEY_MUL };
}

/**
 * Hydrate flag keys into full card payloads.
 */
export async function hydrateFlagQueueRows(
    keys: FlagPickKey[],
    locale: string = 'lt',
): Promise<FlagBundle[]> {
    if (keys.length === 0) return [];

    // Build a flat (receiptId, lineIdx) pair list for SQL IN.
    const pairClauses = keys.map(() => '(rli.receiptId = ? AND rli.receiptLineIdx = ?)').join(' OR ');
    const pairParams: any[] = [];
    for (const k of keys) { pairParams.push(k.receiptId, k.lineIdx); }

    // Pull every flag row that matches (status=pending, key in the
    // claimed set). Multiple users for the same key surface as
    // multiple rows — fold them into the userCount in JS.
    const [flagRows]: any = await pool.query(
        `SELECT rli.receiptId, rli.receiptLineIdx, rli.userId, rli.flags, rli.createdAt
           FROM ReceiptLineIssue rli
          WHERE rli.status = 'pending'
            AND (${pairClauses})`,
        pairParams,
    );

    // Group flag rows by (receiptId, lineIdx).
    interface PendingFlag {
        userCount: number;
        flagged: FlagBundle['flagged'];
        flaggedAt: string;
    }
    const flagByKey = new Map<string, PendingFlag>();
    for (const r of flagRows as any[]) {
        const k = `${r.receiptId}-${r.receiptLineIdx}`;
        const flagsObj = typeof r.flags === 'string' ? JSON.parse(r.flags) : r.flags;
        let entry = flagByKey.get(k);
        if (!entry) {
            entry = {
                userCount: 0,
                flagged: { name: false, amount: false, price: false, discount: false, image: false },
                flaggedAt: String(r.createdAt),
            };
            flagByKey.set(k, entry);
        }
        entry.userCount += 1;
        entry.flagged.name     ||= !!flagsObj?.name;
        entry.flagged.amount   ||= !!flagsObj?.amount;
        entry.flagged.price    ||= !!flagsObj?.price;
        entry.flagged.discount ||= !!flagsObj?.discount;
        entry.flagged.image    ||= !!flagsObj?.image;
        // Use the earliest createdAt for ordering stability.
        if (String(r.createdAt) < entry.flaggedAt) {
            entry.flaggedAt = String(r.createdAt);
        }
    }

    // Pull the SP behind each line. The lineIdx→spId mapping lives in
    // Receipt.parsedData.products[lineIdx].storeProductId — joining
    // Price on (receiptId) alone is ambiguous for receipts with multiple
    // lines, so we resolve through parsedData to get the exact SP.
    // The Price row is then looked up via (receiptId, spId, isFallback=0)
    // — same path the receipt detail controller uses.
    const [spRows]: any = await pool.query(
        `SELECT rli.receiptId, rli.receiptLineIdx,
                sp.id AS spId,
                COALESCE(sp.storeProductName, p.name) AS spName,
                sp.storeProductName AS spStoreProductName,
                sp.brandName,
                sp.amount AS spAmount,
                sp.unit   AS spUnit,
                sp.isWeighable AS spIsWeighable,
                sp.imageUrl AS spImageUrl,
                sp.chainId,
                p.id AS productId,
                p.name AS productName,
                p.categoryId AS productCategoryId,
                sc.name    AS chainName,
                sc.logoUrl AS chainLogoUrl,
                COALESCE(ct.name, c.name) AS categoryName,
                pr.id AS priceId, pr.price, pr.promoPrice, pr.priceVerified
           FROM ReceiptLineIssue rli
           JOIN Receipt rcpt ON rcpt.id = rli.receiptId
           JOIN StoreProduct sp
             ON sp.id = CAST(
                  JSON_UNQUOTE(JSON_EXTRACT(
                      rcpt.parsedData,
                      CONCAT('$.products[', rli.receiptLineIdx, '].storeProductId')
                  )) AS UNSIGNED
              )
           JOIN Product p ON p.id = sp.productId
           LEFT JOIN Price pr
                  ON pr.receiptId = rli.receiptId
                 AND pr.storeProductId = sp.id
                 AND pr.isFallback = 0
           LEFT JOIN StoreChain sc ON sc.id = sp.chainId
           LEFT JOIN Category c ON c.id = p.categoryId
           LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
          WHERE rli.status = 'pending'
            AND (${pairClauses})`,
        [locale, ...pairParams],
    );

    const spByKey = new Map<string, any>();
    for (const r of spRows as any[]) {
        spByKey.set(`${r.receiptId}-${r.receiptLineIdx}`, r);
    }

    // Image candidates per spId. Fetched in one batch query so the
    // payload contains everything the unified card UI renders.
    const spIdSet: number[] = [];
    for (const r of spRows as any[]) {
        const id = Number(r.spId);
        if (!Number.isNaN(id)) spIdSet.push(id);
    }
    const candidatesBySpId = await fetchImageCandidatesBySpIds(spIdSet);

    // Assemble in the order keys came in (preserves the rank from the picker).
    const out: FlagBundle[] = [];
    for (const k of keys) {
        const compositeKey = `${k.receiptId}-${k.lineIdx}`;
        const flag = flagByKey.get(compositeKey);
        const sp = spByKey.get(compositeKey);
        // If a flag row was deleted between pick + hydrate (rare race),
        // or the Price/SP join couldn't resolve, skip the row.
        if (!flag || !sp) continue;
        const spId = Number(sp.spId);
        out.push({
            flagKey: compositeKey,
            receiptId: k.receiptId,
            lineIdx: k.lineIdx,
            spId,
            chainId: Number(sp.chainId ?? 0),
            chainName: String(sp.chainName ?? ''),
            chainLogoUrl: sp.chainLogoUrl ?? null,
            productId: Number(sp.productId ?? 0),
            productName: String(sp.productName ?? ''),
            categoryId: sp.productCategoryId !== null && sp.productCategoryId !== undefined
                ? Number(sp.productCategoryId)
                : null,
            categoryName: String(sp.categoryName ?? ''),
            userCount: flag.userCount,
            flagged: flag.flagged,
            sp: {
                name: String(sp.spName ?? ''),
                storeProductName: sp.spStoreProductName ?? null,
                brandName: sp.brandName ?? null,
                amount: sp.spAmount !== null && sp.spAmount !== undefined
                    ? parseFloat(String(sp.spAmount))
                    : null,
                unit: sp.spUnit ?? null,
                isWeighable: !!Number(sp.spIsWeighable),
                imageUrl: sp.spImageUrl ?? null,
            },
            receiptPrice: {
                priceId: sp.priceId !== null && sp.priceId !== undefined ? Number(sp.priceId) : null,
                price: sp.price !== null && sp.price !== undefined ? parseFloat(String(sp.price)) : null,
                promoPrice: sp.promoPrice !== null && sp.promoPrice !== undefined
                    ? parseFloat(String(sp.promoPrice))
                    : null,
                priceVerified: !!Number(sp.priceVerified),
            },
            imageCandidates: candidatesBySpId.get(spId) ?? [],
            flaggedAt: flag.flaggedAt,
        });
    }
    return out;
}
