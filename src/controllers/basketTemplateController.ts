import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    createTemplate,
    getTemplateById,
    getTemplatesByUserId,
    renameTemplate,
    setTemplateAutoUpdate,
    deleteTemplate,
    incrementTemplateUseCount,
    getTemplateItems,
    insertTemplateItemsBatch,
    addTemplateItem,
    updateTemplateItemQuantity,
    updateTemplateItemSortOrder,
    deleteTemplateItem,
    getTemplateItemById,
    type TemplateItemInput,
} from '../models/basketTemplateModel.js';
import { createBasket, getBasketById } from '../models/basketModel.js';
import { decideInstantiation, type BasketSnapshot } from '../services/basketTemplateService.js';
import { shareTemplate, invalidateSnapshot, resolveSlug } from '../services/templateShareService.js';

// Soft length cap matches the BasketTemplate.name VARCHAR(100). UI prompts
// the user before they overflow, but we hard-trim on the server too.
const NAME_MAX = 100;

function validateName(rawName: unknown): { ok: true; name: string } | { ok: false; error: string } {
    if (typeof rawName !== 'string') return { ok: false, error: 'Name is required' };
    const trimmed = rawName.trim();
    if (trimmed.length === 0) return { ok: false, error: 'Name cannot be empty' };
    if (trimmed.length > NAME_MAX) return { ok: false, error: `Name must be ≤ ${NAME_MAX} chars` };
    return { ok: true, name: trimmed };
}

// ── Template CRUD ─────────────────────────────────────────────────────────

export const listTemplates = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.userId);
        const templates = await getTemplatesByUserId(userId);
        res.json(templates);
    } catch (e) { next(e); }
};

export const fetchTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        const template = await getTemplateById(id);
        if (!template) {
            res.status(404).json({ error: 'Template not found' });
            return;
        }
        const items = await getTemplateItems(id);
        res.json({ ...template, items });
    } catch (e) { next(e); }
};

export const addTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId, name, autoUpdate, items } = req.body ?? {};
        if (!userId || typeof userId !== 'string') {
            res.status(400).json({ error: 'userId is required' });
            return;
        }
        const nameCheck = validateName(name);
        if (!nameCheck.ok) {
            res.status(400).json({ error: nameCheck.error });
            return;
        }

        // Optional initial items (the "save current basket as template" flow
        // sends items in the same request). All-or-nothing transaction.
        const initialItems: TemplateItemInput[] = Array.isArray(items)
            ? items.filter((it: any) =>
                Number.isFinite(Number(it?.productId)) &&
                Number.isFinite(Number(it?.quantity)) && Number(it.quantity) > 0
            ).map((it: any, i: number) => ({
                productId: Number(it.productId),
                quantity: Number(it.quantity),
                unit: it.unit ?? null,
                sortOrder: Number.isFinite(Number(it.sortOrder)) ? Number(it.sortOrder) : i,
            }))
            : [];

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const templateId = await createTemplate(
                userId,
                nameCheck.name,
                { autoUpdate: Boolean(autoUpdate) },
                conn as any,
            );
            if (initialItems.length > 0) {
                await insertTemplateItemsBatch(templateId, initialItems, conn as any);
            }
            await conn.commit();
            res.status(201).json({ id: templateId, userId, name: nameCheck.name, itemCount: initialItems.length });
        } catch (txErr) {
            try { await conn.rollback(); } catch {}
            throw txErr;
        } finally {
            conn.release();
        }
    } catch (e) { next(e); }
};

/**
 * Convenience endpoint: take an existing basket and clone its items into a
 * brand-new template under the basket owner's account. The basket is left
 * untouched. Matches the "Save current basket as template" UX path in
 * Documentation/roadmap/sablonai.md Part 1.1.
 */
