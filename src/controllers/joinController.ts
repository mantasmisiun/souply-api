import type { Request, Response, NextFunction } from 'express';
import { getInviteByCode, inviteIsLive, recordInviteClaim, getOrCreateInviteToken } from '../models/inviteModel.js';
import { getTripById, isTripMember } from '../models/tripModel.js';
import pool from '../config/db.js';
import {
    createHousehold, getHouseholdForUser, getHouseholdMembers, isHouseholdMember,
    joinHousehold, leaveHousehold,
} from '../models/householdModel.js';

/**
 * Souply 2.0 Phase 1c — households + the /join/:code preview→claim flow.
 * Token = capability (the documented requireUser-only pattern from list
 * sharing); preview NEVER mutates; claim is idempotent via the claim ledger.
 * Anon users CAN claim (decision 2026-07-16) — membership rides the
 * anon→account merge later.
 */

// ── Households ───────────────────────────────────────────────────────────────

export const createOwnHousehold = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.authUserId!;
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 255) || null : null;
        try {
            const created = await createHousehold(userId, name);
            res.status(201).json(created);
        } catch (e: any) {
            if (e?.code === 'ER_DUP_ENTRY') {
                // PRIMARY KEY(userId) — already in a household (schema-level invariant).
                res.status(409).json({ error: 'household-exists' });
                return;
            }
            throw e;
        }
    } catch (error) { next(error); }
};

export const getOwnHousehold = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.authUserId!;
        const household = await getHouseholdForUser(userId);
        if (!household) { res.status(404).json({ error: 'not found' }); return; }
        const members = await getHouseholdMembers(household.id);
        res.json({ ...household, members });
    } catch (error) { next(error); }
};

export const leaveOwnHousehold = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const left = await leaveHousehold(req.authUserId!);
        if (!left) { res.status(404).json({ error: 'not found' }); return; }
        res.status(204).send();
    } catch (error) { next(error); }
};

export const createHouseholdInvite = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.authUserId!;
        const household = await getHouseholdForUser(userId);
        if (!household) { res.status(404).json({ error: 'not found' }); return; }
        const token = await getOrCreateInviteToken('household', household.id, userId);
        res.json({ code: token.code });
    } catch (error) { next(error); }
};

// ── Trip invites ─────────────────────────────────────────────────────────────
// Route is guarded by requireTripMember — any member may mint the trip QR.

export const createTripInvite = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tripId = Number(req.params.id);
        const token = await getOrCreateInviteToken('trip', tripId, req.authUserId!);
        res.json({ code: token.code });
    } catch (error) { next(error); }
};

// ── /join/:code ──────────────────────────────────────────────────────────────

const loadInvite = async (code: string) => {
    if (!/^[a-z2-9]{12}$/.test(String(code ?? ''))) return null;
    const token = await getInviteByCode(String(code));
    if (!token || !inviteIsLive(token)) return null;
    return token;
};

export const previewJoin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = await loadInvite(String(req.params.code));
        if (!token) { res.status(404).json({ error: 'not found' }); return; }
        // Anonymous previews (souply.lt landing, pre-install) get the public
        // fields; membership fields only when a user is attached.
        const userId = req.authUserId ?? null;

        if (token.scope === 'trip') {
            const trip = await getTripById(token.targetId);
            if (!trip || trip.archivedAt != null) { res.status(404).json({ error: 'not found' }); return; }
            const [members]: any = await pool.query(
                'SELECT COUNT(*) AS n FROM TripMember WHERE tripId = ?', [trip.id]);
            res.json({
                scope: 'trip',
                name: trip.name,
                memberCount: Number(members[0].n),
                alreadyMember: userId ? await isTripMember(trip.id, userId) : false,
            });
            return;
        }

        const [households]: any = await pool.query('SELECT * FROM Household WHERE id = ?', [token.targetId]);
        if (!households.length) { res.status(404).json({ error: 'not found' }); return; }
        const members = await getHouseholdMembers(token.targetId);
        res.json({
            scope: 'household',
            name: households[0].name,
            memberCount: members.length,
            alreadyMember: userId ? await isHouseholdMember(token.targetId, userId) : false,
            // The claim will 409 if the user must leave their current household first.
            hasOwnHousehold: userId ? (await getHouseholdForUser(userId)) != null : false,
        });
    } catch (error) { next(error); }
};

export const claimJoin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = await loadInvite(String(req.params.code));
        if (!token) { res.status(404).json({ error: 'not found' }); return; }
        const userId = req.authUserId!;

        if (token.scope === 'trip') {
            const trip = await getTripById(token.targetId);
            if (!trip || trip.archivedAt != null) { res.status(404).json({ error: 'not found' }); return; }
            if (await isTripMember(trip.id, userId)) {
                res.json({ scope: 'trip', tripId: trip.id, alreadyMember: true });
                return;
            }
            await pool.query(
                "INSERT IGNORE INTO TripMember (tripId, userId, role) VALUES (?, ?, 'member')",
                [trip.id, userId]);
            await recordInviteClaim(token.id, userId);
            res.json({ scope: 'trip', tripId: trip.id, alreadyMember: false });
            return;
        }

        // household scope
        if (await isHouseholdMember(token.targetId, userId)) {
            res.json({ scope: 'household', householdId: token.targetId, alreadyMember: true });
            return;
        }
        const current = await getHouseholdForUser(userId);
        if (current) {
            // ONE household per user: the client prompts "leave current?" and
            // retries after DELETE /households/mine/membership.
            res.status(409).json({ error: 'household-exists', currentHouseholdId: current.id });
            return;
        }
        await joinHousehold(token.targetId, userId);
        await recordInviteClaim(token.id, userId);
        res.json({ scope: 'household', householdId: token.targetId, alreadyMember: false });
    } catch (error) { next(error); }
};
