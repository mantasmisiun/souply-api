-- Shopping-list sharing: co-owned lists + QR share tokens.
--
-- ShoppingListMember introduces a join table so a list can have multiple
-- viewers/editors. The existing ShoppingList.userId stays as the
-- original creator (kept for audit/UI "created by you" checks). Access
-- is now decided by membership rows — the creator gets one with
-- role='owner' automatically.
--
-- ShoppingListShareToken holds short-lived handoff tokens. A QR code
-- encodes only the token string; scanning POSTs it to /claim which
-- inserts a ShoppingListMember and marks the token claimed. Tokens
-- expire so a photo of an old QR can't be reused.

-- 1) Membership.
CREATE TABLE IF NOT EXISTS ShoppingListMember (
    id INT AUTO_INCREMENT PRIMARY KEY,
    listId INT NOT NULL,
    userId VARCHAR(255) NOT NULL,
    role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_slm_list_user (listId, userId),
    CONSTRAINT fk_slm_list FOREIGN KEY (listId) REFERENCES ShoppingList(id) ON DELETE CASCADE
);

-- 2) Backfill: every existing list's creator becomes its owner member.
--    Uses INSERT IGNORE so re-running the migration is safe.
INSERT IGNORE INTO ShoppingListMember (listId, userId, role)
SELECT id, userId, 'owner' FROM ShoppingList;

-- 3) Share tokens.
CREATE TABLE IF NOT EXISTS ShoppingListShareToken (
    id INT AUTO_INCREMENT PRIMARY KEY,
    listId INT NOT NULL,
    token VARCHAR(64) NOT NULL,
    createdBy VARCHAR(255) NOT NULL,
    expiresAt DATETIME NOT NULL,
    claimedAt DATETIME NULL,
    claimedBy VARCHAR(255) NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_slst_token (token),
    CONSTRAINT fk_slst_list FOREIGN KEY (listId) REFERENCES ShoppingList(id) ON DELETE CASCADE
);
