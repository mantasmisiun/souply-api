import pool from '../config/db.js';
import { normalizeProductName } from '../utils/productMatcher.js';
import { parseSize } from '../scrapers/shared/parseSize.js';
import { findExactMatchingStoreProduct, createStoreProduct } from '../models/storeProductModel.js';
import { createProduct } from '../models/productModel.js';
import { matchScrapedProduct } from '../scrapers/shared/scraperProductMatch.js';

/**
 * UMBRELLA variant resolution via receipt evidence (Lidl item codes).
 *
 * A leaflet variant tile ("VALSOIA Augalinis gėrimas", 3 codes) creates ONE
 * umbrella SP holding all codes. Receipts print `code + FULL variant name`
 * ("7608825 VALSOIA Avižų gėrimas 1L") — recording that evidence resolves the
 * umbrella: after K=2 independent sightings of the same (code, name), the code
 * graduates to a DEDICATED SP with the printed name and its own price history.
 *
 * No fabrication: names come from printed receipts, K=2 guards against OCR
 * garbles, prices arrive only via real observations (next scrape / receipt).
 */

const PROMOTE_AT = 2; // sightings needed — mirrors the vocabulary K=2 rule

export interface CodeResolution {
    action: 'recorded' | 'already_resolved' | 'promoted_existing' | 'promoted_minted';
    code: string;
    spId?: number;
    spName?: string;
}

const norm = (s: string) => s.replace(/^0+/, '');

/**
 * Record one receipt sighting of (code, printedName). Returns what happened.
 * Promotion only fires for codes currently mapped to an UMBRELLA SP (an SP
 * holding ≥2 codes) — single-code SPs already ARE the exact product.
 */
export async function recordCodeEvidence(
    chainId: number,
    rawCode: string,
    printedName: string,
): Promise<CodeResolution> {
    const code = norm(rawCode);
    const name = printedName.trim().replace(/\s+/g, ' ');
    if (!/^\d{3,16}$/.test(code) || name.length < 3) return { action: 'recorded', code };
    const normalizedName = normalizeProductName(name).slice(0, 255);

    // 1. Upsert the evidence row.
    await pool.query(
        `INSERT INTO StoreProductCodeEvidence (chainId, code, normalizedName, printedName)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE seenCount = seenCount + 1, lastSeenAt = NOW()`,
        [chainId, code, normalizedName, name.slice(0, 255)],
    );

    // 2. Which SP holds this code, and is it an umbrella?
    const [mapRows]: any = await pool.query(
        `SELECT spc.storeProductId,
                (SELECT COUNT(*) FROM StoreProductCode x WHERE x.storeProductId = spc.storeProductId) AS codeCount
           FROM StoreProductCode spc WHERE spc.chainId = ? AND spc.code = ?`,
        [chainId, code],
    );
    const mapping = mapRows[0];
    if (!mapping || Number(mapping.codeCount) <= 1) {
        // Unmapped code or already a dedicated (single-code) SP — nothing to split.
        return { action: mapping ? 'already_resolved' : 'recorded', code, spId: mapping?.storeProductId };
    }

    // 3. K-gate.
    const [evRows]: any = await pool.query(
        `SELECT seenCount FROM StoreProductCodeEvidence WHERE chainId = ? AND code = ? AND normalizedName = ?`,
        [chainId, code, normalizedName],
    );
    if (Number(evRows[0]?.seenCount ?? 0) < PROMOTE_AT) return { action: 'recorded', code };

    // 4. Promote: dedicated SP for this code. Prefer an EXISTING exact SP
    //    (the variant may already be in the catalog from other sources).
    const { storeProductName, amount, unit, isWeighable } = parseSize(name);
    let spId: number | null = await findExactMatchingStoreProduct(chainId, storeProductName, amount, unit);
    let action: CodeResolution['action'] = 'promoted_existing';
    if (!spId) {
        // Product resolution for the full variant name via the standard ladder
        // (join / consensus / 688) — NOT the umbrella's product.
        const match = await matchScrapedProduct(chainId, storeProductName, amount, unit, isWeighable);
        let productId: number;
        if (match.spId != null) {
            spId = match.spId; // the full name exactly matches an existing chain SP
        } else {
            if (match.productId != null) productId = match.productId;
            else {
                productId = await createProduct(match.categoryId, null, storeProductName);
                if (match.reviewPending) {
                    await pool.query('UPDATE Product SET categoryReviewPending = 1 WHERE id = ?', [productId]);
                }
            }
            spId = await createStoreProduct(productId, chainId, storeProductName, null, isWeighable, amount, unit, null, null);
            action = 'promoted_minted';
        }
    }
    if (!spId) return { action: 'recorded', code };

    // 5. Re-point the code umbrella → dedicated SP + stamp the evidence row.
    await pool.query('UPDATE StoreProductCode SET storeProductId = ? WHERE chainId = ? AND code = ?', [spId, chainId, code]);
    await pool.query(
        'UPDATE StoreProductCodeEvidence SET resolvedSpId = ? WHERE chainId = ? AND code = ? AND normalizedName = ?',
        [spId, chainId, code, normalizedName],
    );
    return { action, code, spId, spName: storeProductName };
}
