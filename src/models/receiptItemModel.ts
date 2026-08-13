import type { Connection } from 'mysql2/promise';
import pool from '../config/db.js';

/**
 * ReceiptItem: a receipt LINE as a first-class row (see shared/RECEIPT_ITEM_MIGRATION.md).
 * This model owns the ONE canonical mapping between a `parsedData.products[i]` line object
 * and a ReceiptItem row, used by write, backfill AND read alike:
 *
 *   lineToItem(receiptId, lineIdx, line) → row   (known keys → columns; the rest → `extra`)
 *   itemToLine(row)                      → line   (columns back under original names; ...extra)
 *
 * Round-trip invariant (unit-tested): every key present on the original line survives
 * itemToLine(lineToItem(line)). `extra` is what makes it lossless — no line key can be
 * silently dropped — which is what makes the hard cutover (blob → rows) safe.
 */

// Line keys that map to a dedicated column (or a JSON column). Everything NOT in this set
// is preserved verbatim in `extra`. `band` is derived from itemConfidence, not a line key.
const KNOWN_LINE_KEYS = new Set<string>([
    // immutable OCR / parse
    'name', 'price', 'promoPrice', 'quantity', 'unit', 'amount', 'sizeUnit', 'isWeighable',
    'pricePerUnit', 'brandName',
    // match binding (storeProductId is renamed to matchedSpId)
    'storeProductId', 'matchSource', 'matchedName', 'storeProductImageUrl', 'matchConfidence',
    'matchConfirmed', 'priceVerified', 'variantUncertain', 'priceImplausible',
    // FAMILY SHOPPING §4.1 — family (0, the default) vs personal (1)
    'isPersonal',
    // confidence + category
    'needsHuman', 'categoryId', 'categoryName', 'categoryL2Name',
    // cold JSON columns
    'itemConfidence', 'altMatches', 'region', 'rawLines',
]);

export interface ReceiptItemRow {
    id?: number;
    receiptId: number;
    lineIdx: number;
    name: string;
    price: number | null;
    promoPrice: number | null;
    quantity: number | null;
    unit: string | null;
    amount: number | null;
    sizeUnit: string | null;
    isWeighable: boolean;
    pricePerUnit: number | null;
    brandName: string | null;
    matchedSpId: number | null;
    matchSource: string | null;
    matchedName: string | null;
    storeProductImageUrl: string | null;
    matchConfidence: number | null;
    matchConfirmed: boolean;
    priceVerified: boolean;
    variantUncertain: boolean;
    priceImplausible: boolean;
    /** §4.1 — false = FAMILY (the default), true = PERSONAL. */
    isPersonal: boolean;
    band: string | null;
    needsHuman: number | null;
    categoryId: number | null;
    categoryName: string | null;
    categoryL2Name: string | null;
    itemConfidence: any | null;
    altMatches: any | null;
    region: any | null;
    rawLines: any | null;
    extra: Record<string, any> | null;
}

// ── coercion helpers (tolerate both native JS values from lineToItem AND DB row values:
//    mysql2 returns DECIMAL as string, TINYINT as 0/1, JSON as string-or-object). ──
// num CLAMPS to the DECIMAL(10,x) column budget: a garbled OCR value (a VAT code read as a
// quantity, NaN math) must degrade to NULL, not throw out-of-range — the ReceiptItem write
// is FATAL-on-error by design (rows are authoritative), so one bad value would otherwise
// abort the entire receipt save.
const num = (v: any): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) < 1e8 ? n : null;
};
const bool = (v: any): boolean => v === true || v === 1 || v === '1';
// Clamped to the column's VARCHAR budget (callers pass a tighter max where the column is smaller).
const str = (v: any, max = 512): string | null =>
    (v === null || v === undefined ? null : String(v).slice(0, max));
const json = (v: any): any => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
};

