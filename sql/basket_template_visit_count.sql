-- Per-template visit counter. Incremented each time the public share page
-- (/api/t/:slug) is resolved, so creators can see "Apsilankymai" alongside
-- useCount + collectiveSavings on the web card and the in-app Statistika tab.
-- Idempotent.

SET @vc_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'BasketTemplate'
      AND COLUMN_NAME = 'visitCount'
);
SET @sql := IF(@vc_exists = 0,
    'ALTER TABLE BasketTemplate ADD COLUMN visitCount INT NOT NULL DEFAULT 0',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
