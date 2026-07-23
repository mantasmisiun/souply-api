-- User-facing receipt hide (2026-07-22).
--
-- The receipt bottom-sheet lets a user REMOVE a scan they no longer want. Two
-- flavours, neither of which may touch shared Price / ReceiptItem / learning
-- data (that's the dev-only hard purge, deleteReceiptWithData):
--
--   • pre-swipe "remove" (DELETE /receipts/:id/user): soft-hide the row from
--     every user-facing read, detach trip/list, wipe the stored photo. Prices
--     are KEPT (idempotent, keyed on storeProductId+storeId+date) so a re-upload
--     of the same paper un-hides + re-links instead of 409-ing.
--   • post-swipe photo-only delete (DELETE /receipts/:id/image): just the image.
--
-- userDeletedAt NULL = visible (the default). A non-null timestamp hides the row
-- from getReceiptsByUserId + the trip-receipts / trip-stats reads. Internal dedup
-- lookups deliberately still see hidden rows so a re-scan reactivates them.
--
-- Apply: dev ✓, test_ci ✓ (schema.sql), staging/prod via the deploy checklist.
ALTER TABLE Receipt
    ADD COLUMN userDeletedAt DATETIME NULL DEFAULT NULL AFTER adminEditedAt;
