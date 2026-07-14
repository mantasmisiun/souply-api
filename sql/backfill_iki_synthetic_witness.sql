-- Backfill the IKI synthetic dedup witness onto PRE-FIX receipts.
--
-- The parser now always appends the deterministic `{date}-{time}-{cents}-iki-receipt`
-- id to receiptNos[] as a duplicate-detection witness (a scan that loses/garbles the
-- printed Kvito Nr. falls back to exactly that synthetic id, so the overlap check
-- meets in either scan order). Rows created BEFORE the fix carry no witness — a new
-- scan of the same paper can't collide with them. This backfill computes the witness
-- from each row's own parsedData footer and appends it.
--
-- Safe by construction:
--   • appends at the END of receiptNos, so receiptNos[0] (→ receiptNoCanonical, the
--     UNIQUE-key generated column) never changes;
--   • IKI only (header.chainId = 3) — no other chain uses the synthetic scheme;
--   • skips rows missing any of date/time/total (a partial key would collide across
--     different receipts) and rows that already carry the witness (idempotent — safe
--     to re-run).
--
-- Apply to: souply_dev, souply_staging, souply_production (at cutover).

UPDATE Receipt
SET receiptNos = JSON_ARRAY_APPEND(receiptNos, '$', CONCAT(
        REPLACE(JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.footer.date')), '-', ''), '-',
        REPLACE(JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.footer.time')), ':', ''), '-',
        CAST(ROUND(JSON_EXTRACT(parsedData, '$.footer.total') * 100) AS UNSIGNED), '-iki-receipt'
    ))
WHERE JSON_EXTRACT(parsedData, '$.header.chainId') = 3
  AND receiptNos IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.footer.date')) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.footer.time')) REGEXP '^[0-9]{2}:[0-9]{2}'
  AND JSON_EXTRACT(parsedData, '$.footer.total') IS NOT NULL
  AND NOT JSON_CONTAINS(receiptNos, JSON_QUOTE(CONCAT(
        REPLACE(JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.footer.date')), '-', ''), '-',
        REPLACE(JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.footer.time')), ':', ''), '-',
        CAST(ROUND(JSON_EXTRACT(parsedData, '$.footer.total') * 100) AS UNSIGNED), '-iki-receipt'
    )));
