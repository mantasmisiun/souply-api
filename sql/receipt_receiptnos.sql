-- Receipt.receiptNos — the FUNCTIONAL set of receipt identifiers as a first-class column.
--
-- A single physical receipt prints SEVERAL ids (IKI: "Kvitas", "Kvito Nr.", "Kvito numeris").
-- We store them as a JSON-text array in their OWN column so the functional data stays INDEPENDENT
-- of the raw `parsedData` blob — that blob may later be slimmed or dropped to save space, and
-- account-recovery must keep working off the column, not the raw OCR payload.
--
-- `receiptNo` stays the canonical scalar (= receiptNos[0]) + the UNIQUE(receiptNo,storeId,receiptDate)
-- dedup key (the longer-term goal is to rely solely on receiptNos and drop receiptNo — once every
-- row has receiptNos[0] === receiptNo, that's a follow-up migration that moves the unique key onto
-- a generated receiptNos[0] column).
--
-- Idempotent + self-contained: re-runnable (IF NOT EXISTS + WHERE receiptNos IS NULL). Running this
-- migration ALSO BACKFILLS every existing row, so receiptNos is populated immediately.

ALTER TABLE `Receipt`
    ADD COLUMN IF NOT EXISTS `receiptNos` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
        CHECK (json_valid(`receiptNos`)) AFTER `receiptNo`;

-- Backfill: prefer the array the parser already wrote into parsedData ($.footer.receiptNos, on
-- receipts parsed after the multi-id parser shipped — already normalized: canonical-first, deduped);
-- else a single-element array of the canonical receiptNo, Kasa-suffix-stripped to match the live
-- normalizer (so the recovery tiebreaker can match it). receiptNos[0] is therefore always the
-- canonical id. Rows with neither stay NULL (read paths fall back to [receiptNo] safely).
--
-- For a richer re-normalization (e.g. cleaning legacy un-normalized values across the whole array)
-- run `tsx src/scripts/backfillReceiptNos.ts` instead/after — it routes every value through the
-- same TS normalizer the live save path uses. This SQL covers the common case in one step.
UPDATE `Receipt`
SET `receiptNos` = COALESCE(
        CASE WHEN JSON_TYPE(JSON_EXTRACT(`parsedData`, '$.footer.receiptNos')) = 'ARRAY'
              AND JSON_LENGTH(JSON_EXTRACT(`parsedData`, '$.footer.receiptNos')) > 0
             THEN JSON_EXTRACT(`parsedData`, '$.footer.receiptNos') END,
        CASE WHEN `receiptNo` IS NOT NULL AND TRIM(`receiptNo`) <> ''
             THEN JSON_ARRAY(TRIM(REGEXP_REPLACE(`receiptNo`, '(?i)\\s*Kasa\\s*[0-9].*$', ''))) END
    )
WHERE `receiptNos` IS NULL
  AND (`receiptNo` IS NOT NULL OR `parsedData` IS NOT NULL);
