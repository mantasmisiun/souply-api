-- Extend FailedReceiptLog from a pre-Receipt audit note into the full
-- failed-upload pipeline backing store.
--
-- A "failed receipt" is one we could NOT turn into a Receipt: no OCR text, OCR
-- error, chain/store unrecognized, parse failure, or client-side card-masking
-- failure. (A DUPLICATE is NOT a failure — it silently links to the existing
-- Receipt and is never logged here.)
--
-- New columns:
--   environment      which deployment logged it (R2=production, MinIO=dev/staging);
--                    drives bucket choice + Telegram cadence + the [env] tag.
--   failedBucketPath path of the (already card-masked) image in the failed bucket.
--   shoppingListId   the list row the upload was meant for, so a later admin fix
--                    can push it into Receipt AND link it back to the list.
--   parsedData       OCR/parsed payload captured at fail time, so the admin can
--                    correct the wrong field (chain/address/receiptNo) and promote
--                    it to Receipt without a re-scan.
--   status           'new' until an admin resolves (fixes + promotes) it.
--   resolvedAt       when it was promoted out / dismissed.
--
-- Still intentionally FK-less (advisory log; dangling rows are fine).

ALTER TABLE `FailedReceiptLog`
    MODIFY COLUMN `failReason` ENUM(
        'ocr_no_text',
        'ocr_error',
        'chain_unrecognized',
        'store_unrecognized',
        'parse_failed',
        'mask_failed'
    ) NOT NULL,
    ADD COLUMN `environment` ENUM('dev','staging','production') NOT NULL DEFAULT 'dev' AFTER `failReason`,
    ADD COLUMN `failedBucketPath` VARCHAR(512) DEFAULT NULL AFTER `imageFilePath`,
    ADD COLUMN `shoppingListId` INT(11) DEFAULT NULL AFTER `failedBucketPath`,
    ADD COLUMN `parsedData` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL AFTER `shoppingListId`,
    ADD COLUMN `status` ENUM('new','resolved') NOT NULL DEFAULT 'new' AFTER `parsedData`,
    ADD COLUMN `resolvedAt` DATETIME DEFAULT NULL AFTER `status`,
    ADD KEY `idx_frl_status` (`status`, `createdAt`),
    ADD KEY `idx_frl_env` (`environment`, `createdAt`);