/** Map a parsedData line → a ReceiptItem row. `extra` captures every key not mapped. */
export function lineToItem(receiptId: number, lineIdx: number, line: any): ReceiptItemRow {
    const ic = line?.itemConfidence ?? null;
    const extra: Record<string, any> = {};
    for (const k of Object.keys(line ?? {})) {
        if (!KNOWN_LINE_KEYS.has(k)) extra[k] = line[k];
    }
    return {
        receiptId,
        lineIdx,
        name: typeof line?.name === 'string' ? line.name.slice(0, 512) : '',
        price: num(line?.price),
        promoPrice: num(line?.promoPrice),
        quantity: num(line?.quantity),
        unit: str(line?.unit, 20),
        amount: num(line?.amount),
        sizeUnit: str(line?.sizeUnit, 20),
        isWeighable: bool(line?.isWeighable),
        pricePerUnit: num(line?.pricePerUnit),
        brandName: str(line?.brandName, 255),
        matchedSpId: num(line?.storeProductId),
        matchSource: str(line?.matchSource, 24),
        matchedName: str(line?.matchedName, 512),
        storeProductImageUrl: str(line?.storeProductImageUrl, 1024),
        matchConfidence: num(line?.matchConfidence),
        matchConfirmed: bool(line?.matchConfirmed),
        priceVerified: bool(line?.priceVerified),
        variantUncertain: bool(line?.variantUncertain),
        priceImplausible: bool(line?.priceImplausible),
        isPersonal: bool(line?.isPersonal),
        band: ic && typeof ic.band === 'string' ? ic.band.slice(0, 8) : null,
        needsHuman: num(line?.needsHuman),
        categoryId: num(line?.categoryId),
        categoryName: str(line?.categoryName, 255),
        categoryL2Name: str(line?.categoryL2Name, 255),
        itemConfidence: ic,
        altMatches: Array.isArray(line?.altMatches) ? line.altMatches : null,
        region: line?.region ?? null,
        rawLines: Array.isArray(line?.rawLines) ? line.rawLines : null,
        extra: Object.keys(extra).length > 0 ? extra : null,
    };
}

/**
 * Rebuild a parsedData line from a ReceiptItem row (DB row or a lineToItem result).
 * Column fields come back under their ORIGINAL key names; `extra` is spread last (it can
 * never collide — it holds only keys that are NOT columns). Fields absent on the original
 * line reconstruct as null — semantically identical to absent for the client (the response
 * is JSON-serialised, and hydration already emits nulls for these).
 */
export function itemToLine(row: any): any {
    const line: any = {
        name: typeof row?.name === 'string' ? row.name : '',
        price: num(row?.price),
        promoPrice: num(row?.promoPrice),
        quantity: num(row?.quantity),
        unit: str(row?.unit),
        amount: num(row?.amount),
        sizeUnit: str(row?.sizeUnit),
        isWeighable: bool(row?.isWeighable),
        pricePerUnit: num(row?.pricePerUnit),
        brandName: str(row?.brandName),
        storeProductId: num(row?.matchedSpId),
        matchSource: str(row?.matchSource),
        matchedName: str(row?.matchedName),
        storeProductImageUrl: str(row?.storeProductImageUrl),
        matchConfidence: num(row?.matchConfidence),
        matchConfirmed: bool(row?.matchConfirmed),
        priceVerified: bool(row?.priceVerified),
        variantUncertain: bool(row?.variantUncertain),
        priceImplausible: bool(row?.priceImplausible),
        isPersonal: bool(row?.isPersonal),
        needsHuman: num(row?.needsHuman),
        categoryId: num(row?.categoryId),
        categoryName: str(row?.categoryName),
        categoryL2Name: str(row?.categoryL2Name),
        itemConfidence: json(row?.itemConfidence),
        altMatches: json(row?.altMatches) ?? [],
        region: json(row?.region),
        rawLines: json(row?.rawLines),
    };
    const extra = json(row?.extra);
    if (extra && typeof extra === 'object') Object.assign(line, extra);
    return line;
}

// ── persistence ──────────────────────────────────────────────────────────────────────
const INSERT_COLS = [
    'receiptId', 'lineIdx', 'name', 'price', 'promoPrice', 'quantity', 'unit', 'amount',
    'sizeUnit', 'isWeighable', 'pricePerUnit', 'brandName', 'matchedSpId', 'matchSource',
    'matchedName', 'storeProductImageUrl', 'matchConfidence', 'matchConfirmed', 'priceVerified',
    'variantUncertain', 'priceImplausible', 'isPersonal', 'band', 'needsHuman', 'categoryId', 'categoryName',
    'categoryL2Name', 'itemConfidence', 'altMatches', 'region', 'rawLines', 'extra',
] as const;
const JSON_COLS = new Set(['itemConfidence', 'altMatches', 'region', 'rawLines', 'extra']);

function rowToValues(row: ReceiptItemRow): any[] {
    return INSERT_COLS.map((c) => {
        const v = (row as any)[c];
        if (JSON_COLS.has(c)) return v == null ? null : JSON.stringify(v);
        if (typeof v === 'boolean') return v ? 1 : 0;
        return v ?? null;
    });
}

