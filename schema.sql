-- Esquema completo de la base de datos (Cloudflare D1 = SQLite).
-- Incluye las tablas base y las de Fase 2 (Inbox, Outbox, secuencias, bloqueos y guardas).
-- Se puede ejecutar varias veces sin problema (usa IF NOT EXISTS en todo).
-- Para instalaciones nuevas: aplicar este archivo completo.
-- Para actualizaciones: aplicar solo las migraciones pendientes en migrations/0001..0004.

-- ------------------------------------------------------------------ tablas base
CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  service_name  TEXT NOT NULL,
  stylist       TEXT NOT NULL,
  starts_at     TEXT NOT NULL,          -- 'AAAA-MM-DDTHH:MM' hora local del salón
  ends_at       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | cancelled | done
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'whatsapp',    -- whatsapp | admin | staff
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  source_wamid  TEXT                                     -- WAMID del mensaje de WhatsApp (idempotencia)
);
CREATE INDEX IF NOT EXISTS idx_app_start ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_app_phone ON appointments(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_source_wamid
  ON appointments(source_wamid) WHERE source_wamid IS NOT NULL;

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

-- ------------------------------------------------------------------ tablas Fase 2 (Inbox / Outbox / Consumer)
CREATE TABLE IF NOT EXISTS inbox_messages (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL,
  payload       TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_phone_seq ON inbox_messages(phone, sequence);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_inbox_phone_status ON inbox_messages(phone, status, sequence);

CREATE TABLE IF NOT EXISTS phone_sequences (
  phone               TEXT PRIMARY KEY,
  last_processed_seq  INTEGER NOT NULL DEFAULT 0,
  last_published_seq  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sent_messages (
  wamid_origin  TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  dest_phone    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  meta_status   TEXT,
  wamid_sent    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (wamid_origin, message_index)
);

CREATE TABLE IF NOT EXISTS phone_locks (
  phone         TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT NOT NULL
);

-- Guardas de atomicidad (centinelas: solo reciben filas cuando la condición falla)
CREATE TABLE IF NOT EXISTS tx_fencing_guard (
  violation INTEGER NOT NULL CHECK (violation = 0)
);
CREATE TABLE IF NOT EXISTS tx_business_guard (
  violation INTEGER NOT NULL CHECK (violation = 0)
);
