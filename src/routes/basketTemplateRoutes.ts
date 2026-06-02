import { Router } from 'express';
import {
    listTemplates,
    fetchTemplate,
    addTemplate,
    addTemplateFromBasket,
    patchTemplate,
    removeTemplate,
    fetchTemplateItems,
    addItem,
    patchItem,
    removeItem,
    instantiateTemplate,
    ackAutoUpdate,
    generateShareLink,
    revokeShareLink,
    fetchSharedTemplate,
    buildDefault,
    duplicateTemplate,
} from '../controllers/basketTemplateController.js';
import { attachVerifiedUser } from '../middleware/requireVerifiedUser.js';

const router = Router();

// Build the auto "default" template from the caller's receipts ("Build it").
// Registered before the `:id` routes so "default" isn't swallowed as an id.
router.post('/basket-templates/default/build', attachVerifiedUser, buildDefault);

/**
 * @swagger
 * /api/basket-templates/user/{userId}:
 *   get:
 *     summary: List all of a user's basket templates (private + unlisted + public, newest first)
 *     tags: [BasketTemplate]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: List of templates with item counts joined in }
 */
router.get('/basket-templates/user/:userId', attachVerifiedUser, listTemplates);

/**
 * @swagger
 * /api/basket-templates:
 *   post:
 *     summary: Create a new basket template
 *     tags: [BasketTemplate]
 *     description: |
 *       Body must include `userId` and `name`. `name` is required at
 *       creation — server rejects empty / whitespace-only names. Optional
 *       `items[]` lets a single request seed the template with products,
 *       used by the "save current basket as template" flow.
 */
router.post('/basket-templates', attachVerifiedUser, addTemplate);

/**
 * @swagger
 * /api/basket-templates/from-basket/{basketId}:
 *   post:
 *     summary: Clone an existing basket's items into a new template
 *     tags: [BasketTemplate]
 *     description: |
 *       Source basket stays untouched. Body must include a `name`.
 */
router.post('/basket-templates/from-basket/:basketId', attachVerifiedUser, addTemplateFromBasket);

/**
 * @swagger
 * /api/basket-templates/{id}:
 *   get:
 *     summary: Get a single template with its items inlined
 *     tags: [BasketTemplate]
 */
router.get('/basket-templates/:id', attachVerifiedUser, fetchTemplate);

/**
 * @swagger
 * /api/basket-templates/{id}:
 *   patch:
 *     summary: Update a template's metadata (name and/or autoUpdate)
 *     tags: [BasketTemplate]
 */
router.patch('/basket-templates/:id', attachVerifiedUser, patchTemplate);

/**
 * @swagger
 * /api/basket-templates/{id}:
 *   delete:
 *     summary: Delete a template + cascade its items
 *     tags: [BasketTemplate]
 */
router.delete('/basket-templates/:id', attachVerifiedUser, removeTemplate);

/**
 * @swagger
 * /api/basket-templates/{id}/items:
 *   get:
 *     summary: List items in a template
 *     tags: [BasketTemplate]
 */
router.get('/basket-templates/:id/items', attachVerifiedUser, fetchTemplateItems);

/**
 * @swagger
 * /api/basket-templates/{id}/items:
 *   post:
 *     summary: Add an item to a template
 *     tags: [BasketTemplate]
 */
router.post('/basket-templates/:id/items', attachVerifiedUser, addItem);

/**
 * @swagger
 * /api/basket-templates/{id}/items/{itemId}:
 *   patch:
 *     summary: Update an item's quantity and/or sort order
 *     tags: [BasketTemplate]
 */
router.patch('/basket-templates/:id/items/:itemId', attachVerifiedUser, patchItem);

/**
 * @swagger
 * /api/basket-templates/{id}/items/{itemId}:
 *   delete:
 *     summary: Remove a template item
 *     tags: [BasketTemplate]
 */
router.delete('/basket-templates/:id/items/:itemId', attachVerifiedUser, removeItem);

/**
 * @swagger
 * /api/basket-templates/{id}/instantiate:
 *   post:
 *     summary: Spawn a basket from a template (handles abandonment + resume)
 *     tags: [BasketTemplate]
 *     description: |
 *       Returns either { action: 'resume', basketId } when a non-completed
 *       instance from this template is still around, or
 *       { action: 'created', basketId, itemCount } when a fresh basket
 *       was created and the template's items were copied into it.
 *       Abandoned siblings are silently deleted in the same transaction.
 */
router.post('/basket-templates/:id/instantiate', attachVerifiedUser, instantiateTemplate);

/**
 * @swagger
 * /api/basket-templates/{id}/duplicate:
 *   post:
 *     summary: Copy a template into a new editable (isDefault=0) template
 *     tags: [BasketTemplate]
 */
router.post('/basket-templates/:id/duplicate', attachVerifiedUser, duplicateTemplate);

/**
 * @swagger
 * /api/basket-templates/{id}/ack-auto-update:
 *   post:
 *     summary: Acknowledge the auto-update nudge (clears lastAutoUpdateDelta)
 *     tags: [BasketTemplate]
 */
router.post('/basket-templates/:id/ack-auto-update', ackAutoUpdate);

/**
 * @swagger
 * /api/basket-templates/{id}/share:
 *   post:
 *     summary: Allocate slug + snapshot, return shareable URL
 *     tags: [BasketTemplate]
 *   delete:
 *     summary: Revoke share link, downgrade visibility to 'private'
 *     tags: [BasketTemplate]
 */
router.post('/basket-templates/:id/share', attachVerifiedUser, generateShareLink);
router.delete('/basket-templates/:id/share', attachVerifiedUser, revokeShareLink);

/**
 * @swagger
 * /api/t/{slug}:
 *   get:
 *     summary: Resolve a share slug to template + items + snapshot
 *     tags: [BasketTemplate]
 */
router.get('/t/:slug', fetchSharedTemplate);

export default router;
