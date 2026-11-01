# Pruebas

## Comandos

```bash
npm run check   # tsc --noEmit. Obligatorio tras CUALQUIER cambio en src/.
npm run test:notices   # pruebas simuladas de los avisos de cancelación/actualización (sin Meta)
npm run e2e     # limpia las tablas de la D1 local y ejecuta test/e2e.mjs (requiere npm run dev en otra terminal, puerto 8787)
```

## Procedimiento local completo

1. `npx wrangler d1 execute citasalon --local --file=schema.sql` (primera vez o si se cambió el esquema).
2. `npm run dev` → servidor en `http://localhost:8787` (lee `.dev.vars`).
3. `npm run e2e` → objetivo: **suite completa en verde**. Último resultado: **189/189, 0 fallidas, exit 0 (2026-10-30)**, contra `wrangler dev --local` y la D1 local. Incluye el bloque de **reprogramación desde «Mis citas»** con sus **14/14 aserciones**, además de las guardas de PWA/QR, el bloqueo de login aislado, las validaciones FASE 1, las pruebas de horarios por peluquero y la restauración `GET`/`POST`. La suite **borra las tablas de la D1 local** y requiere autorización.

Notas:
- El e2e borra las tablas locales al empezar (no usa la BD de producción).
- El e2e usa los mismos secretos que `.dev.vars` (contraseñas `admin-pass-1` y `staff-pass-1`).
- Cada mensaje al bot espera 350 ms; la prueba tarda ~1-2 min.

## Qué cubre el e2e

- Básicos: `/health`, verificación del webhook de Meta, firma correcta/inexistente/falsa, `/qr`.
- PWA y QR: `/manifest.json` (200, tipo, JSON válido, `start_url`/`scope`/`display` e iconos declarados), `/icon-192.png` y `/icon-512.png` (200, `image/png`, firma PNG e IHDR con dimensiones legibles) y `/qr-recepcion` (200, HTML UTF-8, título/cabecera/SVG, host de la petición y aviso de contraseña). Los iconos actuales son placeholders de 1×1 px: se valida que el PNG sea legible, no que mida 192/512.
- Bot: reserva con botones, con texto libre, choque de horario (3.º cliente rechazado), cancelación propia, intento de cancelar cita ajena.
- Login: 401 con contraseña mala, 303 + cookie con la buena, roles (staff no ve `/admin`, `/admin/ajustes`, `/admin/historial`), cookie falsificada rechazada, CSRF por Origin → 403, bloqueo 429 tras 5 fallos, logout. La prueba de bloqueo usa `CF-Connecting-IP: 203.0.113.77` para no dejar bloqueada la IP local; la aserción de 429 se mantiene. Validaciones FASE 1: fecha pasada, hora no múltiplo de `slotMinutes` (rechazadas 422), hora válida aceptada, `maxDaysAhead` aplicado en panel (422 si supera el límite). Servicios adaptados al estado tras Ajustes.
- Paneles: visibilidad de citas, teléfono normalizado, crear/editar sin solapes, choque → 409 "solapa", datos inválidos → 422 con mensajes concretos, confirmación antes de cancelar, borrar solo admin (404 para staff), ver canceladas solo admin, restaurar/borrar.
- Buscador: encuentra por nombre; inyección SQL → "No hay citas".
- Ajustes: validación ("Servicio, línea 1", "tramo válido"), guardado y efecto inmediato en el bot.
- Seguridad: historial completo con los 6 tipos de acción y los 3 actores, sin `<script>`, cabecera CSP con `default-src 'none'`.
- Rate-limit: 429 tras superar 120 peticiones/minuto con una sesión; 429 en `/qr` tras superar el límite por IP (sin sesión).
- Regresión (revisión visual): tras guardar Ajustes, el nombre no lleva comillas sobrantes ni en el panel ni en el cartel QR (guarda contra el bug de `config.ts`).
- Informes: Recepción no accede a `/admin/informes`; el informe suma bien los ingresos del periodo y desglosa por servicio; `/admin/informes.csv` devuelve `text/csv` con las citas del periodo.
- Horarios por peluquero: se guardan y se muestran en Ajustes; un peluquero fuera de su horario o de vacaciones no acepta la cita desde el panel (422); el bot ni siquiera ofrece la hora fuera del horario de los peluqueros y sí reserva dentro.

## Integración continua

`.github/workflows/ci.yml` reproduce el procedimiento local (Node 22 + Ubuntu): `npm ci`, `npm run check`, crea un `.dev.vars` de prueba, aplica `schema.sql` a la D1 local, arranca `wrangler dev` en segundo plano, espera a `/health` y ejecuta `npm run e2e`. Se lanza en cada push a `master`, en PRs y a mano (*Actions* → *CI* → *Run workflow*).

## Verificación en producción

Tras un deploy:

