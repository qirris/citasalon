-- Esquema de la base de datos (Cloudflare D1 = SQLite). Se puede ejecutar varias veces sin problema.

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  service_name  TEXT NOT NULL,
  stylist       TEXT NOT NULL,
  starts_at     TEXT NOT NULL,          -- 'AAAA-MM-DDTHH:MM' hora local del salón
  ends_at       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | cancelled
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'whatsapp',    -- whatsapp | admin | staff
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_start ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_app_phone ON appointments(phone);

CREATE TABLE IF NOT EXISTS sessions (
  phone      TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_messages (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  role    TEXT NOT NULL,
  action  TEXT NOT NULL,
  appt_id INTEGER,
  detail  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_limits(key);
