-- Migración para crear infraestructura de WhatsApp
-- Inbox, Outbox, Secuencias y Bloqueos

-- 1. Inbox de mensajes
CREATE TABLE inbox_messages (
    id TEXT PRIMARY KEY, 
    phone TEXT NOT NULL, 
    payload TEXT NOT NULL, 
    sequence INTEGER NOT NULL, 
    status TEXT DEFAULT 'PENDING', 
    created_at TEXT NOT NULL
);

-- Índice para orden por teléfono
CREATE UNIQUE INDEX idx_inbox_phone_seq ON inbox_messages(phone, sequence);

-- 2. Secuencias por teléfono
CREATE TABLE phone_sequences (
    phone TEXT PRIMARY KEY, 
    last_processed_seq INTEGER DEFAULT 0, 
    last_published_seq INTEGER DEFAULT 0
);

-- 3. Outbox de mensajes
CREATE TABLE sent_messages (
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

-- 4. Bloqueos de concurrencia
CREATE TABLE phone_locks (
    phone TEXT PRIMARY KEY, 
    worker_id TEXT NOT NULL, 
    fencing_token INTEGER NOT NULL DEFAULT 0, 
    expires_at TEXT NOT NULL
);

-- Verificar resultado
PRAGMA table_info(inbox_messages);
PRAGMA table_info(phone_sequences);
PRAGMA table_info(sent_messages);
PRAGMA table_info(phone_locks);
PRAGMA index_list(inbox_messages);