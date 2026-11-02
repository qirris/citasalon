-- Migración para crear infraestructura de WhatsApp
-- Inbox, Outbox, Secuencias y Bloqueos.
-- Todas las sentencias son idempotentes (IF NOT EXISTS).

-- 1. Inbox de mensajes
CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY, 
    phone TEXT NOT NULL, 
    payload TEXT NOT NULL, 
    sequence INTEGER NOT NULL, 
    status TEXT DEFAULT 'PENDING', 
    created_at TEXT NOT NULL
);

-- Índice para orden por teléfono (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_phone_seq ON inbox_messages(phone, sequence);

-- 2. Secuencias por teléfono (idempotente)
CREATE TABLE IF NOT EXISTS phone_sequences (
    phone TEXT PRIMARY KEY, 
    last_processed_seq INTEGER DEFAULT 0, 
    last_published_seq INTEGER DEFAULT 0
);

-- 3. Outbox de mensajes (idempotente)
CREATE TABLE IF NOT EXISTS sent_messages (
    wamid_origin TEXT NOT NULL, 
    message_index INTEGER NOT NULL, 
    dest_phone TEXT NOT NULL, 
    payload TEXT NOT NULL, 
    status TEXT DEFAULT 'PENDING', 
    meta_status TEXT, 
    wamid_sent TEXT, 
    attempts INTEGER DEFAULT 0, 
    next_attempt_at TEXT, 
    last_error TEXT, 
    created_at TEXT NOT NULL, 
    updated_at TEXT NOT NULL, 
    PRIMARY KEY (wamid_origin, message_index)
);

-- 4. Bloqueos de concurrencia (idempotente)
CREATE TABLE IF NOT EXISTS phone_locks (
    phone TEXT PRIMARY KEY, 
    worker_id TEXT NOT NULL, 
    fencing_token INTEGER NOT NULL DEFAULT 0, 
    expires_at TEXT NOT NULL
);