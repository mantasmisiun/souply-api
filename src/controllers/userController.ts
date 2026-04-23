import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createUser, getUserById, updateLastActive } from '../models/userModel.js';

export const addUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Device-generated UUIDs take precedence: the app creates its own
        // UUID on first launch and persists it to AsyncStorage, so the
        // device is the source of truth for its identity. A POST without a
        // body still works — the server generates one and returns it — but
        // the mobile client always sends its own.
        const bodyId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
        const id = bodyId.length > 0 ? bodyId : crypto.randomUUID();

        // UUID-shape validation: rough guard against garbage payloads.
        if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
            res.status(400).json({ error: 'id must be a UUID' });
            return;
        }

        // Idempotent INSERT IGNORE inside createUser — safe to call repeatedly.
        // First-launch sync may retry after a flaky network, and the backend
        // returns 200 (not 201) when the row already existed so callers can
        // distinguish but don't have to.
        const existing = await getUserById(id);
        await createUser(id);
        res.status(existing ? 200 : 201).json({ id });
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