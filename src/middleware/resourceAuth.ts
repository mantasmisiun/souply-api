import type { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { getBasketOwnerId, getBasketItemOwnerId } from '../models/basketModel.js';
import { getBasketTemplateOwnerId } from '../models/basketTemplateModel.js';
import { getShoppingListById, getListOwnerUserId } from '../models/shoppingListModel.js';
import { isShoppingListMember } from '../models/shoppingListMemberModel.js';
import { getListItemById } from '../models/shoppingListItemModel.js';

/**
 * Object-level authorization guards for the user-owned resources (baskets, templates,
 * shopping lists). Apply AFTER requireUser (which sets req.authUserId). Two models:
 *
 *   OWNER  — strict single-owner (Basket/BasketTemplate/BasketItem.userId). 403 unless
 *            the resource's userId equals the token subject.
 *   MEMBER — shopping lists are COLLABORATIVE (ShoppingListMember + share tokens), so
 *            most list routes accept any member; only destructive delete uses strict owner.
 *
 * All return 404 (not 403) when the resource is missing so ownership can't be probed by
 * response-code differences.
 */

const num = (v: unknown): number => Number(v);

/** OWNER guard from an owner-lookup fn; reads the id from req.params[paramName]. */
function ownerGuard(lookup: (id: number) => Promise<string | null>, paramName: string) {
    return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const id = num(req.params[paramName]);
        if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const owner = await lookup(id);
        if (owner === null) { res.status(404).json({ error: 'not found' }); return; }
        if (owner !== req.authUserId) { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };
}

export const requireBasketOwner = (paramName: 'id' | 'basketId' = 'id') => ownerGuard(getBasketOwnerId, paramName);

/** Souply 2.0 MEMBER guard for trips: any TripMember may act (owner-only ops
 *  pass role='owner'). Same 404-over-403 probing defense as the list guards.
 *  Every trip-scoped route MUST use this — the authz sweep rules apply. */
export const requireTripMember = (paramName: 'id' | 'tripId' = 'id', role?: 'owner') =>
    async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const tripId = num(req.params[paramName]);
        if (!Number.isFinite(tripId) || tripId <= 0) { res.status(400).json({ error: 'invalid trip id' }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const [rows]: any = await pool.query(
            'SELECT role FROM TripMember WHERE tripId = ? AND userId = ? LIMIT 1',
            [tripId, req.authUserId],
        );
        if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }
        if (role === 'owner' && rows[0].role !== 'owner') { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };
export const requireBasketItemOwner = (paramName = 'id') => ownerGuard(getBasketItemOwnerId, paramName);
export const requireBasketTemplateOwner = (paramName: 'id' | 'templateId' = 'id') => ownerGuard(getBasketTemplateOwnerId, paramName);

/** OWNER guard reading the id from req.body[field] (routes with no path id, e.g. POST). */
/** A basket is writable by its OWNER — or, for a household's SHARED basket
 *  (Basket.householdId set), by ANY member of that household (2.0 family
 *  basket: every member adds/edits items). */
const basketWritableBy = async (basketId: number, userId: string): Promise<'ok' | 'not-found' | 'forbidden'> => {
    const [rows]: any = await pool.query('SELECT userId, householdId FROM Basket WHERE id = ? LIMIT 1', [basketId]);
    const basket = rows[0];
    if (!basket) return 'not-found';
    if (basket.userId === userId) return 'ok';
    if (basket.householdId != null) {
        const [m]: any = await pool.query(
            'SELECT 1 FROM HouseholdMember WHERE householdId = ? AND userId = ? LIMIT 1',
            [basket.householdId, userId]);
        if (m.length > 0) return 'ok';
    }
    return 'forbidden';
};

export const requireBasketOwnerFromBody = (field = 'basketId') =>
    async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const id = num(req.body?.[field]);
        if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: `invalid ${field}` }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const verdict = await basketWritableBy(id, req.authUserId);
        if (verdict === 'not-found') { res.status(404).json({ error: 'not found' }); return; }
        if (verdict === 'forbidden') { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };

/** Item-level guard honouring the same shared-basket rule: resolve the
 *  item's basket, then apply basketWritableBy. */
export const requireBasketItemWritable = (paramName = 'id') =>
    async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const itemId = num(req.params[paramName]);
        if (!Number.isFinite(itemId) || itemId <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const [rows]: any = await pool.query('SELECT basketId FROM BasketItem WHERE id = ? LIMIT 1', [itemId]);
        if (!rows[0]) { res.status(404).json({ error: 'not found' }); return; }
        const verdict = await basketWritableBy(Number(rows[0].basketId), req.authUserId);
        if (verdict === 'not-found') { res.status(404).json({ error: 'not found' }); return; }
        if (verdict === 'forbidden') { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };

// ── Shopping lists: MEMBERSHIP model ──────────────────────────────────────────────────

/** MEMBER guard: the caller must be a ShoppingListMember of the list at req.params[paramName]. */
export const requireListMember = (paramName: 'id' | 'listId' = 'id') =>
    async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const listId = num(req.params[paramName]);
        if (!Number.isFinite(listId) || listId <= 0) { res.status(400).json({ error: 'invalid list id' }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const list = await getShoppingListById(listId);
        if (!list) { res.status(404).json({ error: 'not found' }); return; }
        if (!(await isShoppingListMember(listId, req.authUserId))) { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };

/** MEMBER guard reading listId from req.body[field] (POST /list-items has no path id). */
export const requireListMemberFromBody = (field = 'listId') =>
    async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const listId = num(req.body?.[field]);
        if (!Number.isFinite(listId) || listId <= 0) { res.status(400).json({ error: `invalid ${field}` }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const list = await getShoppingListById(listId);
        if (!list) { res.status(404).json({ error: 'not found' }); return; }
        if (!(await isShoppingListMember(listId, req.authUserId))) { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };

/** MEMBER guard for a list ITEM: resolve item → parent list, then membership. */
export const requireListItemMember = (paramName = 'id') =>
    async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const itemId = num(req.params[paramName]);
        if (!Number.isFinite(itemId) || itemId <= 0) { res.status(400).json({ error: 'invalid item id' }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const item = await getListItemById(itemId);
        if (!item) { res.status(404).json({ error: 'not found' }); return; }
        if (!(await isShoppingListMember(Number(item.listId), req.authUserId))) { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };

/** STRICT owner guard for destructive list ops (delete the whole list) — the CREATOR only,
 *  not mere members (a share-claimer must not delete the owner's list). */
export const requireListOwner = (paramName: 'id' = 'id') =>
    async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const listId = num(req.params[paramName]);
        if (!Number.isFinite(listId) || listId <= 0) { res.status(400).json({ error: 'invalid list id' }); return; }
        if (!req.authUserId) { res.status(401).json({ error: 'auth-required' }); return; }
        const owner = await getListOwnerUserId(listId);
        if (owner === null) { res.status(404).json({ error: 'not found' }); return; }
        if (owner !== req.authUserId) { res.status(403).json({ error: 'forbidden' }); return; }
        next();
    };
