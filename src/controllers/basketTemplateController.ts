import { Request, Response, NextFunction } from 'express';
import { ensureTripForBasket } from '../services/tripLinkService.js';
import pool from '../config/db.js';
import {
    createTemplate,
    getTemplateById,
    getTemplatesByUserId,
    renameTemplate,
    setTemplateAutoUpdate,
    setTemplateCover,
    touchTemplateEdited,
    deleteTemplate,
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
import { buildDefaultTemplate } from '../services/defaultTemplateService.js';
import { normalizeCoverColor, normalizeCoverImage } from '../util/coverIdentity.js';
import { shareUrlForSlug } from '../config/urls.js';

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


// ── Ownership ───────────────────────────────────────────────────────────
//
// Templates are owned by `userId`, which is the user's stable id — the device
// UUID for anonymous app users, the same id after they upgrade to a verified
// creator (User.id is never reassigned), and the verified id for web. So the
// caller proves ownership by presenting that id: the verified session (Bearer
// header / web cookie → req.verifiedUser) OR, for anonymous app clients, the
// device UUID in the `X-User-Id` header. Without this, every template
// endpoint is keyed only by a sequential integer id (IDOR).

function callerId(req: Request): string | null {
    // Identity from the SESSION (requireUser sets authUserId from a Bearer/cookie, or the
    // non-prod dev-header shim). The old raw `x-user-id` header read is REMOVED — it let an
    // unauthenticated caller impersonate any user in production (the live template IDOR).
    if (req.authUserId) return req.authUserId;
    if (req.verifiedUser?.id) return String(req.verifiedUser.id);
    return null;
}

/** Load the template by `:id` and assert the caller owns it. Sends the
 *  appropriate 400/404/403 and returns null when it can't be served. */
async function loadOwnedTemplate(req: Request, res: Response): Promise<any | null> {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'Invalid template ID' }); return null; }
    const tpl = await getTemplateById(id);
    if (!tpl) { res.status(404).json({ error: 'Template not found' }); return null; }
    const cid = callerId(req);
    if (!cid || String(tpl.userId) !== cid) { res.status(403).json({ error: 'forbidden' }); return null; }
    return tpl;
}

// ── Template CRUD ─────────────────────────────────────────────────────────

export const listTemplates = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.userId);
        // Only the owner may list their templates.
        if (callerId(req) !== userId) { res.status(403).json({ error: 'forbidden' }); return; }
        const templates = await getTemplatesByUserId(userId);
        res.json(templates);
    } catch (e) { next(e); }
};

export const fetchTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Owner-only: the editor reads its own template here; the public
        // preview goes through GET /t/:slug instead.
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        const items = await getTemplateItems(Number(req.params.id), req.locale);
        res.json({ ...template, items });
    } catch (e) { next(e); }
};