/**
 * Replace all rows for a receipt with `lines` (idempotent per receipt). Returns a map
 * lineIdx → inserted ReceiptItem id, so the caller can stamp Price.receiptItemId.
 */
export async function replaceReceiptItems(
    receiptId: number,
    lines: any[],
    conn?: Connection,
): Promise<Map<number, number>> {
    const db = conn || (pool as any);
    // FAMILY SHOPPING §4.1 — CARRY THE SCOPE FLAG ACROSS THE REPLACE.
    //
    // This function is DELETE-then-INSERT, and it is on the autosave, heal,
    // dev-replace and backfill paths — none of which reliably round-trip the
    // flag: a heal/re-parse builds brand-new line objects, and an older client
    // simply doesn't know the key exists. Without this snapshot a single
    // autosave would silently reset every PERSONAL item back to FAMILY, i.e.
    // silently move money onto everyone else's balance — and after the §4.4
    // lock it would do so with no adjustment event, because no toggle was ever
    // requested. So the stored value wins unless the caller EXPLICITLY carries
    // `isPersonal` on the line (hasOwnProperty, not truthiness: an explicit
    // `false` must be able to clear the flag).
    //
    // Keyed on lineIdx, the same identity every other per-line write here uses.
    // A re-parse that RENUMBERS lines can therefore carry a flag to a
    // neighbouring item — but the alternative is losing the user's
    // categorisation outright on every heal, which is strictly worse and
    // silently under-counts the family subtotal. New lines default to FAMILY.
    const [priorRows]: any = await db.query(
        'SELECT lineIdx, isPersonal FROM ReceiptItem WHERE receiptId = ?', [receiptId]);
    const priorScope = new Map<number, boolean>(
        (priorRows as any[]).map((r) => [Number(r.lineIdx), r.isPersonal === 1 || r.isPersonal === true]));

    await db.query('DELETE FROM ReceiptItem WHERE receiptId = ?', [receiptId]);
    if (!Array.isArray(lines) || lines.length === 0) return new Map();
    const rows = lines.map((line, i) => {
        const row = lineToItem(receiptId, i, line);
        if (!(line && Object.prototype.hasOwnProperty.call(line, 'isPersonal'))) {
            row.isPersonal = priorScope.get(i) ?? false;
        }
        return row;
    });
    // Guard the matchedSpId FK: a stored blob (esp. when backfilling) may reference an SP
    // that has since been DELETED (dedupe / purge). NULL those out so the insert succeeds —
    // the line is simply unmatched (its SP is gone). A single indexed PK lookup.
    const spIds = [...new Set(rows.map((r) => r.matchedSpId).filter((v): v is number => v != null))];
    if (spIds.length > 0) {
        const [existRows]: any = await db.query('SELECT id FROM StoreProduct WHERE id IN (?)', [spIds]);
        const existing = new Set((existRows as any[]).map((r) => Number(r.id)));
        for (const r of rows) if (r.matchedSpId != null && !existing.has(r.matchedSpId)) r.matchedSpId = null;
    }
    const placeholders = rows.map(() => `(${INSERT_COLS.map(() => '?').join(',')})`).join(',');
    const values = rows.flatMap(rowToValues);
    await db.query(`INSERT INTO ReceiptItem (${INSERT_COLS.join(',')}) VALUES ${placeholders}`, values);
    // Read the ids back by lineIdx (robust vs. relying on consecutive AUTO_INCREMENT).
    const [idRows]: any = await db.query('SELECT id, lineIdx FROM ReceiptItem WHERE receiptId = ?', [receiptId]);
    const map = new Map<number, number>();
    for (const r of idRows) map.set(Number(r.lineIdx), Number(r.id));
    return map;
}

/** All items for a receipt, ordered by lineIdx, rebuilt into parsedData line objects. */
export async function getReceiptItemLines(receiptId: number, conn?: Connection): Promise<any[]> {
    const db = conn || (pool as any);
    const [rows]: any = await db.query('SELECT * FROM ReceiptItem WHERE receiptId = ? ORDER BY lineIdx ASC', [receiptId]);
    return (rows as any[]).map(itemToLine);
}

