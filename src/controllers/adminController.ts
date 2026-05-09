import { Request, Response, NextFunction } from 'express';
import { deleteUser, type DeletionMode } from '../services/userDeletionService.js';

/**
 * DELETE /admin/users/:id
 *
 * Body: { mode: 'anonymize' | 'purge' }
 *
 * anonymize (default): severs identity links, preserves vote signal and prices.
 * purge: reverses vote aggregates, re-evaluates merge thresholds, removes votes.
 *
 * Requires X-Admin-Id header pointing to a user with isAdmin = 1.
 */
export const deleteUserAccount = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const targetUserId = String(req.params.id);
        const mode: DeletionMode = req.body?.mode === 'purge' ? 'purge' : 'anonymize';
        const result = await deleteUser(targetUserId, mode);
        if (!result.deleted) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json(result);
    } catch (error) {
        next(error);
    }
};
