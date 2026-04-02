import { Request, Response } from 'express';
import { createCategory, getTopLevelCategories, getSubCategories } from '../models/categoryModel';

export const addCategory = async (req: Request, res: Response) => {
    const { name, parentCategoryId } = req.body;
    if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }
    const id = await createCategory(name, parentCategoryId || null);
    res.status(201).json({ id, name, parentCategoryId });
};

export const fetchAllCategories = async (req: Request, res: Response) => {
    const categories = await getTopLevelCategories();
    res.json(categories);
};

export const fetchSubCategories = async (req: Request, res: Response) => {
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
};