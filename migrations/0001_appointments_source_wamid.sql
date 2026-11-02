-- Migración para añadir source_wamid a appointments
-- y crear índice UNIQUE parcial.
-- NOTA: ALTER TABLE ADD COLUMN no tiene IF NOT EXISTS en SQLite.
-- Solo aplicar esta migración si la columna source_wamid aún no existe.

-- Añadir columna (falla si ya existe: es esperable en bases ya actualizadas)
ALTER TABLE appointments ADD COLUMN source_wamid TEXT;

-- Crear índice UNIQUE parcial (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_source_wamid
ON appointments(source_wamid)
WHERE source_wamid IS NOT NULL;