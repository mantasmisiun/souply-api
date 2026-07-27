import type { Request, Response } from 'express';
import {
    type RecipeImportPreview, importRecipeFromHtml, importRecipeFromUrl,
} from '../services/recipes/importRecipe.js';
import { RecipeFetchError, RecipeParseError } from '../services/recipes/recipeScraper.js';

/**
 * POST /api/recipes/import — read a recipe off a public web page.
 *
 * PREVIEW ONLY. The response is a proposal: title, cover suggestion, and a
 * product list with amounts. The app creates the actual template through the
 * existing `POST /api/basket-templates` with `items[]` once the shopper has
 * confirmed it, so an import that reads the page wrong writes nothing.
 *
 * Two bodies are accepted:
 *   { url }        — the server fetches the page (the normal case)
 *   { url, html }  — the CLIENT fetched it, because a handful of large
 *                    publishers refuse datacentre IPs outright. The url is still
 *                    required: it is the attribution and the base for relative
 *                    image paths.
 */

/** A phone can hold a page this big; anything larger is not an article. */
const MAX_CLIENT_HTML = 3 * 1024 * 1024;

export const importRecipe = async (req: Request, res: Response): Promise<void> => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const html = typeof req.body?.html === 'string' ? req.body.html : null;
    if (!url) { res.status(400).json({ error: 'url required' }); return; }
    if (html != null && html.length > MAX_CLIENT_HTML) { res.status(413).json({ error: 'html too large' }); return; }

    try {
        // The caller is already authenticated (requireUser); passing them through
        // is what lets the matcher prefer products this shopper actually buys.
        const userId = req.authUserId ?? null;
        const preview: RecipeImportPreview = html
            ? await importRecipeFromHtml(html, url, req.locale, userId)
            : await importRecipeFromUrl(url, req.locale, userId);
        res.json(preview);
    } catch (e) {
        if (e instanceof RecipeFetchError) {
            // `fetchBlocked` tells the app to retry the fetch from the device.
            // Anything else is the page's or the user's problem, not ours.
            const blocked = e.code === 'http_error' || e.code === 'timeout' || e.code === 'network';
            res.status(e.code === 'bad_url' || e.code === 'blocked_host' ? 400 : 502)
                .json({ error: e.code, status: e.status ?? null, fetchBlocked: blocked && html == null });
            return;
        }
        if (e instanceof RecipeParseError) { res.status(422).json({ error: 'no_recipe' }); return; }
        console.error('[recipeImport] failed:', e);
        res.status(500).json({ error: 'import failed' });
    }
};
