-- Souply 2.0 Phase 1c — households (ONE per user, schema-enforced) + the
-- persistent shared basket singleton + the multi-claim invite ledger.
-- Idempotent; FK-less like the other 2.0 tables.

CREATE TABLE IF NOT EXISTS Household (
    id INT(11) NOT NULL AUTO_INCREMENT,
    createdByUserId CHAR(36) NOT NULL,
    name VARCHAR(255) DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- PRIMARY KEY(userId) IS the "exactly one household per user" invariant —
-- no application code can violate it. Joining another household requires
-- leaving first (DELETE) by construction.
CREATE TABLE IF NOT EXISTS HouseholdMember (
    userId CHAR(36) NOT NULL,
    householdId INT(11) NOT NULL,
    role ENUM('owner','member') NOT NULL DEFAULT 'member',
    joinedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userId),
    KEY idx_hm_household (householdId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The persistent shared container: at most ONE basket per household (UNIQUE
-- allows any number of NULLs, so personal baskets are untouched). It never
-- completes — trips PULL items from it. Excluded from the personal
-- draft-singleton logic by `householdId IS NULL` predicates (basketModel).
ALTER TABLE Basket
    ADD COLUMN IF NOT EXISTS householdId INT(11) DEFAULT NULL,
    ADD UNIQUE KEY IF NOT EXISTS uq_basket_household (householdId);

-- Multi-claim invite ledger (REDESIGN of the single-flight list-share
-- claimedAt): one token, many claimers; UNIQUE(tokenId,userId) makes claims
-- idempotent. Used for trip QR invites AND household QR invites.
CREATE TABLE IF NOT EXISTS InviteToken (
    id INT(11) NOT NULL AUTO_INCREMENT,
    code CHAR(12) NOT NULL,
    scope ENUM('trip','household') NOT NULL,
    targetId INT(11) NOT NULL,
    createdByUserId CHAR(36) NOT NULL,
    revokedAt DATETIME DEFAULT NULL,
    expiresAt DATETIME DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_invite_code (code),
    KEY idx_invite_target (scope, targetId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS InviteClaim (
    tokenId INT(11) NOT NULL,
    userId CHAR(36) NOT NULL,
    claimedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tokenId, userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
