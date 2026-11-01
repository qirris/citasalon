# Operación y despliegue

Guía práctica para ejecutar, verificar, desplegar y diagnosticar el proyecto. Complementa `PUESTA_EN_MARCHA.md` (que es la secuencia para un salón nuevo).

## Comandos disponibles

| Comando | Qué hace |
|---|---|
| `npm install` | Instala dependencias. |
| `npm run dev` | `wrangler dev --test-scheduled` en `http://localhost:8787`. Lee `.dev.vars`. |
| `npm run check` | `tsc --noEmit` en modo estricto. **Obligatorio** tras cambiar `src/`. |
| `npm run e2e` | **Borra las tablas de la D1 local** y ejecuta `test/e2e.mjs`. Requiere `npm run dev` en otra terminal. |
| `npm run deploy` | `wrangler deploy` al Worker de producción. |
| `npm run backup` | Exporta la D1 remota a `backups/backup.sql` (fuera de git). |
| `npm run qr:recepcion` | Regenera `public/qr-recepcion.svg` desde la URL configurada. |

> **Cuidado con `npm run e2e`**: no es una prueba de solo lectura. Vacía `appointments`, `sessions`, `settings`, `audit_log`, `login_attempts`, `processed_messages` y `rate_limits` de la base **local**. No lo ejecutes si esa base contiene datos que quieres conservar.

## Entorno local

1. Copia `.dev.vars.example` a `.dev.vars` si no existe.
2. Aplica el esquema a la D1 local (el orden importa: `schema.sql` **no** crea Inbox/Outbox):

```powershell
npx wrangler d1 execute citasalon --local --file=schema.sql
npx wrangler d1 execute citasalon --local --file=migrations/0001_appointments_source_wamid.sql
npx wrangler d1 execute citasalon --local --file=migrations/0002_whatsapp_inbox_outbox.sql
npx wrangler d1 execute citasalon --local --file=migrations/0003_inbox_retry_columns.sql
```

> La base local del proyecto se migró a mano así (no existe `d1_migrations`). Si una migración ya está aplicada, `ALTER TABLE` fallará: comprueba antes con `PRAGMA table_info(...)`. **Haz un backup antes de migrar** (`npm run backup`).

3. Arranca el servidor:

```powershell
npm run dev
```

4. Abre `http://localhost:8787/admin`, `/recepcion` o `/qr`.

Sin `WHATSAPP_TOKEN`, el bot funciona en **modo consola**: registra en el log lo que habría enviado y no contacta con Meta. Con token, un mensaje real puede crear citas reales en la base local: no uses números de clientes en ese entorno.

## Secretos

| Entorno | Dónde viven |
|---|---|
| Producción | Cloudflare, con `npx wrangler secret put NOMBRE`. No se pueden leer después. |
| Local | `.dev.vars` (ignorado por git). |

Secretos usados: `ADMIN_PASSWORD`, `STAFF_PASSWORD`, `SESSION_SECRET`, `VERIFY_TOKEN`, `APP_SECRET`, `WHATSAPP_TOKEN`.

- `SESSION_SECRET` es obligatorio: sin él no hay sesiones de panel.
- `APP_SECRET` permite validar la firma de los webhooks de Meta.
- Nunca copies valores en `.md`, issues, capturas ni commits.

## Verificaciones seguras

Estas comprobaciones no modifican datos ni borran tablas:

```powershell
npm run check                              # TypeScript
node --check test/e2e.mjs                  # sintaxis de la suite
npx wrangler deploy --dry-run              # empaquetado sin publicar
Invoke-WebRequest -UseBasicParsing "https://<url>/health"
```

Comprobaciones que **sí** escriben (hazlas solo en local o en una copia):

- Crear/editar/cancelar una cita desde el panel.
- Probar el webhook con una firma HMAC.
- Ejecutar `npm run e2e` (vacía la base local).

## Despliegue

Antes de desplegar:

1. `npm run check` limpio.
2. Revisar que `wrangler.jsonc` tiene el `database_id` y las variables correctas.
3. Confirmar que los secretos necesarios existen en el Worker (`npx wrangler secret list`).
4. Si hay cambios de esquema, aplicar `schema.sql` y las migraciones pendientes a la D1 remota:

```powershell
npx wrangler d1 execute citasalon --remote --file=schema.sql
npx wrangler d1 execute citasalon --remote --file=migrations/0001_appointments_source_wamid.sql
npx wrangler d1 execute citasalon --remote --file=migrations/0002_whatsapp_inbox_outbox.sql
npx wrangler d1 execute citasalon --remote --file=migrations/0003_inbox_retry_columns.sql
```

5. Si se va a usar la cola de WhatsApp, crearla **una vez** antes de desplegar (el Inbox de D1 funciona sin ella):

```powershell
npx wrangler queues create whatsapp-inbox
```

6. Desplegar:

```powershell
npm run deploy
```

7. Comprobar `/health`, `/qr`, `/admin` (login) y `/recepcion`.

