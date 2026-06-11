-- Link a Receipt to the ShoppingList (one store's trip) it was uploaded for.
--
-- A ShoppingList row is for ONE store; a 1/2/3-store "split" is 1/2/3 rows that
-- share a basketId, so each store's row needs its own receipt. Receipt ->
-- ShoppingList is therefore many-to-one, and NULLABLE:
--   * a receipt can exist unlinked (scanned standalone in the Analize tab),
--     then get linked to a list later;
--   * when an upload is a duplicate, we link the EXISTING receipt row to the
--     list instead of inserting a new one.
--
-- "Receipts uploaded so far" for a split = COUNT(Receipt WHERE shoppingListId IN
-- (the group's list ids)). A list row is "awaiting receipt" when it is
-- status='completed' and has no Receipt pointing at it.
--
-- ON DELETE SET NULL: deleting a list must not delete the user's receipt (the
-- purchase/price data outlives the list).

ALTER TABLE `Receipt`
    ADD COLUMN `shoppingListId` INT(11) DEFAULT NULL AFTER `storeId`,
    ADD KEY `idx_receipt_shoppinglist` (`shoppingListId`),
    ADD CONSTRAINT `fk_receipt_shoppinglist` FOREIGN KEY (`shoppingListId`)
        REFERENCES `ShoppingList` (`id`) ON DELETE SET NULL;
