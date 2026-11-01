-- Migración para añadir source_wamid a appointments
-- y crear índice UNIQUE parcial

-- Verificar que no existe la columna
PRAGMA table_info(appointments);

-- Añadir columna
ALTER TABLE appointments ADD COLUMN source_wamid TEXT;

-- Crear índice UNIQUE parcial
CREATE UNIQUE INDEX idx_appointments_source_wamid
ON appointments(source_wamid)
WHERE source_wamid IS NOT NULL;

-- Verificar resultado
PRAGMA table_info(appointments);
PRAGMA index_list(appointments);