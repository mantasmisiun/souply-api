import { Request, Response, NextFunction } from 'express';
import { createCategory, getTopLevelCategories, getSubCategories, getCategoryById, getCategoryPath, getAllProductsByParentCategory } from '../models/categoryModel';

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