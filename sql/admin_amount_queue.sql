-- Migration: Admin amounts tab.
--
-- Extends the existing AdminCardLease queueKind enum to support a
-- second queue type. No new tables — the image tab's chassis (lease,
-- audit, rate limit, image-action client wrappers) is generic.
--
-- The amounts queue picker (in src/models/adminAmountQueueModel.ts)
-- pulls SPs missing OR potentially-wrong amount/unit, filters via the
-- nameAmountParser, and surfaces only rows where the parser disagrees
-- with the DB (priority 2) plus user-flagged rows (priority 1, via
-- ReceiptLineIssue.flags.amount).

ALTER TABLE AdminCardLease MODIFY COLUMN queueKind ENUM('image', 'amount') NOT NULL;
