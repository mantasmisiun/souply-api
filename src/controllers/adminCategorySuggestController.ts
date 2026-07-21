import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { getCachedCrossChainCandidates } from '../models/storeProductModel.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../utils/productMatcher.js';
import { stemQuery } from '../utils/searchStem.js';

/**
 * Category suggestions for one product — powers the one-tap "Kategorija?"
 * assignment in the admin panel. Combines the two engines proven in the
 * non-leaf recat (T4a/T4b):
 *   similar  — weak-floor matcher hits: which LEAF categories similar catalog
 *              products live in, confidence-weighted.
 *   name     — head-noun leaf-name vote over ALL leaf categories (global scope
 *              is fine here — a human confirms every pick).
 */

const NEPRISKIRTA_ID = 688;

const stemWord = (w: string) =>
    w.replace(/(iams|omis|ėmis|iais|uose|ose|ams|ais|ius|iai|ios|ies|iui|io|ia|is|ys|as|us|os|es|ės|ai|ą|ę|į|ų|ū|ė|a|e|i|o|u|y)$/, '');

export const getProductCategorySuggestions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const productId = Number(req.params.id);
        if (!productId) { res.status(400).json({ error: 'product id required' }); return; }

        const [sps]: any = await pool.query(
            `SELECT sp.chainId, sp.storeProductName, sp.amount, sp.unit, sp.isWeighable
               FROM StoreProduct sp WHERE sp.productId = ?`, [productId]);
        if (!(sps as any[]).length) { res.json({ suggestions: [] }); return; }

        type Sugg = { categoryId: number; score: number; example: string | null; source: 'similar' | 'name' };
        const tally = new Map<number, Sugg>();
        const bump = (categoryId: number, score: number, example: string | null, source: Sugg['source']) => {
            const cur = tally.get(categoryId);
            if (!cur) tally.set(categoryId, { categoryId, score, example, source });
            else { cur.score += score; if (!cur.example) cur.example = example; }
        };

        // ── engine 1: similar catalog products (matcher, weak floor) ─────────
        // Cross-chain candidates of a NEUTRAL chain id 0 = all chains included.
        const cands = (await getCachedCrossChainCandidates(0))
            .filter((c: any) => c.categoryId && Number(c.categoryId) !== NEPRISKIRTA_ID);
        const normed = cands.map((c: any) => ({ c, hay: normalizeProductName(c.storeProductName) }));
        for (const sp of (sps as any[]).slice(0, 3)) {
            const name = String(sp.storeProductName);
            let stems = stemQuery(name).map(s => normalizeProductName(s)).filter(s => s.length >= 4);
            let pool2 = normed.filter(n => stems.some(st => n.hay.includes(st))).map(n => n.c);
            if (!pool2.length) {
                const prefixes = [...new Set(stems.map(s => s.slice(0, 4)))];
                pool2 = normed.filter(n => prefixes.some(p => n.hay.includes(p))).map(n => n.c);
            }
            if (!pool2.length) continue;
            const ms = findBestProductMatches(
                name, sp.amount != null ? Number(sp.amount) : null, sp.unit ?? null,
                pool2 as unknown as MatchCandidate[], 0.45, 5, !!sp.isWeighable, { typed: true });
            for (const m of ms) {
                const cand: any = pool2.find((c: any) => Number(c.id) === Number(m.storeProductId));
                if (cand?.categoryId) bump(Number(cand.categoryId), m.confidence, m.name, 'similar');
            }
        }

        // ── engine 2: leaf-name head-noun vote ───────────────────────────────
        const [cats]: any = await pool.query(
            `SELECT c.id, c.name FROM Category c
              WHERE NOT EXISTS (SELECT 1 FROM Category ch WHERE ch.parentCategoryId = c.id)
                AND c.id <> ${NEPRISKIRTA_ID}`);
        const spStems = (sps as any[]).flatMap(sp =>
            normalizeProductName(String(sp.storeProductName)).split(/\s+/).map(stemWord).filter(s => s.length >= 3));
        for (const cat of cats as any[]) {
            const conjuncts = String(cat.name).split(/\s+ir\s+|,\s*/i);
            const heads = conjuncts.map(cj => {
                const ws = normalizeProductName(cj).split(/\s+/).filter(Boolean);
                return stemWord(ws[ws.length - 1] ?? '');
            }).filter(s => s.length >= 3);
            const hit = heads.some(h => spStems.some(ps => ps.startsWith(h) || h.startsWith(ps)));
            if (hit) bump(Number(cat.id), 0.5, null, 'name');
        }

        // ── merge, resolve names, top 5 ──────────────────────────────────────
        const top = [...tally.values()].sort((a, b) => b.score - a.score).slice(0, 5);
        if (!top.length) { res.json({ suggestions: [] }); return; }
        const [names]: any = await pool.query(
            `SELECT c.id, c.name, pc.name AS parentName
               FROM Category c LEFT JOIN Category pc ON pc.id = c.parentCategoryId
              WHERE c.id IN (?)`, [top.map(t => t.categoryId)]);
        const nameById = new Map((names as any[]).map(r => [Number(r.id), r]));
        res.json({
            suggestions: top.map(t => ({
                categoryId: t.categoryId,
                categoryName: nameById.get(t.categoryId)?.name ?? String(t.categoryId),
                parentName: nameById.get(t.categoryId)?.parentName ?? null,
                score: +t.score.toFixed(2),
                example: t.example,
                source: t.source,
            })),
        });
    } catch (e) { next(e); }
};
