-- Migration: Basket Templates — Pass A.4 (auto-update delta tracking).
--
-- Source spec: Documentation/roadmap/sablonai.md Part 2.3.
--
-- When `generateDefaultTemplate(userId)` re-runs an auto-update on an
-- existing default template, it computes a delta (items added + removed)
-- and persists it on the row. The client surfaces a *"Šablonas atnaujintas
-- pagal naujus kvitus"* nudge once when the delta is meaningful (> 3),
-- then acks the nudge via PATCH which clears the counter.
--
-- Both columns are nullable — the very first generation (action='created')
-- doesn't write them because there's no prior state to diff against.

SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'BasketTemplate'
      AND COLUMN_NAME = 'lastAutoUpdateDelta'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE BasketTemplate ADD COLUMN lastAutoUpdateDelta INT NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'BasketTemplate'
      AND COLUMN_NAME = 'lastAutoUpdateAt'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE BasketTemplate ADD COLUMN lastAutoUpdateAt DATETIME NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
