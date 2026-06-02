-- Per-template cover identity: colour + image (preset icon key or emoji).
-- Previously the web dashboard stored these in browser localStorage only,
-- so covers never synced across devices, never reached the mobile app, and
-- were absent from the public /t/:slug share page. These columns make the
-- cover server-owned so all surfaces render the same thing. Idempotent.
--
-- coverColor      — hex string the card background is painted with (e.g. "#EB6784").
-- coverImage      — JSON: { "kind": "preset", "iconKey": "..." } | { "kind": "emoji", "emoji": "🥗" }
--                   NULL means "fall back to the deterministic sample cover".

SET @cc_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'BasketTemplate'
      AND COLUMN_NAME = 'coverColor'
);
SET @sql := IF(@cc_exists = 0,
    'ALTER TABLE BasketTemplate ADD COLUMN coverColor VARCHAR(16) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ci_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'BasketTemplate'
      AND COLUMN_NAME = 'coverImage'
);
SET @sql := IF(@ci_exists = 0,
    'ALTER TABLE BasketTemplate ADD COLUMN coverImage JSON NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
