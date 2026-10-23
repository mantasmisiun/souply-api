-- The CHAIN'S OWN category breadcrumb for a scraped listing, captured verbatim
-- (Rimi: URL slugs "vaisiai-darzoves-ir-geles/vaisiai-ir-uogos/uogos";
--  Barbora: category_name_full_path). Recorded as a SIGNAL for category
-- assignment / admin review — NEVER mapped directly onto Category (the legacy
-- direct-mapping is what produced 7.7k products stuck in non-leaf categories).
--
-- Apply: dev → staging → prod. Backward-compatible (NULL = not captured).

ALTER TABLE StoreProduct
    ADD COLUMN siteCategory VARCHAR(255) NULL AFTER imageUrl;
