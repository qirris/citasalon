-- Migración 0004: tablas para atomicidad del procesamiento.
--
-- Estas tablas se usan como "centinelas": solo reciben una fila cuando la condición de la
-- guarda NO se cumple, y el CHECK hace fallar la sentencia (y con ella la transacción).
-- En un commit válido no insertan nada y las tablas quedan siempre vacías.
--
-- - tx_fencing_guard: el fencing token del worker ya no es válido (otro worker tomó el
--   bloqueo). Se comprueba como PRIMERA sentencia del batch, antes de cualquier escritura.
-- - tx_business_guard: la condición de negocio cambió entre la planificación y el commit
--   (por ejemplo, el hueco se ocupó). También aborta el batch completo.
--
-- Se aplica con:
--   npx wrangler d1 execute citasalon --local --file migrations/0004_transaction_guards.sql

CREATE TABLE IF NOT EXISTS tx_fencing_guard (
  violation INTEGER NOT NULL CHECK (violation = 0)
);

CREATE TABLE IF NOT EXISTS tx_business_guard (
  violation INTEGER NOT NULL CHECK (violation = 0)
);

PRAGMA table_info(tx_fencing_guard);
PRAGMA table_info(tx_business_guard);
