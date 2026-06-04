import pool from '../config/db.js';
import type { Connection } from 'mysql2/promise';
import { clampSavings } from '../util/savings.js';

export interface BasketTemplateRow {
    id: number;
    userId: string;
    name: string;
    isDefault: 0 | 1;
    autoUpdate: 0 | 1;
    visibility: 'private' | 'unlisted' | 'public';
    shareSlug: string | null;
    creatorHandle: string | null;
    sourceTemplateId: number | null;
    useCount: number;
    visitCount: number;
    collectiveSavingsEur: string; // mysql2 returns DECIMAL as string
    snapshotCheapestChainId: number | null;
    snapshotTotalEur: string | null;
    snapshotRunnerUpEur: string | null;
    snapshotMostExpensiveEur: string | null;
    snapshotCalculatedAt: Date | null;
    coverColor: string | null;
    coverImage: unknown | null;
    createdAt: Date;
    updatedAt: Date;
    /** Set only on genuine content edits (name / cover / items). Non-null →
     *  the "Sukurta" stat flips to "Redaguota" (with this date). NULL = never
     *  edited. Decoupled from `updatedAt`, which auto-bumps on every write. */
    editedAt: Date | null;
}

export interface BasketTemplateItemRow {
    id: number;
    templateId: number;
    productId: number;
    quantity: string;
    unit: string | null;
    sortOrder: number;
}

export interface TemplateItemInput {
    productId: number;
    quantity: number;
    unit?: string | null;
    sortOrder?: number;
}

