-- Migration: extend AdminCardLease.queueKind for the Flags inbox.
--
-- The Flags tab unifies every pending `ReceiptLineIssue` row that
-- needs admin attention — name, price, discount, image, amount — into
-- a single queue. Image/amount auto-resolve hooks in their respective
-- controllers are removed in the same commit so the Flags tab owns
-- the full user-complaint lifecycle.

ALTER TABLE AdminCardLease MODIFY COLUMN queueKind ENUM('image', 'amount', 'flag') NOT NULL;
