import pool from '../config/db.js';

/**
 * Lazy migration for receipts uploaded before Bundle C of the receipt-
 * detail redesign.
 *
 * The mobile C3 (per-category spending breakdown) needs `categoryName`
 * and `categoryL2Name` on each matched product line. New receipts get
 * both populated server-side at match time (see `JOIN Category` in
 * storeProductModel). Old receipts in the DB have parsedData with
 * `altMatches[i].categoryId` but neither field — or have categoryName
 * but no categoryL2Name (after the L2 rollout). Both gaps are filled
 * by the same pass.
 *
 * Strategy: detect either gap on each receipt GET, hydrate in place
 * from a single batched `Category` self-join, then write the result
 * back so the next read is free. Receipts that are never re-opened
 * stay stale (harmless — they're invisible to the user). No batch
 * migration job, no maintenance window.
 *
 * Returns the receipt with `parsedData` hydrated, preserving the
 * original parsedData shape (string vs object) the caller passed in.
 */
export const hydrateReceiptCategoriesIfNeeded = async (
    receiptId: number,
    receipt: any,
): Promise<any> => {
    if (!receipt?.parsedData) return receipt;

    const parsedDataIsString = typeof receipt.parsedData === 'string';
    let parsed: any;
    try {
        parsed = parsedDataIsString ? JSON.parse(receipt.parsedData) : receipt.parsedData;
    } catch {
        // Malformed parsedData — let the caller's error path handle it.
        return receipt;
    }
    if (!parsed || !Array.isArray(parsed.products)) return receipt;

    // Collect every categoryId on altMatches missing categoryName OR
    // categoryL2Name — both gaps share the same lookup.
    const missingIds = new Set<number>();
    for (const p of parsed.products) {
        if (!Array.isArray(p?.altMatches)) continue;
        for (const am of p.altMatches) {
            const id = Number(am?.categoryId);
            if (!Number.isFinite(id) || id <= 0) continue;
            if (!am.categoryName || am.categoryL2Name === undefined) {
                missingIds.add(id);
            }
        }
    }
    if (missingIds.size === 0) return receipt;

    // Single batched lookup. Resolves leaf name AND the L2 ancestor
    // name with the same CASE used by getUserStats / matchEndpoint —
    // ensures the receipt breakdown and Profilis agree on labels.
    //   c is L1 → NULL L2 (excluded from breakdown)
    //   c is L2 → L2 = c.name
    //   c is L3 → L2 = c2.name (the L2 parent)
    const [rows]: any = await pool.query(
        `SELECT c.id, c.name AS leafName,
                CASE
                  WHEN c.parentCategoryId IS NULL  THEN NULL
                  WHEN c2.parentCategoryId IS NULL THEN c.name
                  ELSE c2.name
                END AS l2Name
           FROM Category c
           LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
          WHERE c.id IN (?)`,
        [Array.from(missingIds)],
    );
    const idToLeaf = new Map<number, string>();
    const idToL2 = new Map<number, string | null>();
    for (const r of rows) {
        idToLeaf.set(Number(r.id), r.leafName);
        idToL2.set(Number(r.id), r.l2Name);
    }

    // Hydrate in place. Only flag `changed` when we actually wrote
    // something — receipts referencing deleted categories shouldn't
    // trigger a no-op UPDATE.
    let changed = false;
    for (const p of parsed.products) {
        if (!Array.isArray(p?.altMatches)) continue;
        for (const am of p.altMatches) {
            const id = Number(am?.categoryId);
            if (!Number.isFinite(id) || id <= 0) continue;
            if (!am.categoryName) {
                const name = idToLeaf.get(id);
                if (name) {
                    am.categoryName = name;
                    changed = true;
                }
            }
            if (am.categoryL2Name === undefined && idToL2.has(id)) {
                // Store null too — distinguishes "L1 product, no L2 ancestor"
                // from "not yet rehydrated". Next hydration pass skips it.
                am.categoryL2Name = idToL2.get(id) ?? null;
                changed = true;
            }
        }
    }
    if (!changed) return receipt;

    // Persist so this receipt is cheap to re-open. Best-effort: a write
    // failure here shouldn't fail the GET — the caller already has
    // hydrated data in memory for this response.
    try {
        await pool.query(
            'UPDATE Receipt SET parsedData = ? WHERE id = ?',
            [JSON.stringify(parsed), receiptId],
        );
    } catch (e) {
        console.warn(
            `[hydrateReceiptCategoriesIfNeeded] write-back failed for receipt ${receiptId}:`,
            e,
        );
    }

    return {
        ...receipt,
        parsedData: parsedDataIsString ? JSON.stringify(parsed) : parsed,
    };
};
