/**
 * Template sharing — Pass B.1 of the šablonai roadmap.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 4.1 + landing-page.md
 * Part 2.1.
 *
 * Allocates a 10-char alphanumeric `shareSlug` to a template if absent,
 * runs the comparison engine on its items, persists the resulting
 * snapshot (cheapest chain id, totals, calculatedAt) on the template
 * row, and returns the data needed by both the in-app share sheet and
 * the public landing page.
 *
 * Pass B.1 scope: slug + snapshot. Branded QR generation is a separate
 * service (templateQrService) so this one stays focused.
 */

import pool from '../config/db.js';
import { calculateBasketForStores, type StoreResult } from './basketCalculationService.js';
import { getTemplateItems, getTemplateById } from '../models/basketTemplateModel.js';
import { generateBrandedQrWithDataUri } from './templateQrService.js';

export const SHARE_SLUG_LENGTH = 10;
const SHARE_SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a slug from a small alphabet (no upper/lower confusion, no
 * special chars). Probability of collision at length 10 with 36^10 ≈ 3.6e15
 * is negligible at our scale, but we retry on collision anyway.
 */
export function generateSlug(): string {
    let out = '';
    for (let i = 0; i < SHARE_SLUG_LENGTH; i++) {
        out += SHARE_SLUG_ALPHABET[Math.floor(Math.random() * SHARE_SLUG_ALPHABET.length)];
    }
    return out;
}

async function allocateUniqueSlug(): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = generateSlug();
        const [rows]: any = await pool.query(
            `SELECT 1 FROM BasketTemplate WHERE shareSlug = ? LIMIT 1`,
            [candidate],
        );
        if (rows.length === 0) return candidate;
    }
    throw new Error('Could not allocate unique shareSlug after 6 attempts');
}

export interface SnapshotResult {
    cheapestChainId: number | null;
    cheapestTotalEur: number | null;
    runnerUpTotalEur: number | null;
    /** Highest full-coverage total across all stores, used by the share
     *  preview's "save up to €X" headline. Null when only one chain has
     *  coverage. */
    mostExpensiveTotalEur: number | null;
    calculatedAt: Date;
}

/**
 * Pure ranking: given the comparison engine's per-store results, find the
 * cheapest chain (lowest-total full-coverage store) and the runner-up
 * chain's lowest total. Snapshot stores chain-level numbers because the
 * landing page renders the brand, not a specific store address.
 */
export function pickSnapshotFromStoreResults(results: StoreResult[]): {
    cheapestChainId: number | null;
    cheapestTotalEur: number | null;
    runnerUpTotalEur: number | null;
    mostExpensiveTotalEur: number | null;
} {
    if (results.length === 0) {
        return { cheapestChainId: null, cheapestTotalEur: null, runnerUpTotalEur: null, mostExpensiveTotalEur: null };
    }

    // Group by chain, pick the cheapest store per chain (full-coverage
    // beats partial — calc service already sorted that way).
    const byChain = new Map<number, { total: number; missing: number }>();
    for (const r of results as any[]) {
        const chainId = Number(r.chainId);
        if (!Number.isFinite(chainId)) continue;
        const total = Number(r.total ?? 0);
        const missing = Number(r.missingItemCount ?? 0);
        const cur = byChain.get(chainId);
        if (!cur || missing < cur.missing || (missing === cur.missing && total < cur.total)) {
            byChain.set(chainId, { total, missing });
        }
    }

    // Sort chains: fewest missing first, then total ascending.
    const ranked = Array.from(byChain.entries())
        .map(([chainId, v]) => ({ chainId, total: v.total, missing: v.missing }))
        .sort((a, b) => (a.missing - b.missing) || (a.total - b.total));

    const cheapest = ranked[0] ?? null;
    const runnerUp = ranked[1] ?? null;
    // Most expensive among full-coverage chains. Falls back to the overall
    // worst when no chain has full coverage so the "save up to €X" line
    // still shows something for small baskets where every chain has
    // missing items.
    const fullCoverage = ranked.filter(r => r.missing === 0);
    const mostExpensive = (fullCoverage.length > 0 ? fullCoverage : ranked).at(-1) ?? null;
    return {
        cheapestChainId: cheapest?.chainId ?? null,
        cheapestTotalEur: cheapest?.total ?? null,
        runnerUpTotalEur: runnerUp?.total ?? null,
        mostExpensiveTotalEur: mostExpensive && mostExpensive.chainId !== cheapest?.chainId
            ? mostExpensive.total : null,
    };
}

