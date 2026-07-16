import type { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { listTripsForUser } from '../services/tripListService.js';
import { isTripMember } from '../models/tripModel.js';

export const listTrips = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.json(await listTripsForUser(req.authUserId!));
    } catch (error) { next(error); }
};

const setArchived = async (req: Request, res: Response, next: NextFunction, archived: boolean) => {
    try {
        const tripId = Number(req.params.id);
        if (!Number.isFinite(tripId)) { res.status(400).json({ error: 'bad id' }); return; }
        // 404-over-403: membership probes must not reveal trip existence.
        if (!(await isTripMember(tripId, req.authUserId!))) { res.status(404).json({ error: 'not found' }); return; }
        await pool.query('UPDATE Trip SET archivedAt = ? WHERE id = ?', [archived ? new Date() : null, tripId]);
        res.json({ id: tripId, archived });
    } catch (error) { next(error); }
};

/** Manual archive ("nebeaktualu") — resume is unarchive (spec: tap = explicit resume). */
export const archiveTripById = (req: Request, res: Response, next: NextFunction) => setArchived(req, res, next, true);
export const unarchiveTripById = (req: Request, res: Response, next: NextFunction) => setArchived(req, res, next, false);
