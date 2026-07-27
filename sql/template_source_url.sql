-- A recipe remembers where it came from.
--
-- The importer already knows the page it read (`RecipeImportPreview.sourceUrl`),
-- but the field was dropped the moment the shopper confirmed, so the recipe
-- screen could only offer a dead "Open recipe" button. Keeping it is what makes
-- an imported recipe traceable back to its instructions — the app stores the
-- shopping list, never the method, so the link IS the method.
--
-- Also the honest provenance record: when a match looks wrong, the first
-- question is always "what did the page actually say".
--
-- Applied: dev <fill on run>   staging PENDING   prod PENDING
--
-- Additive and nullable: hand-made recipes simply have no source, and every
-- existing writer keeps working untouched.
ALTER TABLE BasketTemplate
    ADD COLUMN sourceUrl VARCHAR(512) DEFAULT NULL,
    -- Hostname without "www." — shown under the title ("lamaistas.lt") and
    -- cheap to group by, without re-parsing the URL on every render.
    ADD COLUMN sourceSite VARCHAR(120) DEFAULT NULL;
