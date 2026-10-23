-- Removed-member ban list: a user removed from a trip by its OWNER cannot
-- rejoin via existing invite links/QRs. Only an invite minted by the OWNER
-- readmits (claim clears the row). Member-created invites stay blocked.
--
-- Apply: dev → staging → prod. Backward-compatible (new table).

CREATE TABLE TripMemberBan (
    tripId INT(11) NOT NULL,
    userId CHAR(36) NOT NULL,
    bannedBy CHAR(36) NULL,
    bannedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tripId, userId)
);