/** The matched StoreProduct id of one line (NULL when unmatched / no row), from its row. */
export async function getReceiptItemMatchedSpId(receiptId: number, lineIdx: number, conn?: Connection): Promise<number | null> {
    const db = conn || (pool as any);
    const [rows]: any = await db.query('SELECT matchedSpId FROM ReceiptItem WHERE receiptId = ? AND lineIdx = ? LIMIT 1', [receiptId, lineIdx]);
    const v = rows?.[0]?.matchedSpId;
    return v == null ? null : Number(v);
}

/** Raw rows (id + columns) for a receipt, ordered by lineIdx. */
/** The line's row id + linked SP in one lookup — the key the price locator needs. */
export async function getReceiptItemKey(
    receiptId: number,
    lineIdx: number,
    conn?: Connection,
): Promise<{ id: number; matchedSpId: number | null } | null> {
    const db = conn || (pool as any);
    const [rows]: any = await db.query(
        'SELECT id, matchedSpId FROM ReceiptItem WHERE receiptId = ? AND lineIdx = ? LIMIT 1',
        [receiptId, lineIdx],
    );
    if (!rows[0]) return null;
    return { id: Number(rows[0].id), matchedSpId: rows[0].matchedSpId == null ? null : Number(rows[0].matchedSpId) };
}

export async function getReceiptItemRows(receiptId: number, conn?: Connection): Promise<any[]> {
    const db = conn || (pool as any);
    const [rows]: any = await db.query('SELECT * FROM ReceiptItem WHERE receiptId = ? ORDER BY lineIdx ASC', [receiptId]);
    return rows as any[];
}

/**
 * Patch specific columns on one line (a single-row UPDATE — replaces the whole-blob rewrite).
 * `patch` keys are column names; JSON columns are stringified. Returns rows affected.
 */
export async function updateReceiptItem(
    receiptId: number,
    lineIdx: number,
    patch: Partial<Record<(typeof INSERT_COLS)[number] | 'band', any>>,
    conn?: Connection,
): Promise<number> {
    const db = conn || (pool as any);
    const keys = Object.keys(patch);
    if (keys.length === 0) return 0;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => {
        const v = (patch as any)[k];
        if (JSON_COLS.has(k)) return v == null ? null : JSON.stringify(v);
        if (typeof v === 'boolean') return v ? 1 : 0;
        return v ?? null;
    });
    const [res]: any = await db.query(
        `UPDATE ReceiptItem SET ${sets} WHERE receiptId = ? AND lineIdx = ?`,
        [...vals, receiptId, lineIdx],
    );
    return res?.affectedRows ?? 0;
}

// ── FAMILY SHOPPING §4.3 — the family subtotal ───────────────────────────────────────

/** One line's money, as the whole codebase computes it (cf. tripStatsService). */
export interface ScopedItemRow {
    lineIdx: number;
    name: string;
    isPersonal: boolean;
    price: number | null;
    promoPrice: number | null;
    quantity: number | null;
    unit: string | null;
    amount: number | null;
    sizeUnit: string | null;
    isWeighable: boolean;
    matchedSpId: number | null;
    matchedName: string | null;
    storeProductImageUrl: string | null;
    categoryId: number | null;
    categoryName: string | null;
    categoryL2Name: string | null;
}

/**
 * The money a single receipt line contributed, in INTEGER CENTS.
 *
 * Deliberately the SAME formula the trip stats use
 * (`unit = promoPrice > 0 ? promoPrice : price`, times `quantity || 1`), so the
 * family subtotal and every other spend number in the app are computed one way.
 * Rounded PER LINE, then summed: cents are the unit of truth (§1.3), and
 * rounding once at the end would let float error ride on the whole receipt.
 *
 * Non-positive lines contribute 0 — the same clamp tripStatsService applies.
 * A weighed item whose price could not be recovered is stored as price = 0 and
 * must never be invented into a number here either.
 */
export const lineTotalCents = (row: { price?: any; promoPrice?: any; quantity?: any }): number => {
    const promo = row.promoPrice != null ? Number(row.promoPrice) : 0;
    const unit = promo > 0 ? promo : (Number(row.price) || 0);
    const qty = Number(row.quantity) || 1;
    const cents = Math.round(unit * qty * 100);
    return Number.isFinite(cents) && cents > 0 ? cents : 0;
};

