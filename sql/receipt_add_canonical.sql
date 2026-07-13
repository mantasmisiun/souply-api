-- EXPAND phase: add the generated canonical id + move the dedup key onto it, WITHOUT dropping the
-- old `receiptNo` column yet. Safe to run while old code is still live (receiptNo stays readable),
-- so a rolling deploy stays green. Run order:
--     1. sql/receipt_receiptnos.sql        (adds + backfills receiptNos)
--     2. sql/receipt_add_canonical.sql     (THIS — adds receiptNoCanonical + swaps the key)
--     3. deploy the new API code           (reads receiptNoCanonical, writes receiptNos)
--     4. sql/receipt_drop_receiptno_column.sql  (CONTRACT — drops receiptNo, only after #3 is live)
-- Single-VM / brief-downtime alternative: stop the API, run 1+2+4, deploy+start the new code.
--
-- ⚠ Each ALTER below rebuilds the Receipt table (a STORED generated column + a UNIQUE index both
--   force ALGORITHM=COPY and hold a metadata lock). Trivial at the current ~140 rows; on a large
--   table run in a maintenance window or via pt-online-schema-change / gh-ost.

-- 1. GUARANTEE receiptNos[0] === the canonical the OLD unique_receipt(receiptNo,…) key enforced, for
--    EVERY row — otherwise the generated canonical could differ from what the old key deduped on and
--    the ADD UNIQUE below could spuriously collide / lose the dedup identity.
--    (a) fill rows with no array yet from the receiptNo column (Kasa-stripped, like the live normalizer).
UPDATE `Receipt`
SET `receiptNos` = JSON_ARRAY(TRIM(REGEXP_REPLACE(`receiptNo`, '(?i)\\s*Kasa\\s*[0-9].*$', '')))
WHERE `receiptNos` IS NULL AND `receiptNo` IS NOT NULL AND TRIM(`receiptNo`) <> '';
--    (b) repair any row whose array[0] DIVERGED from the column canonical (legacy / admin-edited
--        blobs that weren't canonical-first): prepend the column canonical so it becomes [0].
UPDATE `Receipt`
SET `receiptNos` = JSON_ARRAY_INSERT(`receiptNos`, '$[0]', TRIM(REGEXP_REPLACE(`receiptNo`, '(?i)\\s*Kasa\\s*[0-9].*$', '')))
WHERE `receiptNo` IS NOT NULL AND TRIM(`receiptNo`) <> '' AND `receiptNos` IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`receiptNos`, '$[0]')) <> TRIM(REGEXP_REPLACE(`receiptNo`, '(?i)\\s*Kasa\\s*[0-9].*$', ''));

-- PRE-FLIGHT (recommended): this MUST return zero rows before continuing — if it returns any, two
-- physical receipts would map to the same canonical+store+date and the ADD UNIQUE below will fail:
--   SELECT JSON_UNQUOTE(JSON_EXTRACT(receiptNos,'$[0]')) c, storeId, receiptDate, COUNT(*)
--     FROM Receipt WHERE receiptNos IS NOT NULL GROUP BY 1,2,3 HAVING COUNT(*) > 1;

-- 2. The canonical id, DERIVED from receiptNos[0]. VIRTUAL (not persisted in the row — no
--    duplicated data) — it exists ONLY to carry the UNIQUE dedup index below, since MariaDB can't
--    index a JSON-array element directly. The unique index materialises the values (intrinsic to
--    any index); the table row stores only receiptNos. Recomputed on read / index maintenance.
ALTER TABLE `Receipt`
    ADD COLUMN IF NOT EXISTS `receiptNoCanonical` VARCHAR(50)
        GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(`receiptNos`, '$[0]'))) VIRTUAL AFTER `receiptNos`;

-- 3. Move the dedup key onto the derived canonical. Same name (`unique_receipt`) so the
--    ER_DUP_ENTRY handler that greps for it keeps working. IF [NOT] EXISTS → fully re-runnable.
ALTER TABLE `Receipt` DROP INDEX IF EXISTS `unique_receipt`;
ALTER TABLE `Receipt` ADD UNIQUE KEY IF NOT EXISTS `unique_receipt` (`receiptNoCanonical`, `storeId`, `receiptDate`);
