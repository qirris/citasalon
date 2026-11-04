# CitaSalón — Gestión de citas por WhatsApp para salones

Sistema completo para que los clientes de una peluquería reserven, consulten, reprogramen y cancelen sus citas desde WhatsApp, con paneles web de administración y recepción. Corre en Cloudflare Workers sin servidor propio, con base de datos D1, cola de mensajes y copias de seguridad cifradas.

**Stack:** TypeScript · Cloudflare Workers · D1 (SQLite) · Queues · WhatsApp Cloud API (Meta) · HTML server-side · GitHub Actions · PowerShell.

```
Cliente ──WhatsApp──► Meta ──webhook──► Cloudflare Worker ──► D1 (citas)
                                            │
                                            └─ cron cada 10 min: recordatorios 24 h + limpieza
```

---

## Qué hace cada archivo

### `src/index.ts`
Punto de entrada del Worker. Gestiona:
- **`/webhook`** — recibe los mensajes de WhatsApp que envía Meta, los procesa y responde.
- **Rutas públicas** — `/health`, `/manifest.json`, iconos PWA, `/qr-recepcion` y delegación a los paneles.
- **Cron cada 10 min** — lanza los recordatorios y limpia datos antiguos de la base de datos.

### `src/bot.ts`
Lógica principal del bot. Interpreta lo que escribe el cliente (texto libre o botones) y decide qué responder. Flujo de reserva: menú, servicio, **elección de peluquero**, fecha, hora, nombre y confirmación. También gestiona consulta, cancelación y reprogramación de citas propias.

### `src/db.ts`
Todas las operaciones con la base de datos D1: crear, buscar, actualizar, cancelar y borrar citas; sesiones; idempotencia de mensajes; auditoría; rate-limit y limpieza.

### `src/reminders.ts`
Busca las citas de las próximas 24 horas y envía un recordatorio por WhatsApp. Solo recuerda citas reservadas con más de 24 horas de antelación y que tienen teléfono.

### `src/whatsapp.ts`
Funciones para enviar mensajes a través de la API de WhatsApp (Meta Graph API): texto libre, mensajes con botones, listas y plantillas. Sin token funciona en **modo consola**.

### `src/availability.ts`
Calcula los huecos libres de un día teniendo en cuenta las citas existentes, el horario general del salón, el horario propio de cada peluquero, sus ausencias y los días cerrados.

### `src/config.ts`
Carga y guarda la configuración del salón desde la tabla `settings`: nombre, dirección, teléfono, servicios, peluqueros, horarios, ausencias y reglas de reserva.

### `src/time.ts`
Utilidades de fechas y horas «de pared» (los campos UTC representan la hora local del salón): formatear, sumar minutos, validar fechas, calcular el día de la semana, etc.

### `src/types.ts`
Tipos TypeScript compartidos: `Appt`, `Service`, `Settings`, `Env`, `Role`, etc.

### `src/panels.ts`
Todas las rutas de los paneles web (`/admin`, `/recepcion`, `/qr`): login, agenda, CRUD de citas, buscador, servicios, peluqueros, horarios, ausencias, ajustes, historial de auditoría e informes (ingresos por periodo + export CSV). HTML generado en servidor.

### `src/auth.ts`
Autenticación de los paneles: cookies de sesión firmadas con HMAC-SHA256, comparación en tiempo constante de contraseñas y tokens, y comprobación de `Origin`.

### `src/phone.ts`
Normalización de teléfonos españoles a formato `+34…` (usada en el panel y en el webhook de WhatsApp).

### `src/pwa.ts`
Manifest PWA, iconos y página del cartel QR de recepción.

---

## Paneles web

Además del bot, el Worker sirve tres rutas web:

| Ruta | Rol | Qué hace |
|---|---|---|
| `/admin` | admin | Agenda diaria con estadísticas y filtro por peluquero, crear/editar/cancelar/restaurar/borrar citas, buscador, servicios, peluqueros (horarios y ausencias), ajustes completos, historial de auditoría e informes con ingresos y export CSV |
| `/recepcion` | staff o admin | Agenda, crear/editar/cancelar citas, servicios y personal. No puede borrar, restaurar, ver ajustes ni historial |
| `/qr` | público | Cartel con código QR hacia `wa.me` con los datos del salón |

