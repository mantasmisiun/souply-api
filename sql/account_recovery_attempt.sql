-- Migration: account recovery attempt log
--
-- Backs the 3-receipt account recovery flow's rate limiter (3 attempts /
-- 24h per device, see Documentation/roadmap/user-accounts-recovery.md).
--
-- Why server-side: a re-install can't reset the counter — deviceFingerprint
-- combines the OS device id with the install UUID so it stays stable across
-- the recovery flow on one device but doesn't follow the user to a different
-- physical phone.
--
-- Stored even on success so we have one timeline row per "user pressed
-- Atkurti" event. Useful for telemetry ("how often does recovery succeed
-- on the first try?") and for merge-rollback alerts that include the
-- attempt id for log correlation.

CREATE TABLE IF NOT EXISTS AccountRecoveryAttempt (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    deviceFingerprint VARCHAR(128) NOT NULL,
    matchedUserId CHAR(36) NULL,           -- NULL on failure or pre-merge crash
    succeeded TINYINT(1) NOT NULL DEFAULT 0,
    failureReason VARCHAR(64) NULL,        -- 'no-match' | 'insufficient-chains' | 'merge-rollback' | 'locked' | NULL on success
    attemptedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_device (deviceFingerprint, attemptedAt),
    INDEX idx_user (matchedUserId, attemptedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
