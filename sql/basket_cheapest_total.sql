-- Migration: persist the cheapest store's total on the Basket row.
--
-- Source: Pass-A polish — the Krepselis card needs a quick price preview
-- for 'compared' baskets without re-running the comparison engine on
-- every list load. We persist it once when the user runs
-- POST /api/baskets/:id/calculate and read it in the user-listing query.
--
-- Nullable: pre-existing compared baskets remain NULL until they're
-- re-calculated; the client just hides the "nuo €X" line in that case.

SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Basket'
      AND COLUMN_NAME = 'cheapestTotal'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE Basket ADD COLUMN cheapestTotal DECIMAL(10,2) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
