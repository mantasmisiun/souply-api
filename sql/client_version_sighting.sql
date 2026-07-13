-- Client version telemetry (roadmap project_roadmap_version_gating, Phase 5). A daily
-- per-(platform, version) request rollup so an operator can SEE the live version
-- distribution and tell when old builds have drained to ~0 — the signal that it's finally
-- safe to CONTRACT (delete the deprecated code/routes the gate was protecting).
--
-- Written from an in-memory buffer flushed on an interval (versionTelemetry.ts), so the
-- request hot path never does a DB write. Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS ClientVersionSighting (
    platform  ENUM('ios','android','web') NOT NULL,
    version   VARCHAR(32) NOT NULL,
    day       DATE NOT NULL,
    requests  BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (platform, version, day),
    KEY idx_cvs_day (day)
);