/**
 * Run the comparison engine on a template's items and return the
 * snapshot. Pure-ish: doesn't write to the DB itself — the caller
 * persists the result inside its own transaction.
 */
export async function computeSnapshotForTemplate(templateId: number): Promise<SnapshotResult | null> {
    const items = await getTemplateItems(templateId);
    if (items.length === 0) return null;

    const results = await calculateBasketForStores(0, {
        items: items.map((it: any) => ({
            productId: Number(it.productId),
            quantity: Number(it.quantity) || 1,
            matchMode: 'sku',
            name: String(it.productName ?? ''),
        })),
    });

    const pick = pickSnapshotFromStoreResults(results);
    return { ...pick, calculatedAt: new Date() };
}

/**
 * The end-to-end share orchestrator: allocate slug, compute snapshot,
 * persist both, and return everything the client needs for the share
 * sheet (slug, URL, snapshot for the in-app preview).
 *
 * Visibility transition: if the template is currently 'private', it is
 * upgraded to 'unlisted' (the slug is the share contract). 'public'
 * stays public. Private → unlisted is automatic; private → public
 * requires the publish wall (Pass B.4) which lives in a separate
 * endpoint, not in this service.
 */
export interface ShareResult {
    slug: string;
    visibility: 'unlisted' | 'public';
    qrUrl: string | null;
    /** Inline branded QR PNG as a data URI — primary source for the
     *  in-app share sheet so the brand mark is always visible regardless
     *  of whether the MinIO upload URL is reachable from the phone. */
    qrDataUrl: string | null;
    snapshot: {
        cheapestChainId: number | null;
        cheapestTotalEur: number | null;
        runnerUpTotalEur: number | null;
        mostExpensiveTotalEur: number | null;
        calculatedAt: string | null;
    };
}

export async function shareTemplate(templateId: number): Promise<ShareResult> {
    const template = await getTemplateById(templateId);
    if (!template) throw new Error('Template not found');

    const slug = template.shareSlug ?? await allocateUniqueSlug();
    const snapshot = await computeSnapshotForTemplate(templateId);

    const targetVisibility: 'unlisted' | 'public' =
        template.visibility === 'public' ? 'public' : 'unlisted';

    // Branded QR generation runs concurrently with the snapshot persist.
    // Failure is non-fatal — the share still works, just without a
    // server-cached PNG; the client falls back to the local QR.
    const url = `https://souply.lt/t/${slug}`;
    let qrUrl: string | null = null;
    let qrDataUrl: string | null = null;
    try {
        const out = await generateBrandedQrWithDataUri(slug, url);
        qrUrl = out.qrUrl;
        qrDataUrl = out.qrDataUrl;
    } catch (e: any) {
        console.warn('[templateShare] branded QR generation failed:', e?.message);
    }

    await pool.query(
        `UPDATE BasketTemplate
            SET shareSlug                  = ?,
                visibility                 = ?,
                snapshotCheapestChainId    = ?,
                snapshotTotalEur           = ?,
                snapshotRunnerUpEur        = ?,
                snapshotMostExpensiveEur   = ?,
                snapshotCalculatedAt       = ?
          WHERE id = ?`,
        [
            slug,
            targetVisibility,
            snapshot?.cheapestChainId ?? null,
            snapshot?.cheapestTotalEur ?? null,
            snapshot?.runnerUpTotalEur ?? null,
            snapshot?.mostExpensiveTotalEur ?? null,
            snapshot?.calculatedAt ?? null,
            templateId,
        ],
    );

    return {
        slug,
        visibility: targetVisibility,
        qrUrl,
        qrDataUrl,
        snapshot: {
            cheapestChainId: snapshot?.cheapestChainId ?? null,
            cheapestTotalEur: snapshot?.cheapestTotalEur ?? null,
            runnerUpTotalEur: snapshot?.runnerUpTotalEur ?? null,
            mostExpensiveTotalEur: snapshot?.mostExpensiveTotalEur ?? null,
            calculatedAt: snapshot?.calculatedAt?.toISOString() ?? null,
        },
    };
}

