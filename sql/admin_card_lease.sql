-- Migration: Admin work-queue leases (industry-standard "visibility timeout"
-- pattern, same shape as SQS / Sidekiq / labeling-platform task assignment).
--
-- One row per claim — admin "checks out" a card and it becomes invisible
-- to other admins until completed, explicitly released, or the lease
-- expires (default 2 hours = long enough for human pacing without a
-- heartbeat, short enough that an abandoned admin doesn't lock cards
-- for a day).
--
-- `queueKind` is here so the table can serve future admin tabs without
-- a parallel schema — same lease semantics across all of them.

CREATE TABLE IF NOT EXISTS AdminCardLease (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    spId INT NOT NULL,
    leasedTo VARCHAR(64) NOT NULL,
    queueKind ENUM('image') NOT NULL,
    leasedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expiresAt DATETIME NOT NULL,
    completedAt DATETIME NULL,
    abandonedAt DATETIME NULL,
    -- Active-filter columns first so the "is this lease active?" check
    -- index-scans cleanly. Active = both null + not expired.
    INDEX idx_active (queueKind, completedAt, abandonedAt, expiresAt),
    INDEX idx_admin (leasedTo, queueKind, completedAt, abandonedAt),
    INDEX idx_sp (spId, queueKind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
