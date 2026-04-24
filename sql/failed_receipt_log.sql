-- FailedReceiptLog: lightweight audit table for receipts that fail
-- chain or store identification BEFORE a Receipt row is created.
-- Intentionally decoupled from Receipt — a failure means nothing to
-- save there, but we still want to know what the user tried to upload
-- so we can tell "user submitted garbage" apart from "our OCR missed".
--
-- Written by POST /api/receipts/log-fail from the mobile client when
-- it decides to bail out of the Analize flow. Not hit by any other
-- path; safe to truncate if it grows large.
--
-- No FK to User — we want to log even if the userId sanitization
-- fails. Dangling rows are fine, they're advisory logs.

CREATE TABLE IF NOT EXISTS FailedReceiptLog (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    userId          VARCHAR(36) NULL,
    createdAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    failReason      ENUM(
                        'ocr_no_text',
                        'ocr_error',
                        'chain_unrecognized',
                        'store_unrecognized'
                    ) NOT NULL,
    ocrLineCount    INT NULL,
    ocrPreview      TEXT NULL,
    detectedChainName     VARCHAR(64) NULL,
    extractedStoreAddress VARCHAR(255) NULL,
    imageFilePath   VARCHAR(512) NULL,

    INDEX idx_created      (createdAt),
    INDEX idx_user_created (userId, createdAt),
    INDEX idx_reason       (failReason)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