export const createTemplate = async (
    userId: string,
    name: string,
    opts: {
        isDefault?: boolean;
        autoUpdate?: boolean;
        sourceTemplateId?: number | null;
        coverColor?: string | null;
        /** { kind: 'preset', iconKey } | { kind: 'emoji', emoji }. Stored as
         *  JSON; null falls back to the deterministic sample cover. */
        coverImage?: unknown;
    } = {},
    conn?: Connection,
): Promise<number> => {
    const db = (conn ?? pool) as any;
    const [result]: any = await db.query(
        `INSERT INTO BasketTemplate
            (userId, name, isDefault, autoUpdate, sourceTemplateId, coverColor, coverImage)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            name,
            opts.isDefault ? 1 : 0,
            opts.autoUpdate ? 1 : 0,
            opts.sourceTemplateId ?? null,
            opts.coverColor ?? null,
            opts.coverImage != null ? JSON.stringify(opts.coverImage) : null,
        ],
    );
    return result.insertId;
};

/** Update the cover identity (colour + image). Either field may be omitted
 *  to leave it unchanged; pass null to clear. */
export const setTemplateCover = async (
    id: number,
    cover: { coverColor?: string | null; coverImage?: unknown },
) => {
    const sets: string[] = [];
    const params: any[] = [];
    if (cover.coverColor !== undefined) { sets.push('coverColor = ?'); params.push(cover.coverColor); }
    if (cover.coverImage !== undefined) {
        sets.push('coverImage = ?');
        params.push(cover.coverImage != null ? JSON.stringify(cover.coverImage) : null);
    }
    if (sets.length === 0) return;
    params.push(id);
    await pool.query(`UPDATE BasketTemplate SET ${sets.join(', ')} WHERE id = ?`, params);
};

export const getTemplateById = async (id: number): Promise<BasketTemplateRow | null> => {
    const [rows]: any = await pool.query(
        `SELECT * FROM BasketTemplate WHERE id = ? LIMIT 1`,
        [id],
    );
    return rows[0] ?? null;
};

/**
 * List of a user's templates, newest first, with item count joined in for
 * card rendering. No visibility filter — owner sees all their templates
 * (private + unlisted + public). Public-profile / discovery queries live
 * in a separate model fn once Pass B ships.
 */
export const getTemplatesByUserId = async (userId: string) => {
    const [rows]: any = await pool.query(
        `SELECT bt.*,
                (SELECT COUNT(*) FROM BasketTemplateItem bti
                  WHERE bti.templateId = bt.id) AS itemCount
           FROM BasketTemplate bt
          WHERE bt.userId = ?
          ORDER BY bt.updatedAt DESC`,
        [userId],
    );
    return rows;
};

export const renameTemplate = async (id: number, name: string) => {
    await pool.query(
        `UPDATE BasketTemplate SET name = ? WHERE id = ?`,
        [name, id],
    );
};

export const setTemplateAutoUpdate = async (id: number, autoUpdate: boolean) => {
    await pool.query(
        `UPDATE BasketTemplate SET autoUpdate = ? WHERE id = ?`,
        [autoUpdate ? 1 : 0, id],
    );
};

export const deleteTemplate = async (id: number) => {
    await pool.query(`DELETE FROM BasketTemplate WHERE id = ?`, [id]);
};

export const incrementTemplateUseCount = async (id: number, conn?: Connection) => {
    const db = (conn ?? pool) as any;
    await db.query(
        `UPDATE BasketTemplate SET useCount = useCount + 1 WHERE id = ?`,
        [id],
    );
};

/**
 * Record one engagement of `kind` for (template, actor) today and report
 * whether it was the FIRST today. Backed by a per-day unique key, so callers
 * bump useCount/visitCount at most once per actor per template per day (burst
 * protection) while a genuine recurring shopper still counts once daily.
 * `actorKey` = user UUID for known users, or `ip:<addr>` for anonymous web
 * visitors. Self-exclusion (creator's own actions) is enforced by the caller.
 */
export const recordTemplateEngagementOncePerDay = async (
    templateId: number,
    actorKey: string,
    kind: 'use' | 'visit',
    conn?: Connection,
): Promise<boolean> => {
    const db = (conn ?? pool) as any;
    const [r]: any = await db.query(
        `INSERT IGNORE INTO TemplateEngagementDay (templateId, actorKey, kind, day)
         VALUES (?, ?, ?, CURRENT_DATE())`,
        [templateId, actorKey, kind],
    );
    return r?.affectedRows === 1;
};

/**
 * Stamp a content edit (name / cover / items) — drives the "Redaguota" stat.
 * Deliberately separate from `updatedAt` (which auto-bumps on every write,
 * including counters/shares) so the stat only reflects real edits.
 */
export const touchTemplateEdited = async (id: number, conn?: Connection) => {
    const db = (conn ?? pool) as any;
    await db.query(`UPDATE BasketTemplate SET editedAt = NOW() WHERE id = ?`, [id]);
};

/**
 * Accrue realised savings onto a template's running total. Called once per
 * basket when the user picks a store and creates a shopping list from a
 * template-derived basket (ShoppingList.basketId is UNIQUE, so this fires
 * at most once per basket). `eur` is the realised saving for that shop
 * (priciest store total − chosen store total), clamped ≥ 0.
 */
export const addCollectiveSavings = async (id: number, eur: number, conn?: Connection) => {
    const db = (conn ?? pool) as any;
    const amount = clampSavings(eur);
    if (amount <= 0) return;
    await db.query(
        `UPDATE BasketTemplate SET collectiveSavingsEur = collectiveSavingsEur + ? WHERE id = ?`,
        [amount, id],
    );
};

// ── Items ──────────────────────────────────────────────────────────────────

export const getTemplateItems = async (templateId: number) => {
    // `isWeighable` is derived from the matched StoreProduct rows — if
    // ANY chain sells this Product by weight, treat it as weighable on
    // the client. Mirrors how `getBasketItemsByBasketId` exposes the
    // flag for basket rows so the editor can reuse the same UX (kg
    // unit, decimal keyboard, 0.1 stepper).
    const [rows]: any = await pool.query(
        `SELECT bti.*,
                p.name AS productName,
                (SELECT JSON_ARRAYAGG(spi.imageUrl)
                   FROM StoreProduct spi
                  WHERE spi.productId = bti.productId
                    AND spi.imageUrl IS NOT NULL) AS imageUrls,
                (SELECT COALESCE(MAX(sp.isWeighable), 0)
                   FROM StoreProduct sp
                  WHERE sp.productId = bti.productId) AS isWeighable
           FROM BasketTemplateItem bti
           JOIN Product p ON p.id = bti.productId
          WHERE bti.templateId = ?
          ORDER BY bti.sortOrder ASC, bti.id ASC`,
        [templateId],
    );
    return rows;
};

/**
 * Bulk insert items into a template in one query. Used both by manual
 * "save current basket as template" and by cloned-from-share creation.
 * Caller may provide a connection to keep this inside a transaction.
 */
export const insertTemplateItemsBatch = async (
    templateId: number,
    items: TemplateItemInput[],
    conn?: Connection,
): Promise<number> => {
    if (items.length === 0) return 0;
    const db = (conn ?? pool) as any;
    const values = items.map((it, i) => [
        templateId,
        it.productId,
        it.quantity,
        it.unit ?? null,
        it.sortOrder ?? i,
    ]);
    const [res]: any = await db.query(
        `INSERT INTO BasketTemplateItem
            (templateId, productId, quantity, unit, sortOrder)
         VALUES ?`,
        [values],
    );
    return res.affectedRows as number;
};

export const addTemplateItem = async (
    templateId: number,
    input: TemplateItemInput,
): Promise<number> => {
    const [res]: any = await pool.query(
        `INSERT INTO BasketTemplateItem
            (templateId, productId, quantity, unit, sortOrder)
         VALUES (?, ?, ?, ?, ?)`,
        [
            templateId,
            input.productId,
            input.quantity,
            input.unit ?? null,
            input.sortOrder ?? 0,
        ],
    );
    return res.insertId;
};

export const updateTemplateItemQuantity = async (id: number, quantity: number) => {
    await pool.query(
        `UPDATE BasketTemplateItem SET quantity = ? WHERE id = ?`,
        [quantity, id],
    );
};

export const updateTemplateItemSortOrder = async (id: number, sortOrder: number) => {
    await pool.query(
        `UPDATE BasketTemplateItem SET sortOrder = ? WHERE id = ?`,
        [sortOrder, id],
    );
};

export const deleteTemplateItem = async (id: number) => {
    await pool.query(`DELETE FROM BasketTemplateItem WHERE id = ?`, [id]);
};

export const getTemplateItemById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT id, templateId, productId FROM BasketTemplateItem WHERE id = ? LIMIT 1`,
        [id],
    );
    return rows[0] ?? null;
};
