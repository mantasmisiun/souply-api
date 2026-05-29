-- Beta signups captured from the souply-web landing "Join the beta" form.
-- Previously the form only wrote to the visitor's localStorage (lost on
-- the server side); this table persists them so invites can actually be
-- sent. Unique email so a repeat submit refreshes the row instead of
-- duplicating.

CREATE TABLE IF NOT EXISTS BetaSignup (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    name      VARCHAR(255) NOT NULL,
    email     VARCHAR(255) NOT NULL,
    platform  VARCHAR(16)  NOT NULL DEFAULT 'ios',
    createdAt DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_beta_email (email)
);