> El despliegue **no** aplica el esquema automáticamente. Un Worker nuevo con una D1 vacía necesita `schema.sql` **y** las migraciones `0001`–`0003`, o fallará al primer mensaje (faltan `inbox_messages`, `sent_messages`, `phone_sequences` y `phone_locks`).

## Estado de producción (según `memoria.md`)

- URL: `https://<tu-worker>.workers.dev`.
- Worker y D1 desplegados el **2026-10-19**.
- Los cambios posteriores (elección de peluquero en el bot, servicios activables, «Próximas citas», filtro de agenda, estado `done`, mejoras visuales) están **solo en local**: sin commit ni deploy, salvo que se indique lo contrario en `memoria.md`.
- **Fase 2 (Inbox durable, Consumer, Outbox y cola local) tampoco está desplegada**; la cola remota `whatsapp-inbox` no se ha creado.
- WhatsApp en producción está **desactivado** por decisión del usuario: sin `WHATSAPP_TOKEN` ni `APP_SECRET` en el Worker remoto. El bot queda en modo consola.

Antes de afirmar que producción tiene una función, comprueba el estado real o consulta la sección 2 de `memoria.md`.

## Backups

- Manual: `npm run backup` → `backups/backup.sql`.
- Automático: `.github/workflows/backup.yml` exporta la D1 cada día a las 03:00 UTC y guarda el artefacto 30 días.
- Requiere los secretos de repositorio `CLOUDFLARE_API_TOKEN` (permiso D1) y `CLOUDFLARE_ACCOUNT_ID`.
- Los backups contienen teléfonos y nombres: nunca se suben al repositorio.
- La restauración es manual y **no está automatizada**; pruébala en una D1 de prueba antes de confiar en ella.

## Integración continua

`.github/workflows/ci.yml` ejecuta en cada push a `master`, en PR y a mano:

1. `npm ci`
2. `npm run check`
3. Crea un `.dev.vars` de prueba.
4. Aplica `schema.sql` a la D1 local.
5. Arranca `wrangler dev`, espera `/health`.
6. Ejecuta `npm run e2e`.
7. Valida la sintaxis de `setup.ps1` con el parser de PowerShell.

No necesita secretos reales.

> **Pendiente de Fase 3:** el workflow **no** aplica las migraciones `0001`–`0003` ni ejecuta `npm test` (las pruebas usan `node:sqlite`, disponible sin flag en Node 24; el CI usa Node 22). El e2e actual no toca el Inbox, por eso sigue pasando; al añadir pruebas de Fase 2 al CI habrá que subir Node y aplicar las migraciones.

## Diagnóstico rápido

| Síntoma | Qué mirar |
|---|---|
| El panel no carga | `/health` local; si usas túnel, que el proceso y el DNS del túnel estén vivos. |
| «Contraseña incorrecta» siempre | Secreto `ADMIN_PASSWORD`/`STAFF_PASSWORD` del entorno correcto; cookies de un host distinto. |
| El bot recibe pero no responde | `WHATSAPP_TOKEN` caducado o ausente (modo consola); revisar el log del Worker. |
| El bot no recibe nada | Webhook de Meta: URL, `VERIFY_TOKEN` y, sobre todo, el **override por número**, que manda sobre el de la aplicación. |
| No aparecen huecos | Horario general, horario propio, ausencias, días cerrados, antelación mínima y duración del servicio. |
| Una cita no aparece en la agenda | La agenda abre hoy; usar «Próximas citas», cambiar de fecha o Buscar citas. |
| No carga el manifest PWA en recepción | La CSP debe incluir `manifest-src 'self'` (corregido el 2026-10-30; ver `memoria.md` §9). Si persiste, comprobar que se sirve la versión actual del Worker y forzar recarga del navegador. |
| Error de base de datos al desplegar | Falta aplicar `schema.sql` o las migraciones `0001`–`0003` (Inbox/Outbox), o el `database_id` no coincide. |
| El bot recibe y el Inbox crece pero no responde | Revisar `inbox_messages.status` (`FAILED`/`DEAD`), `last_error` y `attempts`; el cron reintenta con backoff y deja `DEAD` tras 5 intentos. |
| Respuestas que no llegan | `sent_messages`: `PENDING`/`SENDING` (cola/cron), `FAILED` (error de Meta) o `UNKNOWN` (red/timeout). Un `FAILED/UNKNOWN` con `next_attempt_at=NULL` es terminal. |

Para túneles temporales (`trycloudflare`): la URL cambia al recrearlo y hay que actualizarla **en dos sitios** de Meta (suscripción de la app y override del número). Un túnel rápido no es una solución de producción.

## Qué no hacer sin autorización

- `npm run e2e` sobre una base con datos.
- Borrar la D1, `backups/`, `.dev.vars` o `.wrangler/`.
- Cambiar secretos de producción.
- Desplegar o hacer commit si el usuario no lo ha pedido.
- Activar WhatsApp en producción.
