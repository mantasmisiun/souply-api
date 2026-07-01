import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { fetchPendingAliasCards, recordAliasVoteById, type AliasVote } from '../models/storeProductAliasModel.js';

/**
 * GET /api/users/:userId/alias-cards?chainId=&limit=
 *
 * H3 pending-card surfacing: receipt-name aliases still gathering consensus
 * (status='pending') for the user to vote on — "is this receipt text the same product
 * as this SP?". Excludes aliases the user already voted on (no-repeat). `chainId`
 * optional (default: across all chains). These cards are what drive aliases to the
 * K-distinct-user 'canonical' threshold faster than waiting for independent duplicates.
 */
export const getAliasCards = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
        if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
        const chainRaw = typeof req.query.chainId === 'string' && req.query.chainId.length > 0 ? Number(req.query.chainId) : null;
        const chainId = chainRaw !== null && Number.isFinite(chainRaw) ? chainRaw : null;
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 10;
        const cards = await fetchPendingAliasCards(userId, chainId, limit);
        res.json({ cards });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/users/:userId/alias-votes  { aliasId, vote }
 *
 * Record a vote on a pending-alias card. Runs the same balanced-veto state machine as a
 * receipt-line vote, by alias id. Returns the alias's new status (pending/canonical/
 * similarity/rejected) so the client can show progress.
 */
export const submitAliasVote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
        const aliasId = Number(req.body?.aliasId);
        const vote = req.body?.vote as AliasVote;
        if (!userId || !Number.isFinite(aliasId)) { res.status(400).json({ error: 'userId and aliasId are required' }); return; }
        if (vote !== 'identical' && vote !== 'similar' && vote !== 'different') {
            res.status(400).json({ error: 'vote must be identical, similar, or different' });
            return;
        }
        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            const status = await recordAliasVoteById(aliasId, userId, vote, conn);
            await conn.commit();
            res.json({ ok: true, status });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (error) {
        next(error);
    }
};