Los paneles son formularios HTML + redirecciones 303. **No son una SPA**: la regla es HTML server-side, con **dos únicas excepciones de JavaScript inline estático**, cada una en su propia página y con su propia CSP:

- **Selector de huecos** del formulario de cita (`CSP_FORM`): consulta `/slots` para mostrar los horarios libres.
- **Refresco automático de la agenda** (`CSP_AGENDA`): consulta `/agenda-json` cada 1/2/5/10 minutos.

El resto de páginas no permite JavaScript. Cualquier página nueva con JS debe tener su propia CSP con el `connect-src` necesario y escapar siempre los datos que vengan de clientes.

Seguridad: cookies `HttpOnly`/`SameSite=Strict`, bloqueo de login tras 5 fallos, rate-limit por sesión e IP (120/min y 60/min, ventana de 60 s), CSRF por comprobación de `Origin`, CSP restrictiva y SQL parametrizado.

Las contraseñas de los paneles se configuran como secretos (`ADMIN_PASSWORD` y `STAFF_PASSWORD`) con `npx wrangler secret put`.

---

## Pruebas

```powershell
npm run check   # TypeScript en modo estricto (sin emitir)
npm run dev     # terminal 1: servidor local en el puerto 8787
npm run e2e     # terminal 2: prueba de extremo a extremo
npm run backup  # exporta una copia de la D1 de producción a backups/backup.sql
```

> **`npm run e2e` borra las tablas de la D1 local antes de empezar.** No lo ejecutes si esa base contiene datos que quieres conservar.

`test/e2e.mjs` es la especificación real del panel: cubre el bot, login y roles, agenda, CRUD completo, conflictos de horario, validaciones, ajustes, horarios y vacaciones por peluquero, servicios, historial, informes (ingresos y CSV), CSP, bloqueo de login y rate-limit por sesión e IP.

Estado de las pruebas:

- `npm run check`: limpio tras los últimos cambios locales (2026-10-26).
- Último resultado de `npm run e2e`: **189/189, 0 fallidas, exit 0 (2026-10-30)**, contra `wrangler dev --local` y la D1 local, incluida la reprogramación desde «Mis citas» (14/14).
- La suite **no se ha vuelto a ejecutar** después de los cambios locales del 2026-10-26 (borra tablas locales; el usuario lo prohibió). `test/e2e.mjs` está adaptado a los cambios, pero sin ejecutar.
- Hay salidas antiguas con otras cifras (70, 85, 106) que corresponden a versiones anteriores del test. No son comparables. Ver `memoria.md` §8.

## Integración continua

`.github/workflows/ci.yml` ejecuta `npm run check` y `npm run test:all` en cada push a `master`, en pull requests y a mano (pestaña *Actions* → *CI* → *Run workflow*), además de validar la sintaxis de `setup.ps1`. No ejecuta el e2e porque este borra tablas de la D1 local. No necesita secretos: usa valores de prueba locales.

---

## Documentación

| Documento | Para qué |
|---|---|
| `docs/INDICE_DOCUMENTACION.md` | Índice completo y orden de lectura. |
| `docs/PUESTA_EN_MARCHA.md` | Poner el sistema en marcha en un salón nuevo, paso a paso. |
| `docs/CONFIGURACION_PELUQUERIA_REAL.md` | Datos, decisiones y checklist para una peluquería real. |
| `docs/AUDITORIA_TEXTOS_FIJOS.md` | Qué textos se personalizan y cuáles son comunes. |
| `docs/RUTAS_Y_API.md` | Rutas, permisos y endpoints JSON. |
| `docs/MODELO_DE_DATOS.md` | Tablas, estados, retención y valores por defecto. |
| `docs/OPERACION_Y_DESPLIEGUE.md` | Comandos, despliegue, backups y diagnóstico. |

En `datos-salon/` hay plantillas listas para rellenar (tipo de peluquería, nombre/dirección/teléfono, peluqueros con horarios y vacaciones, y servicios con duración y precio). Los datos se copian luego en *Ajustes* del panel.

---

## Copia de seguridad automática

