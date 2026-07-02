-- Vote-aggregation PROVENANCE (pipeline-audit fix, 2026-07-02).
--
-- StoreProductMatchVote rows never recorded whether they were counted into the
-- StoreProductMatch aggregate: burst votes (dwell below the burst threshold) write a
-- row but SKIP the aggregate, so every reversal path had to guess — undo/editVote could
-- decrement a contribution that was never added (negative counts), re-votes could
-- double-count, account deletion reversed burst rows, and the DEV learning reset
-- reconstructed the tallies from a dwell-time heuristic.
--
-- `aggregated` = 1 when this row's vote is currently reflected in StoreProductMatch.
-- Maintained by upsertMatchVote (set on insert AND on every vote change); consumed by
-- the transition-delta helper, undo, account deletion, and the learning reset.
--
-- Guarded so re-running the migration is safe (information_schema check pattern).
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'StoreProductMatchVote' AND COLUMN_NAME = 'aggregated'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE StoreProductMatchVote
        ADD COLUMN aggregated TINYINT(1) NOT NULL DEFAULT 1 AFTER dwellMs',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill: reconstruct provenance for existing rows.
--   • receipt-path burst rows (receiptId set, dwellMs < 1000) were written but NEVER
--     aggregated → 0. (The 1000ms threshold is BURST_DWELL_MS at the time of migration.)
--   • everything else (non-burst receipt votes, editVote rows with dwellMs NULL,
--     orphan/slot2/direct votes — those paths only ever wrote when they aggregated) → 1.
UPDATE StoreProductMatchVote
   SET aggregated = IF(receiptId IS NOT NULL AND dwellMs IS NOT NULL AND dwellMs < 1000, 0, 1)
 WHERE 1 = 1;
