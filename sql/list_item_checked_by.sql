-- Who checked a shared-list item (and when): a trip can be shared, so an item
-- ticked by one member must show THAT member's avatar to everyone else — so
-- they don't think they ticked it themselves — and unticking someone else's
-- item is guarded by a confirm. NULL checkedBy = unchecked (or a legacy tick
-- from before this column). FK clears the attribution if the user is deleted.
--
-- Apply: dev → staging → prod. Backward-compatible (new nullable columns).

ALTER TABLE ShoppingListItem
    ADD COLUMN checkedBy CHAR(36) NULL AFTER isChecked,
    ADD COLUMN checkedAt DATETIME NULL AFTER checkedBy,
    ADD CONSTRAINT fk_sli_checkedby FOREIGN KEY (checkedBy) REFERENCES User (id) ON DELETE SET NULL;