`.github/workflows/backup.yml` está preparado para exportar la D1 de producción cada día a las 03:00 UTC (y a mano desde la pestaña *Actions*) y guardar **solo un artefacto cifrado** (`.sql.enc`) durante 30 días. **Todavía no hay ninguna ejecución satisfactoria confirmada**: los secretos de GitHub siguen pendientes de configurar y no se ha generado ningún artefacto válido desde Actions.

Para activarlo hacen falta tres secretos de repositorio (`Settings → Secrets and variables → Actions`): `CLOUDFLARE_API_TOKEN` (token de Cloudflare con permiso propuesto **Account > D1 > Read**, pendiente de confirmar con la primera ejecución real), `CLOUDFLARE_ACCOUNT_ID` (ID de la cuenta donde está `citasalon`) y `BACKUP_ENCRYPTION_KEY` (contraseña larga y aleatoria, distinta de cualquier otra; por ejemplo `openssl rand -base64 32`). El workflow comprueba que los tres existen, exporta la base `citasalon`, valida `backups/backup.sql` ejecutándolo en una SQLite en memoria, lo cifra con AES-256-GCM, verifica el descifrado comparándolo con el original y solo entonces sube el artefacto. El SQL en claro se borra siempre al finalizar, incluso si falla un paso.

**Nunca se sube el SQL sin cifrar.** El procedimiento de descifrado y restauración aislada está en `docs/OPERACION_Y_DESPLIEGUE.md`.

---

## Notas de desarrollo

El proyecto mantiene documentación interna para conservar el contexto entre sesiones:

- **`memoria.md`** — estado, decisiones, pruebas verificadas, pendientes e historial. Se actualiza tras cada avance importante.
- **`AGENTS.md`** — punto de entrada: orden de lectura y reglas de trabajo.
- **`instrucciones/`** — reglas permanentes por tema: arquitectura, normas de código, seguridad, pruebas, decisiones y tareas pendientes.

Los secretos nunca se guardan en estos archivos.

---

## Variables de entorno necesarias

Copia `.dev.vars.example` como `.dev.vars` para desarrollo local.

| Variable | Qué es | Necesaria |
|---|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel `/admin` | Sí |
| `STAFF_PASSWORD` | Contraseña del panel `/recepcion` | Sí |
| `SESSION_SECRET` | Secreto para firmar las sesiones de los paneles (32+ caracteres) | Sí |
| `VERIFY_TOKEN` | Token para verificar el webhook con Meta | Para el bot |
| `WHATSAPP_TOKEN` | Token de acceso a la API de WhatsApp | Para enviar mensajes reales |
| `APP_SECRET` | Clave secreta de la app de Meta (valida la firma de cada webhook) | Recomendado |

Sin `WHATSAPP_TOKEN` el bot funciona en **modo consola**: registra en los logs de Cloudflare lo que habría enviado, sin conectarse a WhatsApp.

Las variables no secretas (nombre del salón, dirección, teléfono, zona horaria, número de WhatsApp…) están en `wrangler.jsonc` y se pueden sobrescribir desde `/admin/ajustes`.

---

## Arrancar en local

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npx wrangler d1 execute citasalon --local --file=schema.sql
npm run dev   # arranca en http://localhost:8787
```

Sin token de WhatsApp el bot no envía nada: escribe en la consola lo que habría enviado.

## Publicar en Cloudflare

```powershell
npx wrangler deploy
```

O haz doble clic en `instalar.bat` para el proceso guiado completo.

> Un Worker nuevo con una D1 vacía necesita que se aplique `schema.sql`; el despliegue no lo hace solo. Ver `docs/PUESTA_EN_MARCHA.md` §3.

## Estado del proyecto

- El sistema está completo y probado; el detalle de la última verificación está en `memoria.md` §2 y §8.
- Cada instalación usa **su propio** Worker, D1 y cola. La URL, el `database_id` y el Phone ID van en `wrangler.jsonc`, o en `wrangler.local.jsonc` (fuera de Git) si no quieres publicarlos.
- Este repositorio **no contiene** datos de ninguna cuenta real de Cloudflare, ni teléfonos, ni tokens, ni contraseñas.
- Para desplegarlo en tu cuenta: `docs/PUESTA_EN_MARCHA.md` o `instalar.bat` / `setup.ps1`.
