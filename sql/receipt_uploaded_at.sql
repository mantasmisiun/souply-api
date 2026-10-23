-- Fixed-at-upload timestamp so the "old receipt" flag never drifts: a receipt
-- that was fresh when uploaded stays non-stale forever, and one that was old at
-- upload stays flagged. New rows default to the insert time; existing rows are
-- backfilled to their own receiptDate (age 0 → never retroactively flagged).
ALTER TABLE Receipt ADD COLUMN uploadedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE Receipt SET uploadedAt = receiptDate WHERE receiptDate IS NOT NULL;
