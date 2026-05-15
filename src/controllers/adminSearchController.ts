import { Request, Response, NextFunction } from 'express';
import { searchProductsForAdmin } from '../models/productModel.js';
import { searchL3CategoriesByName } from '../models/categoryModel.js';

/**
 * Type-ahead search endpoints for the admin Flags-tab card UI.
 *
 *   GET /api/admin/products/search?q=…
 *     Slim Product[] payload — id, name, categoryId, categoryName.
 *     Powers the "Pavadinimas" search field that relinks an SP to a
 *     different Product (or surfaces a "no match → create new" path).
 *
 *   GET /api/admin/categories/search?q=…
 *     L3 category[] (leaf categories — what `Product.categoryId` points
 *     at). Powers the "Kategorija" type-ahead. Reuses the existing
 *     `searchL3CategoriesByName` so the localisation matches the rest
 *     of the app.
 */

export const adminProductSearch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const q = String(req.query.q ?? '').trim();
        if (!q) {
            res.json({ rows: [] });
            return;
        }
        const limit = Math.max(1, Math.min(25, Number(req.query.limit ?? 10)));
        const locale = ((req as any).locale ?? 'lt') as 'lt' | 'en';
        const rows = await searchProductsForAdmin(q, locale, limit);
        res.json({ rows });
    } catch (e) { next(e); }
};

export const adminCategorySearch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const q = String(req.query.q ?? '').trim();
        if (!q) {
            res.json({ rows: [] });
            return;
        }
        const locale = ((req as any).locale ?? 'lt') as 'lt' | 'en';
        const rows = await searchL3CategoriesByName(q, locale);
        res.json({ rows });
    } catch (e) { next(e); }
};