export const addTemplateFromBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const basketId = Number(req.params.basketId);
        const { name, autoUpdate } = req.body ?? {};
        if (!Number.isFinite(basketId)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const nameCheck = validateName(name);
        if (!nameCheck.ok) {
            res.status(400).json({ error: nameCheck.error });
            return;
        }
        const basket = await getBasketById(basketId);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }

        // Read items directly off BasketItem rather than going through the
        // enriched fetch — the template only stores productId + quantity.
        const [rows]: any = await pool.query(
            `SELECT productId, quantity FROM BasketItem WHERE basketId = ?`,
            [basketId],
        );
        const items: TemplateItemInput[] = rows.map((r: any, i: number) => ({
            productId: Number(r.productId),
            quantity: Number(r.quantity),
            sortOrder: i,
        }));

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const templateId = await createTemplate(
                basket.userId,
                nameCheck.name,
                { autoUpdate: Boolean(autoUpdate) },
                conn as any,
            );
            if (items.length > 0) {
                await insertTemplateItemsBatch(templateId, items, conn as any);
            }
            await conn.commit();
            res.status(201).json({ id: templateId, userId: basket.userId, name: nameCheck.name, itemCount: items.length });
        } catch (txErr) {
            try { await conn.rollback(); } catch {}
            throw txErr;
        } finally {
            conn.release();
        }
    } catch (e) { next(e); }
};

export const patchTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        const template = await getTemplateById(id);
        if (!template) {
            res.status(404).json({ error: 'Template not found' });
            return;
        }
        const { name, autoUpdate, visibility } = req.body ?? {};
        if (name !== undefined) {
            const check = validateName(name);
            if (!check.ok) { res.status(400).json({ error: check.error }); return; }
            await renameTemplate(id, check.name);
        }
        if (autoUpdate !== undefined) {
            await setTemplateAutoUpdate(id, Boolean(autoUpdate));
        }
        // Visibility transition. private/unlisted are open; public requires
        // a verified user with a claimed username — the publish wall.
        // Without the Bearer header (anonymous client) any attempt to
        // upgrade to 'public' is rejected with 'auth-required' so the
        // client knows to trigger the OAuth flow.
        if (visibility !== undefined) {
            const target = String(visibility);
            if (!['private', 'unlisted', 'public'].includes(target)) {
                res.status(400).json({ error: 'invalid-visibility' });
                return;
            }
            if (target === 'public') {
                const verified = req.verifiedUser ?? null;
                if (!verified) {
                    res.status(401).json({ error: 'auth-required' });
                    return;
                }
                if (!verified.username) {
                    res.status(412).json({ error: 'username-required' });
                    return;
                }
                await pool.query(
                    `UPDATE BasketTemplate SET visibility = ?, creatorHandle = ? WHERE id = ?`,
                    [target, verified.username, id],
                );
            } else {
                await pool.query(
                    `UPDATE BasketTemplate SET visibility = ? WHERE id = ?`,
                    [target, id],
                );
            }
        }
        const updated = await getTemplateById(id);
        res.json(updated);
    } catch (e) { next(e); }
};

export const removeTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        await deleteTemplate(id);
        res.status(204).send();
    } catch (e) { next(e); }
};

// ── Template item CRUD ────────────────────────────────────────────────────

export const fetchTemplateItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        const items = await getTemplateItems(id);
        res.json(items);
    } catch (e) { next(e); }
};

export const addItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const templateId = Number(req.params.id);
        const { productId, quantity, unit, sortOrder } = req.body ?? {};
        if (!Number.isFinite(templateId)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        if (!Number.isFinite(Number(productId)) || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
            res.status(400).json({ error: 'productId and quantity > 0 are required' });
            return;
        }
        const itemId = await addTemplateItem(templateId, {
            productId: Number(productId),
            quantity: Number(quantity),
            unit: unit ?? null,
            sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
        });
        // Snapshot now reflects stale items — clear so the next share
        // recomputes against the current set.
        invalidateSnapshot(templateId).catch(() => {});
        res.status(201).json({ id: itemId, templateId, productId: Number(productId), quantity: Number(quantity) });
    } catch (e) { next(e); }
};

