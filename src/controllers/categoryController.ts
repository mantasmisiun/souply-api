import { Request, Response, NextFunction } from 'express';
import { createCategory, getTopLevelCategories, getSubCategories, getCategoryById, getCategoryPath, getCategoryAncestors, getStoreProductsByCategoryAndChain, getAllProductsByParentCategory, searchL3CategoriesByName, resolveCategoryByPath } from '../models/categoryModel.js';

export const addCategory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name, parentCategoryId } = req.body;
        if (!name) {
            res.status(400).json({ error: 'Name is required' });
            return;
        }
        const id = await createCategory(name, parentCategoryId || null);
        res.status(201).json({ id, name, parentCategoryId });
    } catch (error) {
        next(error);
    }
};

export const fetchAllCategories = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const categories = await getTopLevelCategories();
        res.json(categories);
    } catch (error) {
        next(error);
    }
};

export const fetchSubCategories = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const category = await getSubCategories(id);
        if (category.length === 0) {
            res.status(404).json({ error: 'No subcategories found' });
            return;
        }
        res.json(category);
    } catch (error) {
        next(error);
    }
};

export const fetchCategoryById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const category = await getCategoryById(id);
        if (!category) {
            res.status(404).json({ error: 'Category not found' });
            return;
        }
        res.json(category);
    } catch (error) {
        next(error);
    }
};

export const fetchCategoryPath = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const path = await getCategoryPath(id);
        res.json({ path });
    } catch (error) {
        next(error);
    }
};

export const fetchAllProductsByParentCategory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const categoryId = Number(req.params.categoryId);
        if (isNaN(categoryId)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const products = await getAllProductsByParentCategory(categoryId);
        res.json(products);
    } catch (error) {
        next(error);
    }
};

export const fetchCategoryAncestors = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const ancestors = await getCategoryAncestors(id);
        res.json(ancestors);
    } catch (error) {
        next(error);
    }
};

export const fetchStoreProductsByCategory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const chainId = Number(req.query.chainId);
        if (isNaN(id) || isNaN(chainId)) {
            res.status(400).json({ error: 'Valid category ID and chainId required' });
            return;
        }
        const products = await getStoreProductsByCategoryAndChain(id, chainId);
        res.json(products);
    } catch (error) {
        next(error);
    }
};

export const fetchL3CategorySearch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!q) {
            res.status(400).json({ error: 'q is required' });
            return;
        }
        const rows = await searchL3CategoriesByName(q);
        res.json(rows);
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/categories/resolve-path
 * Body: { path: string[] }  // e.g. ["Mėsa ir paukštiena", "Dešros", ...]
 *
 * Returns the deepest matching Category id (or null) for a hierarchical
 * path. Used by scrapers to map their chain's category tree onto ours.
 */
export const resolveCategoryPathHandler = async (
    req: Request, res: Response, next: NextFunction
) => {
    try {
        const { path } = req.body ?? {};
        if (!Array.isArray(path) || path.some((s: any) => typeof s !== 'string')) {
            res.status(400).json({ error: 'path must be an array of strings' });
            return;
        }
        const id = await resolveCategoryByPath(path);
        res.json({ id });
    } catch (error) {
        next(error);
    }
};