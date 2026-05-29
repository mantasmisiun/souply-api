-- Migration: Basket Templates — Pass A (private + unlisted templates, no OAuth).
--
-- Source spec: Documentation/roadmap/sablonai.md Part 1.4 + Part 3.
--
-- A `BasketTemplate` is a named, reusable list of products with quantities.
-- Tapping a template creates a fresh `Basket` instance (sourceTemplateId
-- back-reference) so the template itself never mutates from shopping.
--
-- Pass A scope: anonymous users can create templates, edit, share via
-- private link (slug allocated lazily by the share endpoint), instantiate.
-- Auto-generation runs server-side after the 3rd qualifying receipt.
--
-- Out of scope here, will arrive with Pass B (OAuth + public profiles):
--   * User.{username, displayName, bio, avatarUrl, authProvider, authSubject,
--          email, emailVerified}
--   * BasketTemplate.archivedAt (creator-dashboard.md)
--   * TemplateLandingPageView, TemplateInstantiation analytics tables
--
-- Forward-compatible columns included now so Pass B doesn't reshape the
-- BasketTemplate row a second time:
--   * `visibility` ENUM defaults to 'private'; 'public' is enforced at the
--     API layer until the publish wall (Pass B) gates it
--   * `creatorHandle` stays NULL until usernames exist
--   * `snapshot*` stay NULL until the share endpoint persists them

CREATE TABLE IF NOT EXISTS BasketTemplate (
    id                       INT AUTO_INCREMENT PRIMARY KEY,
    userId                   VARCHAR(36) NOT NULL,
    name                     VARCHAR(100) NOT NULL,
    -- isDefault marks the auto-generated template per user (one row per user
    -- where this is 1). Manual creates default to 0.
    isDefault                TINYINT(1) NOT NULL DEFAULT 0,
    -- autoUpdate = 1 means the spec's auto-update re-runs on every new
    -- receipt upload. Default 1 for the auto-generated default; manual
    -- creates default 0.
    autoUpdate               TINYINT(1) NOT NULL DEFAULT 0,
    -- Visibility tier. Replaces the implicit "has shareSlug or not" model.
    --   private  — owner-only, no slug needed
    --   unlisted — slug works (private-link sharing), not on profile
    --   public   — appears on souply.lt/@username (Pass B gates this via
    --              the publish wall; until Pass B ships, the API rejects
    --              writes that try to set 'public')
    visibility               ENUM('private','unlisted','public') NOT NULL DEFAULT 'private',
    shareSlug                VARCHAR(32) UNIQUE NULL,
    creatorHandle            VARCHAR(50) NULL,
    sourceTemplateId         INT NULL,
    useCount                 INT NOT NULL DEFAULT 0,
    collectiveSavingsEur     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    -- Calculation snapshot persisted on share. Pass A never writes these
    -- columns (no share endpoint yet) but they live in the row to keep
    -- Pass B a no-migration ship.
    snapshotCheapestChainId  INT NULL,
    snapshotTotalEur         DECIMAL(10,2) NULL,
    snapshotRunnerUpEur      DECIMAL(10,2) NULL,
    snapshotCalculatedAt     DATETIME NULL,
    createdAt                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_bt_user (userId),
    INDEX idx_bt_slug (shareSlug),
    -- Public profile listing query: WHERE userId=? AND visibility='public'
    INDEX idx_bt_visibility (visibility, userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS BasketTemplateItem (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    templateId INT NOT NULL,
    productId  INT NOT NULL,
    quantity   DECIMAL(10,3) NOT NULL DEFAULT 1,
    unit       VARCHAR(8),
    -- Ordering is owner-defined (drag-to-reorder in the editor).
    sortOrder  INT NOT NULL DEFAULT 0,
    CONSTRAINT fk_bti_template FOREIGN KEY (templateId)
        REFERENCES BasketTemplate(id) ON DELETE CASCADE,
    INDEX idx_bti_template_sort (templateId, sortOrder)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Basket additions: link back to the spawning template + the two abandonment
-- signals the instantiate endpoint and the daily cleanup cron query against.
--
-- MariaDB's `ADD COLUMN IF NOT EXISTS` silently no-ops on some versions,
-- so we use INFORMATION_SCHEMA + prepared statements to make each ADD
-- truly conditional. The result is idempotent — re-running this file is
-- a safe no-op rather than a duplicate-column error.

-- sourceTemplateId
SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Basket'
      AND COLUMN_NAME = 'sourceTemplateId'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE Basket ADD COLUMN sourceTemplateId INT NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- hasBeenCalculated
SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Basket'
      AND COLUMN_NAME = 'hasBeenCalculated'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE Basket ADD COLUMN hasBeenCalculated TINYINT(1) NOT NULL DEFAULT 0',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- userEditedAfterCreation
SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Basket'
      AND COLUMN_NAME = 'userEditedAfterCreation'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE Basket ADD COLUMN userEditedAfterCreation TINYINT(1) NOT NULL DEFAULT 0',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- idx_b_source_template
SET @idx_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Basket'
      AND INDEX_NAME = 'idx_b_source_template'
);
SET @sql := IF(@idx_exists = 0,
    'ALTER TABLE Basket ADD INDEX idx_b_source_template (sourceTemplateId)',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill: existing baskets that already passed through price calculation
-- get hasBeenCalculated = 1 so the abandonment query doesn't sweep them.
-- A basket is considered "has been calculated" once its status has ever
-- left 'draft' — compared / inProgress / completed all imply a calc ran.
UPDATE Basket
SET hasBeenCalculated = 1
WHERE status IN ('compared', 'inProgress', 'completed');

-- Backfill: any basket with at least one item is presumed user-edited
-- (the alternative would be that the user opened it and never touched
-- it, which means it'd already be considered abandoned and pruning is
-- the correct outcome — but we don't trigger a sweep at migration time;
-- leave existing baskets alone).
UPDATE Basket b
SET userEditedAfterCreation = 1
WHERE EXISTS (
    SELECT 1 FROM BasketItem bi WHERE bi.basketId = b.id LIMIT 1
);