/** Every line of a receipt with the fields the §4.5 family view and the subtotal need. */
export async function getScopedReceiptItems(receiptId: number, conn?: Connection): Promise<ScopedItemRow[]> {
    const db = conn || (pool as any);
    const [rows]: any = await db.query(
        `SELECT lineIdx, name, isPersonal, price, promoPrice, quantity, unit, amount, sizeUnit,
                isWeighable, matchedSpId, matchedName, storeProductImageUrl,
                categoryId, categoryName, categoryL2Name
           FROM ReceiptItem WHERE receiptId = ? ORDER BY lineIdx ASC`,
        [receiptId],
    );
    return (rows as any[]).map((r) => ({
        lineIdx: Number(r.lineIdx),
        name: typeof r.name === 'string' ? r.name : '',
        isPersonal: bool(r.isPersonal),
        price: num(r.price),
        promoPrice: num(r.promoPrice),
        quantity: num(r.quantity),
        unit: str(r.unit),
        amount: num(r.amount),
        sizeUnit: str(r.sizeUnit),
        isWeighable: bool(r.isWeighable),
        matchedSpId: num(r.matchedSpId),
        matchedName: str(r.matchedName),
        storeProductImageUrl: str(r.storeProductImageUrl),
        categoryId: num(r.categoryId),
        categoryName: str(r.categoryName),
        categoryL2Name: str(r.categoryL2Name),
    }));
}

/**
 * §4.3 — "Only FAMILY items count. receipt_recorded's amountCents is the family
 * subtotal, not the receipt grand total."
 *
 * THE definition of that number, in one place, so the ledger write, the §4.5
 * read and the §4.4 adjustment can never disagree about it. Note what it is NOT
 * derived from: `parsedData.footer.total`. The printed grand total covers
 * personal items too, so anchoring to it — even by scaling — would put personal
 * spend back into a family number. Set-deal discounts are likewise NOT
 * distributed across lines (long-standing project rule: a combo discount
 * belongs to no single product), so a combo receipt's family subtotal is the
 * gross family line-sum.
 */
export async function computeFamilySubtotalCents(receiptId: number, conn?: Connection): Promise<number> {
    const items = await getScopedReceiptItems(receiptId, conn);
    let total = 0;
    for (const it of items) if (!it.isPersonal) total += lineTotalCents(it);
    return total;
}

/**
 * Flip the scope of specific lines. Returns the lineIdxs that actually CHANGED
 * (the `isPersonal <> ?` predicate makes it a compare-and-set), so the caller
 * can skip the ledger work entirely when a toggle is a no-op.
 */
export async function setReceiptItemsScope(
    receiptId: number,
    lineIdxs: number[],
    isPersonal: boolean,
    conn?: Connection,
): Promise<number[]> {
    const db = conn || (pool as any);
    if (lineIdxs.length === 0) return [];
    const [changedRows]: any = await db.query(
        'SELECT lineIdx FROM ReceiptItem WHERE receiptId = ? AND lineIdx IN (?) AND isPersonal <> ?',
        [receiptId, lineIdxs, isPersonal ? 1 : 0],
    );
    const changed = (changedRows as any[]).map((r) => Number(r.lineIdx));
    if (changed.length === 0) return [];
    await db.query(
        'UPDATE ReceiptItem SET isPersonal = ? WHERE receiptId = ? AND lineIdx IN (?)',
        [isPersonal ? 1 : 0, receiptId, changed],
    );
    return changed;
}

/**
 * Patch only the MATCH-STATE columns of one line's row from a mutated line object — used by
 * the swipe/demotion sites so a single-row UPDATE replaces the whole-blob rewrite. Leaves
 * the immutable OCR fields, altMatches, and matchSource untouched (a swipe never changes
 * those). `band` is re-derived from the new itemConfidence.
 */
export async function syncReceiptItemMatchState(
    receiptId: number,
    lineIdx: number,
    line: any,
    conn?: Connection,
): Promise<number> {
    const ic = line?.itemConfidence ?? null;
    return updateReceiptItem(receiptId, lineIdx, {
        matchedSpId: line?.storeProductId ?? null,
        matchedName: line?.matchedName ?? null,
        storeProductImageUrl: line?.storeProductImageUrl ?? null,
        matchConfidence: line?.matchConfidence ?? null,
        matchConfirmed: !!line?.matchConfirmed,
        priceVerified: !!line?.priceVerified,
        variantUncertain: !!line?.variantUncertain,
        categoryId: line?.categoryId ?? null,
        categoryName: line?.categoryName ?? null,
        categoryL2Name: line?.categoryL2Name ?? null,
        itemConfidence: ic,
        band: ic && typeof ic.band === 'string' ? ic.band : null,
        needsHuman: line?.needsHuman ?? null,
    }, conn);
}
