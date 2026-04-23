-- Extend Basket.status to include 'inProgress' for "shopping list created,
-- basket locked read-only until the list completes". This is the state
-- between 'compared' (calculated, editable via revert) and 'completed'
-- (shopping done, terminal).
--
-- Old shopping-list code wrote 'active' into basket.status when a list
-- was created, which wasn't in the validator's enum — a latent mismatch.
-- Migrate any existing 'active' rows to 'inProgress' before narrowing
-- the ENUM.

UPDATE Basket SET status = 'inProgress' WHERE status = 'active';

ALTER TABLE Basket
  MODIFY COLUMN status ENUM('draft', 'compared', 'inProgress', 'completed')
                  NOT NULL DEFAULT 'draft';
