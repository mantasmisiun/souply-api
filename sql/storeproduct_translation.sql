-- Souply 2.0 — search vocabulary: SP translations + synonyms.
-- Separate from StoreProductReceiptAlias ON PURPOSE (2026-07-16 decision):
-- the alias table's chain/vote/status machinery means "users confirmed this
-- OCR string"; machine translations are a different trust class. Search
-- treats BOTH as vocabulary arms (name match first, vocabulary second).
-- Data is INERT until the 2.0 search ships. Idempotent.

CREATE TABLE IF NOT EXISTS StoreProductTranslation (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    storeProductId INT NOT NULL,
    -- 'en' = English translation, 'lt' = Lithuanian synonym (e.g. batatai
    -- for saldžiosios bulvės). More languages later without schema change.
    lang CHAR(2) NOT NULL,
    -- Display form as produced by the translator.
    text VARCHAR(255) NOT NULL,
    -- Lowercased, diacritic-folded form the search LIKEs against.
    normalized VARCHAR(255) NOT NULL,
    source ENUM('machine','human') NOT NULL DEFAULT 'machine',
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_spt (storeProductId, lang, normalized),
    KEY idx_spt_search (lang, normalized),
    KEY idx_spt_sp (storeProductId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
