-- Adds the most-expensive store's total to the share snapshot so the
-- public landing page + in-app share sheet can render "Sutaupyk iki €X"
-- (save up to €X) — the maximum potential savings vs. the worst store,
-- not just vs. the runner-up. Idempotent.

SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'BasketTemplate'
      AND COLUMN_NAME = 'snapshotMostExpensiveEur'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE BasketTemplate ADD COLUMN snapshotMostExpensiveEur DECIMAL(10,2) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