export const patchItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const itemId = Number(req.params.itemId);
        const templateId = Number(req.params.id);
        const { quantity, sortOrder } = req.body ?? {};
        if (!Number.isFinite(itemId)) {
            res.status(400).json({ error: 'Invalid item ID' });
            return;
        }
        if (quantity !== undefined) {
            const q = Number(quantity);
            if (!Number.isFinite(q) || q <= 0) {
                res.status(400).json({ error: 'quantity must be > 0' });
                return;
            }
            await updateTemplateItemQuantity(itemId, q);
        }
        if (sortOrder !== undefined) {
            const s = Number(sortOrder);
            if (!Number.isFinite(s)) {
                res.status(400).json({ error: 'sortOrder must be a number' });
                return;
            }
            await updateTemplateItemSortOrder(itemId, s);
        }
        if (Number.isFinite(templateId)) invalidateSnapshot(templateId).catch(() => {});
        res.status(204).send();
    } catch (e) { next(e); }
};

export const removeItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const itemId = Number(req.params.itemId);
        if (!Number.isFinite(itemId)) {
            res.status(400).json({ error: 'Invalid item ID' });
            return;
        }
        const existing = await getTemplateItemById(itemId);
        if (!existing) {
            res.status(404).json({ error: 'Template item not found' });
            return;
        }
        await deleteTemplateItem(itemId);
        const templateId = Number(req.params.id);
        if (Number.isFinite(templateId)) invalidateSnapshot(templateId).catch(() => {});
        res.status(204).send();
    } catch (e) { next(e); }
};

// ── Sharing ───────────────────────────────────────────────────────────────

/**
 * POST /api/basket-templates/:id/share
 *
 * Allocates a slug (if missing), upgrades 'private' → 'unlisted', runs
 * the comparison engine on the template's items, persists the resulting
 * snapshot, and returns slug + URL + snapshot. Returns 400 if the
 * template has no items (nothing to price).
 */
export const generateShareLink = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        const template = await getTemplateById(id);
        if (!template) {
            res.status(404).json({ error: 'Template not found' });
            return;
        }
        const items = await getTemplateItems(id);
        if (items.length === 0) {
            res.status(400).json({ error: 'Template has no items to share' });
            return;
        }
        const result = await shareTemplate(id);
        res.json({
            ...result,
            url: `https://souply.lt/t/${result.slug}`,
        });
    } catch (e) { next(e); }
};

/**
 * DELETE /api/basket-templates/:id/share
 *
 * Revokes a share link by clearing both `shareSlug` and the snapshot
 * fields, then downgrading visibility to 'private'. Per spec — old
 * URLs gracefully 404 after this.
 */
export const revokeShareLink = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        await pool.query(
            `UPDATE BasketTemplate
                SET shareSlug = NULL,
                    visibility = 'private',
                    snapshotCheapestChainId = NULL,
                    snapshotTotalEur = NULL,
                    snapshotRunnerUpEur = NULL,
                    snapshotMostExpensiveEur = NULL,
                    snapshotCalculatedAt = NULL
              WHERE id = ?`,
            [id],
        );
        res.status(204).send();
    } catch (e) { next(e); }
};

/**
 * GET /api/t/:slug
 *
 * Public slug resolution — used by both the souply.lt landing page and
 * the in-app template preview screen reached via Universal/App Links.
 */
export const fetchSharedTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { slug } = req.params;
        if (!slug || typeof slug !== 'string') {
            res.status(400).json({ error: 'Invalid slug' });
            return;
        }
        const resolved = await resolveSlug(slug);
        if (!resolved) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json(resolved);
    } catch (e) { next(e); }
};

/**
 * POST /api/basket-templates/:id/ack-auto-update
 *
 * Clears the `lastAutoUpdateDelta` counter so the client doesn't keep
 * showing the *"šablonas atnaujintas pagal naujus kvitus"* nudge once the
 * user has seen it. Called by the client when the nudge is dismissed
 * (or when the user taps "View" — both count as acknowledgement).
 */
