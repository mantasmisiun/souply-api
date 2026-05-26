-- Tracks whether any superadmin has edited a receipt via the Kvitai inspect tab.
-- NULL = never edited. Non-null = at least one field was changed.
ALTER TABLE Receipt
    ADD COLUMN adminEditedAt DATETIME NULL;