/**
 * Clear the cached snapshot fields. Called whenever a template's items
 * change so the next share request re-computes against current prices.
 * Leaves `shareSlug` untouched — the link stays alive, only the cached
 * preview is invalidated.
 */
export async function invalidateSnapshot(templateId: number): Promise<void> {
    await pool.query(
        `UPDATE BasketTemplate
            SET snapshotCheapestChainId    = NULL,
                snapshotTotalEur           = NULL,
                snapshotRunnerUpEur        = NULL,
                snapshotMostExpensiveEur   = NULL,
                snapshotCalculatedAt       = NULL
          WHERE id = ?`,
        [templateId],
    );
}

/**
 * Public slug-resolution path (landing page + app preview screen).
 * Returns template metadata + items + snapshot. Returns null for
 * unknown slugs or templates whose visibility was downgraded back to
 * 'private' after the link was generated — the spec says private slugs
 * should 404 rather than leak the prior public state.
 */
export interface ResolvedSlug {
    template: {
        id: number;
        name: string;
        creatorHandle: string | null;
        useCount: number;
        visibility: 'unlisted' | 'public';
    };
    snapshot: {
        cheapestChainId: number | null;
        cheapestTotalEur: number | null;
        runnerUpTotalEur: number | null;
        mostExpensiveTotalEur: number | null;
        calculatedAt: string | null;
    };
    items: Array<{
        productId: number;
        productName: string;
        quantity: number;
        unit: string | null;
        imageUrls: string[] | null;
    }>;
}

export async function resolveSlug(slug: string): Promise<ResolvedSlug | null> {
    const [rows]: any = await pool.query(
        `SELECT id, name, creatorHandle, useCount, visibility,
                snapshotCheapestChainId, snapshotTotalEur, snapshotRunnerUpEur,
                snapshotMostExpensiveEur, snapshotCalculatedAt
           FROM BasketTemplate
          WHERE shareSlug = ? AND visibility IN ('unlisted', 'public')
          LIMIT 1`,
        [slug],
    );
    const row = rows[0];
    if (!row) return null;

    const items = await getTemplateItems(Number(row.id));

    return {
        template: {
            id: Number(row.id),
            name: row.name,
            creatorHandle: row.creatorHandle,
            useCount: Number(row.useCount ?? 0),
            visibility: row.visibility,
        },
        snapshot: {
            cheapestChainId: row.snapshotCheapestChainId !== null ? Number(row.snapshotCheapestChainId) : null,
            cheapestTotalEur: row.snapshotTotalEur !== null ? Number(row.snapshotTotalEur) : null,
            runnerUpTotalEur: row.snapshotRunnerUpEur !== null ? Number(row.snapshotRunnerUpEur) : null,
            mostExpensiveTotalEur: row.snapshotMostExpensiveEur !== null ? Number(row.snapshotMostExpensiveEur) : null,
            calculatedAt: row.snapshotCalculatedAt ? new Date(row.snapshotCalculatedAt).toISOString() : null,
        },
        items: items.map((it: any) => ({
            productId: Number(it.productId),
            productName: String(it.productName ?? ''),
            quantity: Number(it.quantity),
            unit: it.unit ?? null,
            imageUrls: Array.isArray(it.imageUrls) ? it.imageUrls : null,
        })),
    };
}
