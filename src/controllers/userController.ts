import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createUser, getUserById, updateLastActive } from '../models/userModel.js';

export const addUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = crypto.randomUUID();
        const existingUser = await getUserById(id);
        if (existingUser) {
            res.status(400).json({ error: 'User already exists' });
            return;
        }
        await createUser(id);
        res.status(201).json({ id });
    } catch (error) {
        next(error);
    }
};

export const fetchUserById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'User ID is required' });
            return;
        }
        const user = await getUserById(id);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json(user);
    } catch (error) {
        next(error);
    }
};

export const updateUserLastActive = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'User ID is required' });
            return;
        }
        const user = await getUserById(id);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        await updateLastActive(id);
        res.json({ message: 'User last active time updated' });
    } catch (error) {
        next(error);
    }
}; 