-- Souply 2.0 Phase 6 — notification plumbing. The INBOX is the source of
-- truth (works without push permission; the bell badge polls unread); push
-- via Expo's service is just the doorbell. FK-less like the newer tables.
-- Idempotent. Apply order: dev → staging → prod.

CREATE TABLE IF NOT EXISTS PushToken (
    id INT(11) NOT NULL AUTO_INCREMENT,
    userId CHAR(36) NOT NULL,
    token VARCHAR(255) NOT NULL,
    platform ENUM('ios','android') NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pushtoken (token),
    KEY idx_pushtoken_user (userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS Notification (
    id INT(11) NOT NULL AUTO_INCREMENT,
    userId CHAR(36) NOT NULL,
    type VARCHAR(40) NOT NULL,
    -- JSON payload (title/body/deep-link params) — LONGTEXT like other blobs.
    payload LONGTEXT DEFAULT NULL,
    readAt DATETIME DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_notification_user (userId, readAt, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