```powershell
Invoke-WebRequest -UseBasicParsing "https://<tu-worker>.workers.dev/health"
```

Comprobar también `/qr` (200 + `<svg`) y `/admin` (200 + "Contraseña" + CSP). El login se puede probar con `POST /admin/login` y la contraseña real de Cloudflare (esperar 303).

## Cuándo ejecutar e2e

- Siempre que se toque: `panels.ts`, `bot.ts`, `db.ts`, `availability.ts`, `config.ts`, `auth.ts`, `index.ts` o `test/e2e.mjs`.
- Cambios solo cosméticos de CSS/textos sin efecto funcional: basta `npm run check` (pero si hay duda, e2e).

## Resultados verificados

- 2026-10-19: check limpio y e2e 70/70 en local (incl. informes/CSV, horarios por peluquero y las 2 guardas de regresión de la revisión visual); verificación en vivo de producción correcta; rate-limit verificado en producción (las 2 pruebas remotas pasan). El e2e completo NO se puede ejecutar contra producción: el worker remoto no tiene secretos de WhatsApp (decisión del usuario de no activar WhatsApp aún). Detalle en `memoria.md` sección 8.
- 2026-10-23: `npm run check` y `node --check test/e2e.mjs` limpios. `npm run e2e` → **154/154** (resultado de esa ronda): guardas PWA/QR, aislamiento del bloqueo de login, validaciones FASE 1 corregidas y `maxDaysAhead` aplicado en `validate()` del panel, y pruebas de servicios/horarios por peluquero. Cobertura añadida sin debilitar aserciones.
- 2026-10-26: `npm run check` limpio tras los cambios locales (paso de peluquero, servicios activables, agenda, idempotencia, UI). El e2e completo **no se ejecutó** (borra tablas locales). Las verificaciones de esa ronda son aisladas: 42/42 + 29/29 + 8/8, 33/33, 35/35, 47/47 API, 18/18 navegador real y 6/6 XSS. Detalle en `memoria.md` §8.
- 2026-10-29: reorganización documental y de archivos; **no** se ejecutó e2e ni el servidor de desarrollo. Comprobaciones seguras: `npm run check`, `node --check test/e2e.mjs` y revisión de referencias. El resultado está en `memoria.md` §8.

- 2026-10-30: **`npm run e2e` autorizado tras corregir el conteo de tarjetas → 189/189, 0 fallidas, exit 0**, con `wrangler dev --test-scheduled --local` en `127.0.0.1:8787` y la D1 local (`env.DB` en `Mode: local`; nunca producción). Se cambió `split('<article class="appt-card')` por `split('<article class="appt-card">').slice(1)` en `test/e2e.mjs` (descarta la plantilla JS del refresco y el trozo anterior con la fila de tabla). El bloque de reprogramación pasa sus **14/14 aserciones**, incluida «sin duplicados». Todo el resto en verde: cancelación desde «Mis citas» y hueco libre, reservas, informe de **80 €**, restauración `GET`/`POST`, permisos admin/recepción, CSRF (`403`), hueco ocupado (`409`), validaciones (`422`) y PWA/QR. `git status --short` 35 antes y 35 después; 0 errores 500. Detalle en `memoria.md` §8.
- 2026-10-30: **`npm run e2e` autorizado tras corregir el selector → 188/189, 1 fallida, exit 1**: se corrigieron las dos apariciones de `name="service_id">` a `name="service_id"[^>]*>` (sin tocar `src/`); el bloque ejecutó sus 14 aserciones y 13 pasaron. Fallaba solo «sin duplicados», por el conteo de tarjetas (defecto del test). Detalle en `memoria.md` §8.
- 2026-10-30: **`npm run e2e` autorizado → 175/177, 2 fallidas, exit 1** (primera ejecución con el caso nuevo, antes de corregir el selector `name="service_id">`): fallaban solo sus 2 guardas, la segunda en cascada, y las 12 aserciones del flujo no se ejecutaban. No se modificó el test en esa ronda. Detalle en `memoria.md` §8.
- 2026-10-30: **`npm run e2e` autorizado → 175/175, 0 fallidas, exit 0**, con `wrangler dev --test-scheduled --local` en `127.0.0.1:8787` y la D1 local. Además, reprogramación verificada aparte (cita 33, 10:00 → 16:00, auditoría `whatsapp/editar`). Los `401/190` de WhatsApp del log son del envío real por Meta y no afectan a la lógica local. Detalle en `memoria.md` §8.

> Nota sobre cifras antiguas: 70/70, 85/85, 106, 154/154, 171/175, 175/175, 175/177 y 188/189 corresponden a ejecuciones y versiones anteriores de `test/e2e.mjs`. La cifra vigente es **189/189, 0 fallidas, exit 0 (2026-10-30)**, incluida la reprogramación (**14/14**).