export const ackAutoUpdate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        await pool.query(
            `UPDATE BasketTemplate SET lastAutoUpdateDelta = NULL WHERE id = ?`,
            [id],
        );
        res.status(204).send();
    } catch (e) { next(e); }
};

// ── Instantiation ─────────────────────────────────────────────────────────

/**
 * POST /api/basket-templates/:id/instantiate
 * Body: { userId: string }
 *
 * Flow (spec Part 3):
 *   1. Look up the template + read its items
 *   2. Read all of the caller's non-completed baskets spawned from this
 *      template
 *   3. Run pure decideInstantiation() to decide createFresh vs resumeExisting
 *      and which abandoned siblings to delete
 *   4. Apply the decision inside a transaction
 *   5. Bump the template's useCount
 *   6. Return either { action: 'resume', basketId } or { action: 'created', basketId }
 */
export const instantiateTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const templateId = Number(req.params.id);
        const { userId, force } = req.body ?? {};
        if (!Number.isFinite(templateId)) {
            res.status(400).json({ error: 'Invalid template ID' });
            return;
        }
        if (!userId || typeof userId !== 'string') {
            res.status(400).json({ error: 'userId is required' });
            return;
        }
        const template = await getTemplateById(templateId);
        if (!template) {
            res.status(404).json({ error: 'Template not found' });
            return;
        }

        // When the client passes force=true, the user has chosen "Sukurti
        // naują" on the resume prompt. Treat ALL non-completed baskets from
        // this template as abandoned (regardless of their flags), so the
        // decision function returns createFresh + deletes them.
        const whereTail = force
            ? `AND status <> 'completed'`
            : `AND status <> 'completed'`;
        const [rows]: any = await pool.query(
            `SELECT id, status, hasBeenCalculated, userEditedAfterCreation
               FROM Basket
              WHERE userId = ? AND sourceTemplateId = ? ${whereTail}`,
            [userId, templateId],
        );
        const existing: BasketSnapshot[] = rows.map((r: any) => ({
            id: Number(r.id),
            status: r.status,
            hasBeenCalculated: r.hasBeenCalculated,
            userEditedAfterCreation: r.userEditedAfterCreation,
        }));
        // Force-fresh: mark every existing instance as discardable by
        // zeroing both flags before the decision call. The pure logic
        // then routes through createFresh with all of them in the
        // deleteAbandonedIds list.
        const considered: BasketSnapshot[] = force
            ? existing.map(b => ({ ...b, hasBeenCalculated: 0, userEditedAfterCreation: 0 }))
            : existing;

        const decision = decideInstantiation(considered);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Step 1: clean up abandoned siblings either way.
            for (const id of decision.deleteAbandonedIds) {
                await (conn as any).query(`DELETE FROM Basket WHERE id = ?`, [id]);
            }

            if (decision.kind === 'resumeExisting') {
                await conn.commit();
                res.json({ action: 'resume', basketId: decision.basketId, templateId });
                return;
            }

            // Step 2: createFresh — new basket + copy items
            const newBasketId = await createBasket(userId, templateId, conn as any);
            const items = await getTemplateItems(templateId);
            if (items.length > 0) {
                const values = items.map((it: any) => [
                    newBasketId,
                    Number(it.productId),
                    Number(it.quantity),
                    'sku',
                ]);
                await (conn as any).query(
                    `INSERT INTO BasketItem (basketId, productId, quantity, matchMode) VALUES ?`,
                    [values],
                );
            }
            await incrementTemplateUseCount(templateId, conn as any);
            await conn.commit();

            res.status(201).json({ action: 'created', basketId: newBasketId, templateId, itemCount: items.length });
        } catch (txErr) {
            try { await conn.rollback(); } catch {}
            throw txErr;
        } finally {
            conn.release();
        }
    } catch (e) { next(e); }
};
