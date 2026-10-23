-- Recipe items remember whether they are a PANTRY staple.
--
-- The recipe importer already knows: salt, pepper, sugar, oil, spices and baking
-- agents are things a household almost certainly owns, and it groups them apart
-- from the real shopping. Until now that knowledge lived only in the import
-- PREVIEW and was thrown away on save, so the recipe screen could not group them
-- and — the part that matters — the shopper was asked to strike them at RECIPE
-- creation, which is the wrong moment. A recipe is a lasting thing; whether you
-- happen to have salt this week is a BASKET decision.
--
-- Persisting the flag lets the grouping survive into the recipe, and moves the
-- keep-or-drop choice to where it belongs: turning the recipe into a basket.
--
-- Additive and defaulted, so every existing row and every existing writer keeps
-- working untouched.
ALTER TABLE BasketTemplateItem
    ADD COLUMN isPantry TINYINT(1) NOT NULL DEFAULT 0;
