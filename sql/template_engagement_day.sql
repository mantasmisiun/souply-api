-- Per-(template, actor, day) engagement ledger backing the creator-stat
-- anti-inflation rules: a template's useCount / visitCount is bumped at most
-- once per actor per calendar day (burst protection), and never for the
-- creator's own actions (enforced in code via a creatorId != actorId guard).
--
-- `actorKey` is the user UUID for known users (app), or `ip:<addr>` for
-- anonymous web visitors of the public /t/:slug page. A genuine recurring
-- shopper still accrues one use/visit per day (e.g. a weekly shopper → ~52/yr),
-- while a creator hammering their own QR is collapsed to zero.
CREATE TABLE IF NOT EXISTS TemplateEngagementDay (
    templateId INT          NOT NULL,
    actorKey   VARCHAR(64)  NOT NULL,
    kind       ENUM('use','visit') NOT NULL,
    day        DATE         NOT NULL,
    createdAt  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (templateId, actorKey, kind, day)
);
