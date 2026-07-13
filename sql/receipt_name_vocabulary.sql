-- Receipt-name VOCABULARY (Issue H): learn how each chain actually PRINTS a
-- StoreProduct on its receipts, so future receipts match the same garbled OCR
-- string by a confirmed alias instead of re-deriving it with fuzzy name math.
--
-- Captured when a user swipes 'identical' on a Card-B AND the matcher struggled
-- (matchConfidence < autoApply 0.85) — i.e. only the valuable hard cases, not
-- aliases the catalog name already matches. CHAIN-SCOPED: an IKI receipt's OCR
-- may only ever teach an IKI-chain SP (chainId always equals the linked SP's
-- chain). De-duplicated by (chainId, storeProductId, normalizedAlias).
--
-- Lifecycle (vote state machine, per shared/SWIPE_QUEUE_REDESIGN.md + memory
-- project_vocabulary_subsystem):
--   pending    — captured, gathering votes; shown as OCR-vs-SP cards.
--   canonical  — >= K (2) DISTINCT users voted 'identical' with no dissent, OR an
--                admin confirmed → used as an exact match target in matching.
--   similarity — got a 'similar' vote: a soft same-category (L2) link, NOT an exact
--                alias; feeds category-scoped re-matching, not name matching.
--   rejected   — got a 'different' vote (strong veto) OR an admin rejected →
--                blacklisted, never used and the (OCR, SP) combo never re-shown.
-- Counts below are denormalised from StoreProductReceiptAliasVote so the matcher
-- can read canonical aliases without a join.

CREATE TABLE IF NOT EXISTS StoreProductReceiptAlias (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
    chainId          INT NOT NULL,
    storeProductId   INT NOT NULL,
    normalizedAlias  VARCHAR(255) NOT NULL,
    rawSample        VARCHAR(255) NULL,
    occurrences      INT UNSIGNED NOT NULL DEFAULT 1,
    -- Denormalised tallies from StoreProductReceiptAliasVote (distinct users).
    identicalUsers   INT UNSIGNED NOT NULL DEFAULT 0,
    similarUsers     INT UNSIGNED NOT NULL DEFAULT 0,
    differentUsers   INT UNSIGNED NOT NULL DEFAULT 0,
    status           ENUM('pending','canonical','similarity','rejected') NOT NULL DEFAULT 'pending',
    -- Admin override (curation tab): forces canonical/rejected regardless of votes.
    adminVerdict     ENUM('confirmed','rejected') NULL,
    sampleReceiptId  INT NULL,
    firstSeenAt      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastSeenAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    -- One alias row per (chain, SP, normalized OCR string).
    UNIQUE KEY uq_alias (chainId, storeProductId, normalizedAlias),
    -- Matcher read path: canonical aliases for a chain, by normalized text.
    KEY idx_match (chainId, status, normalizedAlias),
    -- Admin curation: pending rows oldest-first per chain.
    KEY idx_curation (status, chainId, lastSeenAt),
    KEY idx_sp (storeProductId, status),

    CONSTRAINT fk_alias_sp FOREIGN KEY (storeProductId) REFERENCES StoreProduct(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-user vote on an (OCR, SP) alias pair. One row per (alias, user) — the latest
-- vote wins (upsert). Drives the distinct-user tallies above (the K=2 auto-promote)
-- and the no-repeat-combo rule (a user never re-sees an alias they've voted on).
CREATE TABLE IF NOT EXISTS StoreProductReceiptAliasVote (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    aliasId    INT UNSIGNED NOT NULL,
    userId     VARCHAR(64) NOT NULL,
    vote       ENUM('identical','similar','different') NOT NULL,
    receiptId  INT NULL,
    createdAt  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_alias_user (aliasId, userId),
    KEY idx_user (userId),

    CONSTRAINT fk_aliasvote_alias FOREIGN KEY (aliasId) REFERENCES StoreProductReceiptAlias(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
