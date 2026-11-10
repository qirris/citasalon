# Operación y Despliegue

Guía técnica de operación, despliegue, copias de seguridad y diagnóstico de la aplicación.

---

## 1. Despliegue en Cloudflare Workers

La aplicación se despliega mediante la CLI de Wrangler de Cloudflare.

### Prerrequisitos de Producción
1. Cuenta de Cloudflare con acceso a D1 y Workers.
2. Base de datos D1 creada (`wrangler d1 create citasalon`).
3. Cola de WhatsApp creada para esta instalación (`wrangler queues create <nombre>-inbox`; `setup.ps1` la crea y actualiza `wrangler.jsonc`).

### Aplicación del esquema D1

**Instalación nueva (D1 vacía):** `schema.sql` contiene el esquema completo (tablas base + Fase 2: Inbox, Outbox, secuencias, bloqueos y guards). Se aplica una sola vez y **no se ejecutan después las migraciones** `0001`–`0004`, porque ya están incluidas.

```bash
npx wrangler d1 create <nombre-d1>
# copiar el database_id a wrangler.jsonc
npx wrangler d1 execute <nombre-d1> --remote --file=schema.sql
```

**Actualización de una instalación existente:** no apliques `schema.sql` ni todas las migraciones a ciegas. Primero inspecciona (solo lectura):

```bash
npx wrangler d1 execute <nombre-d1> --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
npx wrangler d1 execute <nombre-d1> --remote --command "PRAGMA table_info(appointments)"
npx wrangler d1 execute <nombre-d1> --remote --command "PRAGMA index_list(appointments)"
```

Después aplica **solo** las migraciones pendientes, en orden, una a una, comprobando el resultado y con un backup previo:

1. `migrations/0001_appointments_source_wamid.sql` — **saltar si `appointments.source_wamid` ya existe** (`ALTER TABLE` no admite `IF NOT EXISTS`).
2. `migrations/0002_whatsapp_inbox_outbox.sql` — crea `inbox_messages`, `sent_messages` y `phone_sequences`.
3. `migrations/0003_inbox_retry_columns.sql` — columnas de reintento y estado `DEAD`.
4. `migrations/0004_transaction_guards.sql` — bloqueos y fencing tokens.

Si una migración falla o el estado no coincide con lo esperado, **detente** y revisa el esquema; no marques nada como aplicado hasta comprobar tablas, columnas e índices. Las pruebas locales de actualización con datos están en `test/migration.test.mjs`.

### Despliegue
```bash
npx wrangler deploy
```

---

## 2. Sistema de Copias de Seguridad y Recuperación (Backups)

El proyecto incluye herramientas para realizar copias de seguridad cifradas de la base de datos D1 de forma manual mediante scripts de Node.js y Python.

### A. Cifrado y validación local

Los scripts ubicados en `scripts/` permiten la exportación y cifrado seguro:

1. Exportación de la base de datos D1.
2. Validación del SQL con `scripts/validate-d1-backup.py` sobre una SQLite en memoria (`PRAGMA integrity_check` y tabla `appointments`).
3. Cifrado con AES-256-GCM mediante `scripts/encrypt-backup.mjs` (IV aleatorio, SHA-256 de integridad y metadatos embebidos en el archivo `.sql.enc`).

Formato del `.sql.enc` (versión 3): JSON con `format`, `version`, `algorithm` (`aes-256-gcm`), `kdf` (`sha256`), `createdAt`, `sizeBytes`, `checksumSha256`, `iv`, `authTag` y `data`. La clave se deriva con SHA-256 de la contraseña de `BACKUP_ENCRYPTION_KEY`; **si se pierde esa clave, el backup no se puede recuperar**. El formato antiguo de `src/backup.ts` (v2) sigue existiendo para compatibilidad local y pruebas.

### B. Descifrar y restaurar un artefacto

El SQL descifrado contiene datos personales: trabaja en un directorio temporal y bórralo al terminar.

```bash
# 1. Descargar el artefacto d1-backup-AAAA-MM-DD y descomprimir el .zip
# 2. Descifrar (la clave se lee del entorno, nunca se escribe en el comando)
export BACKUP_ENCRYPTION_KEY="..."   # PowerShell: $env:BACKUP_ENCRYPTION_KEY = "..."
node scripts/decrypt-backup.mjs d1-backup-AAAA-MM-DD.sql.enc --out restore.sql

# 3. Validar el SQL descifrado
python3 scripts/validate-d1-backup.py restore.sql --require-table appointments

# 4. Restaurar en una D1 LOCAL aislada (no toca producción)
npx wrangler d1 execute citasalon --local --persist-to .wrangler/restore-test --file=restore.sql

# 5. Comprobar recuentos y datos
npx wrangler d1 execute citasalon --local --persist-to .wrangler/restore-test \
  --command "SELECT COUNT(*) AS citas FROM appointments"

# 6. Borrar el SQL en claro
rm restore.sql
```

`--persist-to .wrangler/restore-test` crea una copia local separada de la D1 de desarrollo; no afecta a ninguna base remota. Para restaurar de verdad en producción hace falta autorización expresa y una ventana de mantenimiento; no lo hagas sin haber probado antes este procedimiento con el artefacto real.

### C. Cloudflare D1 Time Travel

D1 incluye **Time Travel** para recuperar la base a un punto del tiempo reciente. Los límites dependen del plan contratado: consúltalos en la documentación de Cloudflare antes de confiar en esta opción. Time Travel complementa los backups cifrados, no los sustituye.

### D. Almacenamiento en R2 (no implementado)

`src/r2-backup-workflow.ts` es una propuesta/experimento y **no se ejecuta en producción**. No lo presentes como parte del sistema operativo hasta que esté desplegado y verificado.

---

## 3. PWA e Iconos Móviles

La aplicación es una PWA instalable optimizada para dispositivos móviles (tanto para la vista de recepción como de administración).
- Manifiesto: `public/manifest.json`
- Iconos: `public/icon-192.png` y `public/icon-512.png` (PNGs reales con soporte `maskable`).

---

## 4. Diagnóstico y Monitoreo

- Endpoint de salud: `GET /health` (comprueba la disponibilidad de D1 ejecutando `SELECT 1`, devolviendo `503` en caso de fallo).
- Logs de diagnóstico: Controlados mediante el módulo `src/debug.ts`. En producción `DEBUG=false` por defecto, suprimiendo los logs `[DIAG]` rutinarios pero manteniendo visibles los errores críticos a través de `diagError()`.
