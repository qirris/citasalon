# Operación y Despliegue

Guía técnica de operación, despliegue, copias de seguridad y diagnóstico de la aplicación.

---

## 1. Despliegue en Cloudflare Workers

La aplicación se despliega mediante la CLI de Wrangler de Cloudflare.

### Prerrequisitos de Producción
1. Cuenta de Cloudflare con acceso a D1 y Workers.
2. Base de datos D1 creada (`wrangler d1 create citasalon`).
3. Cola de WhatsApp creada (`wrangler queues create whatsapp-inbox`).

### Aplicación de Esquema y Migraciones D1
Para inicializar una nueva base de datos D1 en producción, deben aplicarse en orden estricto:
1. `schema.sql` (Tablas base: `appointments`, `sessions`, `settings`, etc.)
2. `migrations/0001_appointments_source_wamid.sql`
3. `migrations/0002_whatsapp_inbox_outbox.sql` (`inbox_messages`, `sent_messages`, `phone_sequences`)
4. `migrations/0003_inbox_retry_columns.sql` (Columnas de reintento y estado terminal `DEAD`)
5. `migrations/0004_transaction_guards.sql` (Bloqueos y fencing tokens monotónicos)

### Despliegue
```bash
npx wrangler deploy
```

---

## 2. Sistema de Copias de Seguridad y Recuperación (Backups)

### A. Respaldo Local Cifrado (AES-256-GCM)
El proyecto incluye un módulo automatizado de copias de seguridad locales (`src/backup.ts`) que exporta el estado de las tablas operativas, calcula el hash SHA-256 de integridad y cifra el contenido mediante cifrado autenticado **AES-256-GCM**.

Para ejecutar o probar las copias de seguridad locales:
```bash
node --experimental-strip-types test/backup.test.mjs
```

### B. Cloudflare D1 Time Travel
Cloudflare D1 ofrece de forma nativa la funcionalidad **Time Travel**, permitiendo restaurar la base de datos a cualquier punto del tiempo (hasta 30 días en planes de pago, 72 horas en planes gratuitos). Es el mecanismo recomendado para recuperar la base de datos ante errores operativos recientes.

### C. Almacenamiento en R2 (Propuesta Arquitectónica)
Para respaldos independientes de larga duración, se puede programar un Cloudflare Worker / Workflow (`src/r2-backup-workflow.ts`) que exporte periódicamente D1, la cifre y la almacene en un bucket R2 privado bajo una política de retención configurable (ej. 30 días).

---

## 3. PWA e Iconos Móviles

La aplicación es una PWA instalable optimizada para dispositivos móviles (tanto para la vista de recepción como de administración).
- Manifiesto: `public/manifest.json`
- Iconos: `public/icon-192.png` y `public/icon-512.png` (PNGs reales con soporte `maskable`).

---

## 4. Diagnóstico y Monitoreo

- Endpoint de salud: `GET /health` (comprueba la disponibilidad de D1 ejecutando `SELECT 1`, devolviendo `503` en caso de fallo).
- Logs de diagnóstico: Controlados mediante el módulo `src/debug.ts`. En producción `DEBUG=false` por defecto, suprimiendo los logs `[DIAG]` rutinarios pero manteniendo visibles los errores críticos a través de `diagError()`.
