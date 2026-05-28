-- ShoppingListItem: store the user-selected isWeighable flag for custom items.
-- StoreProduct-linked items still use sp.isWeighable as the fallback, but this
-- column lets custom (storeProductId=NULL) items remember they are weighable.

ALTER TABLE ShoppingListItem
    ADD COLUMN IF NOT EXISTS isWeighable TINYINT(1) NOT NULL DEFAULT 0;