export const addTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId, name, autoUpdate, items, visibility, coverColor, coverImage } = req.body ?? {};
        if (!userId || typeof userId !== 'string') {
            res.status(400).json({ error: 'userId is required' });
            return;
        }
        const nameCheck = validateName(name);
        if (!nameCheck.ok) {
            res.status(400).json({ error: nameCheck.error });
            return;
        }
        // Visibility on create: 'private'/'unlisted' are open; 'public' needs a
        // verified user with a username (the publish wall) — same gate as PATCH.
        const reqVisibility = visibility === undefined ? 'private' : String(visibility);
        if (!['private', 'unlisted', 'public'].includes(reqVisibility)) {
            res.status(400).json({ error: 'invalid-visibility' });
            return;
        }
        if (reqVisibility === 'public') {
            const verified = req.verifiedUser ?? null;
            if (!verified) { res.status(401).json({ error: 'auth-required' }); return; }
            if (!verified.username) { res.status(412).json({ error: 'username-required' }); return; }
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
                {
                    autoUpdate: Boolean(autoUpdate),
                    coverColor: normalizeCoverColor(coverColor),
                    coverImage: normalizeCoverImage(coverImage),
                },
                conn as any,
            );
            if (initialItems.length > 0) {
                await insertTemplateItemsBatch(templateId, initialItems, conn as any);
            }
            // Apply non-default visibility within the same transaction. 'public'
            // already passed the publish-wall gate above; stamp the handle too.
            if (reqVisibility !== 'private') {
                if (reqVisibility === 'public') {
                    await (conn as any).query(
                        `UPDATE BasketTemplate SET visibility = ?, creatorHandle = ? WHERE id = ?`,
                        [reqVisibility, req.verifiedUser!.username, templateId],
                    );
                } else {
                    await (conn as any).query(
                        `UPDATE BasketTemplate SET visibility = ? WHERE id = ?`,
                        [reqVisibility, templateId],
                    );
                }
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
        const { name, autoUpdate, coverColor, coverImage } = req.body ?? {};
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
        // Only the basket's owner may turn it into a template.
        const cid = callerId(req);
        if (!cid || String(basket.userId) !== cid) { res.status(403).json({ error: 'forbidden' }); return; }

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
                {
                    autoUpdate: Boolean(autoUpdate),
                    coverColor: normalizeCoverColor(coverColor),
                    coverImage: normalizeCoverImage(coverImage),
                },
                conn as any,
            );
            if (items.length > 0) {
                await insertTemplateItemsBatch(templateId, items, conn as any);
            }
            // Link the source basket back to the new template so it becomes
            // that template's first instance — the basket then inherits the
            // template's cover (emoji/colour/name) and the template-derived UI
            // via Basket.sourceTemplateId (no separate copy of those fields).
            // Reset userEditedAfterCreation: this basket *defined* the template,
            // so at creation it matches it exactly (no drift). Otherwise any
            // edits made earlier (while it was a plain draft) would make the
            // now-template-linked basket wrongly read as "Redaguota".
            await conn.query(
                'UPDATE Basket SET sourceTemplateId = ?, userEditedAfterCreation = 0 WHERE id = ?',
                [templateId, basketId],
            );
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
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        const id = Number(req.params.id);
        const { name, autoUpdate, visibility, coverColor, coverImage } = req.body ?? {};
        // The auto default template is read-only content-wise — only its
        // learning switch (autoUpdate) may change. Block name/cover edits.
        if (template.isDefault === 1 && (name !== undefined || coverColor !== undefined || coverImage !== undefined)) {
            res.status(403).json({ error: 'default-template-readonly' });
            return;
        }
        if (name !== undefined) {
            const check = validateName(name);
            if (!check.ok) { res.status(400).json({ error: check.error }); return; }
            await renameTemplate(id, check.name);
        }
        if (autoUpdate !== undefined) {
            await setTemplateAutoUpdate(id, Boolean(autoUpdate));
        }
        if (coverColor !== undefined || coverImage !== undefined) {
            await setTemplateCover(id, {
                ...(coverColor !== undefined ? { coverColor: normalizeCoverColor(coverColor) } : {}),
                ...(coverImage !== undefined ? { coverImage: normalizeCoverImage(coverImage) } : {}),
            });
        }
        // Name / cover are content edits → stamp "Redaguota". autoUpdate and
        // visibility are settings, not content, so they don't count.
        if (name !== undefined || coverColor !== undefined || coverImage !== undefined) {
            await touchTemplateEdited(id);
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
            } else if (target === 'private') {
                // Flip to private keeps the slug (so old links resolve to a
                // "made private" page instead of 404) but clears the cached
                // snapshot — a later re-publish recomputes against fresh prices.
                await pool.query(
                    `UPDATE BasketTemplate
                        SET visibility = 'private',
                            snapshotCheapestChainId  = NULL,
                            snapshotTotalEur         = NULL,
                            snapshotRunnerUpEur      = NULL,
                            snapshotMostExpensiveEur = NULL,
                            snapshotCalculatedAt     = NULL
                      WHERE id = ?`,
                    [id],
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
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        await deleteTemplate(Number(req.params.id));
        res.status(204).send();
    } catch (e) { next(e); }
};

