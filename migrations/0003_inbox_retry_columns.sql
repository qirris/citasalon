-- Migración 0003: columnas de reintento del Inbox.
--
-- La Fase 2 necesita poder reprogramar un mensaje fallido sin perder el orden por
-- teléfono. Se guardan los intentos, cuándo toca reintentarlo y el último error.
--
-- Nota: la base local se creó aplicando 0001/0002 a mano (no existe d1_migrations),
-- así que esta migración se aplica con:
--   npx wrangler d1 execute citasalon --local --file migrations/0003_inbox_retry_columns.sql

ALTER TABLE inbox_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_messages ADD COLUMN next_attempt_at TEXT;
ALTER TABLE inbox_messages ADD COLUMN last_error TEXT;
ALTER TABLE inbox_messages ADD COLUMN updated_at TEXT;

-- Recuperación: buscar rápido lo pendiente por teléfono y por estado.
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_inbox_phone_status ON inbox_messages(phone, status, sequence);

PRAGMA table_info(inbox_messages);
