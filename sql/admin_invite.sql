-- AdminInvite: provisioned admin slots awaiting QR scan + email verification
CREATE TABLE IF NOT EXISTS AdminInvite (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    tokenHash       CHAR(64) NOT NULL UNIQUE,       -- SHA-256 hex of raw QR token
    email           VARCHAR(255) NOT NULL,
    firstName       VARCHAR(100) NOT NULL,
    lastName        VARCHAR(100) NOT NULL,
    role            ENUM('admin','superadmin') DEFAULT 'admin',
    notes           TEXT,
    status          ENUM('pending_scan','pending_email','claimed','expired','revoked')
                    DEFAULT 'pending_scan',
    expiresAt       DATETIME NOT NULL,              -- QR expiry: 24h from creation
    emailToken      CHAR(64),                       -- SHA-256 hex of email verify token
    emailExpiry     DATETIME,                       -- 1h from QR scan
    claimedUserId   VARCHAR(36),
    claimedAt       DATETIME,
    createdAt       DATETIME DEFAULT CURRENT_TIMESTAMP,
    createdBy       VARCHAR(255),
    INDEX idx_tokenHash (tokenHash),
    INDEX idx_email     (email),
    INDEX idx_status    (status)
);

-- AdminInviteLog: immutable record of admin invite lifecycle events
CREATE TABLE IF NOT EXISTS AdminInviteLog (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    userId      VARCHAR(36),
    inviteId    INT,
    action      VARCHAR(64) NOT NULL,
    detail      JSON,
    createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_userId (userId),
    INDEX idx_action (action)
);

-- Admin profile + shadow ban columns on User
ALTER TABLE User
    ADD COLUMN firstName        VARCHAR(100),
    ADD COLUMN lastName         VARCHAR(100),
    ADD COLUMN adminEmail       VARCHAR(255),
    ADD COLUMN adminRole        ENUM('admin','superadmin'),
    ADD COLUMN adminGrantedAt   DATETIME,
    ADD COLUMN shadowBanned     TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN shadowBannedAt   DATETIME,
    ADD COLUMN shadowBannedNote TEXT;