/**
 * POST /api/basket-templates/default/build
 *
 * User-initiated build of the auto "default" template from the caller's
 * receipt purchases (the "Build it" button). Returns the built template with
 * items, or 409 when generation can't run (not enough receipts, no purchased
 * products, etc.).
 */
export const buildDefault = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const cid = callerId(req);
        if (!cid) { res.status(401).json({ error: 'auth-required' }); return; }
        const result = await buildDefaultTemplate(cid);
        if (result.action === 'skipped') {
            res.status(409).json({ error: 'build-skipped', reason: result.reason });
            return;
        }
        const template = await getTemplateById(result.templateId);
        const items = await getTemplateItems(result.templateId, req.locale);
        res.status(201).json({ ...template, items });
    } catch (e) { next(e); }
};

/**
 * POST /api/basket-templates/:id/duplicate
 *
 * Copy a template the caller owns into a NEW, normal (editable, isDefault=0)
 * template — used to turn the read-only default template into something
 * editable, and to duplicate any manual template. Items + cover carry over.
 */
export const duplicateTemplate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const source = await loadOwnedTemplate(req, res);
        if (!source) return;
        const srcItems = await getTemplateItems(Number(req.params.id));
        const newName = `${source.name} (kopija)`.slice(0, NAME_MAX);
        const items: TemplateItemInput[] = srcItems.map((it: any, i: number) => ({
            productId: Number(it.productId),
            quantity: Number(it.quantity) || 1,
            unit: it.unit ?? null,
            sortOrder: i,
        }));
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const templateId = await createTemplate(
                source.userId,
                newName,
                {
                    autoUpdate: false,
                    coverColor: normalizeCoverColor(source.coverColor),
                    coverImage: normalizeCoverImage(source.coverImage),
                },
                conn as any,
            );
            if (items.length > 0) {
                await insertTemplateItemsBatch(templateId, items, conn as any);
            }
            await conn.commit();
            res.status(201).json({ id: templateId, userId: source.userId, name: newName, itemCount: items.length });
        } catch (txErr) {
            try { await conn.rollback(); } catch {}
            throw txErr;
        } finally {
            conn.release();
        }
    } catch (e) { next(e); }
};

// ── Template item CRUD ────────────────────────────────────────────────────

export const fetchTemplateItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        const items = await getTemplateItems(Number(req.params.id), req.locale);
        res.json(items);
    } catch (e) { next(e); }
};

export const addItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        if (template.isDefault === 1) { res.status(403).json({ error: 'default-template-readonly' }); return; }
        const templateId = Number(req.params.id);
        const { productId, quantity, unit, sortOrder } = req.body ?? {};
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
        // recomputes against the current set. Items changed → "Redaguota".
        invalidateSnapshot(templateId).catch(() => {});
        await touchTemplateEdited(templateId);
        res.status(201).json({ id: itemId, templateId, productId: Number(productId), quantity: Number(quantity) });
    } catch (e) { next(e); }
};

export const patchItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        if (template.isDefault === 1) { res.status(403).json({ error: 'default-template-readonly' }); return; }
        const itemId = Number(req.params.itemId);
        const templateId = Number(req.params.id);
        const { quantity, sortOrder } = req.body ?? {};
        if (!Number.isFinite(itemId)) {
            res.status(400).json({ error: 'Invalid item ID' });
            return;
        }
        // Item must belong to this (owned) template — block editing a foreign
        // item id under a template you happen to own.
        const owned = await getTemplateItemById(itemId);
        if (!owned || Number(owned.templateId) !== templateId) {
            res.status(404).json({ error: 'Template item not found' });
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
        if (Number.isFinite(templateId)) {
            invalidateSnapshot(templateId).catch(() => {});
            await touchTemplateEdited(templateId);
        }
        res.status(204).send();
    } catch (e) { next(e); }
};

