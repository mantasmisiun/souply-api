-- CONTRACT phase: drop the now-vestigial independent `receiptNo` column. receiptNos is the sole
-- identifier store; the canonical scalar + the UNIQUE dedup key live on the generated
-- `receiptNoCanonical` (= receiptNos[0]), added by sql/receipt_add_canonical.sql.
--
-- ⚠ Run this ONLY AFTER the new API code is fully deployed (no live instance still reads/writes the
--   receiptNo column). On a rolling deploy, confirm every replica reports the new build first. On a
--   single VM, this runs together with the other migrations during the stop→migrate→start window.
--
-- ⚠ IRREVERSIBLE. Rollback (if ever needed): re-add the column and rebuild it from the canonical —
--     ALTER TABLE Receipt ADD COLUMN receiptNo VARCHAR(50) NULL AFTER receiptNos;
--     UPDATE Receipt SET receiptNo = receiptNoCanonical;
--     ALTER TABLE Receipt DROP INDEX unique_receipt,
--                         ADD UNIQUE KEY unique_receipt (receiptNo, storeId, receiptDate),
--                         DROP COLUMN receiptNoCanonical;
--   (Sound because receiptNos[0] === the old receiptNo, which receipt_add_canonical.sql guarantees.)
--   Take a backup of (id, receiptNoCanonical) before running if you want belt-and-braces.

ALTER TABLE `Receipt` DROP COLUMN IF EXISTS `receiptNo`;
