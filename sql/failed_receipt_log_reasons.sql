-- FailedReceiptLog.failReason: add the two reasons the client bail flow has always
-- sent but the enum rejected ('no_products', 'doubled_scan') — those bails 400'd
-- silently and left no log row. Additive enum change, safe on live data.
-- Apply to: dev (done 2026-07-04), staging, production.
ALTER TABLE FailedReceiptLog
    MODIFY COLUMN failReason ENUM(
        'ocr_no_text',
        'ocr_error',
        'chain_unrecognized',
        'store_unrecognized',
        'parse_failed',
        'mask_failed',
        'no_products',
        'doubled_scan'
    ) NOT NULL;