export const removeItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        if (template.isDefault === 1) { res.status(403).json({ error: 'default-template-readonly' }); return; }
        const itemId = Number(req.params.itemId);
        if (!Number.isFinite(itemId)) {
            res.status(400).json({ error: 'Invalid item ID' });
            return;
        }
        const existing = await getTemplateItemById(itemId);
        if (!existing || Number(existing.templateId) !== Number(req.params.id)) {
            res.status(404).json({ error: 'Template item not found' });
            return;
        }
        await deleteTemplateItem(itemId);
        const templateId = Number(req.params.id);
        if (Number.isFinite(templateId)) {
            invalidateSnapshot(templateId).catch(() => {});
            await touchTemplateEdited(templateId);
        }
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
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        const id = Number(req.params.id);
        const items = await getTemplateItems(id);
        if (items.length === 0) {
            res.status(400).json({ error: 'Template has no items to share' });
            return;
        }
        const result = await shareTemplate(id);
        res.json({
            ...result,
            url: shareUrlForSlug(result.slug),
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
        const template = await loadOwnedTemplate(req, res);
        if (!template) return;
        const id = Number(req.params.id);
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
        // Identify the viewer for the visit anti-inflation rules: the app sends
        // its user id via x-user-id; anonymous web visitors fall back to IP.
        const viewerUserId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'] : null;
        const resolved = await resolveSlug(slug, { userId: viewerUserId, ip: req.ip ?? null });
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
        // Consumers may instantiate shared (unlisted/public) templates; a
        // PRIVATE template can only be instantiated by its owner. Stops a
        // stranger from copying a private template's items by guessing its id.
        if (template.visibility === 'private') {
            const cid = callerId(req);
            if (!cid || String(template.userId) !== cid) { res.status(403).json({ error: 'forbidden' }); return; }
        }

        // Read the caller's non-completed baskets spawned from this template.
        // When force=true (user chose "Sukurti naują" on the resume prompt)
        // we don't change WHICH rows we read — instead the force-fresh handling
        // below zeroes their flags so decideInstantiation() returns createFresh
        // and marks them for deletion.
        const [rows]: any = await pool.query(
            `SELECT id, status, hasBeenCalculated, userEditedAfterCreation
               FROM Basket
              WHERE userId = ? AND sourceTemplateId = ? AND status <> 'completed'`,
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
        // `force` = the user explicitly chose "Sukurti naują" in the resume
        // prompt → always create a fresh basket, but KEEP resumable siblings
        // intact. Previously-created baskets (and the shopping lists made from
        // them) derive their template cosmetics from a live JOIN on
        // `sourceTemplateId`, so deleting the old basket is what stripped its
        // theming. Force now only cleans genuinely-abandoned empty drafts.
        const base = decideInstantiation(existing);
        const decision = force
            ? { kind: 'createFresh' as const, deleteAbandonedIds: base.deleteAbandonedIds }
            : base;

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
            await ensureTripForBasket(newBasketId, userId, conn as any);
            const items = await getTemplateItems(templateId);
            if (items.length > 0) {
                const values = items.map((it: any) => [
                    newBasketId,
                    Number(it.productId),
                    Number(it.quantity),
                    'sku',
                    // Carry the creator's intended pack size so this basket's
                    // own recalculation prefers the matching variant.
                    it.snapAmount != null ? Number(it.snapAmount) : null,
                    it.snapUnit ?? null,
                ]);
                await (conn as any).query(
                    `INSERT INTO BasketItem (basketId, productId, quantity, matchMode, anchorAmount, anchorUnit) VALUES ?`,
                    [values],
                );
            }
            // Note: "Panaudojimai" (useCount) is NOT bumped here — it counts
            // shopping lists generated from the template, so it's incremented
            // on the first shopping-list creation (see shoppingListController),
            // not merely on instantiating a basket.
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
