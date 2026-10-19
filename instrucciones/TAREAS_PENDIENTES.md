# Tareas pendientes

Estado: proyecto funcional y desplegado; lo que queda depende de decisiones del usuario.

## En espera de decisión del usuario

1. **Activar WhatsApp en producción** (el usuario ha dicho explícitamente que NO por ahora):
   - `npx wrangler secret put WHATSAPP_TOKEN` (token EAA… de Meta; sin él el bot está en "modo consola").
   - `npx wrangler secret put APP_SECRET` (validación de firma de webhooks; recomendado).
   - En Meta: URL de devolución `https://<tu-worker>.workers.dev/webhook`, token de verificación `<VERIFY_TOKEN_DE_PRUEBA>`.
2. **Datos reales del salón**: `wrangler.jsonc` tiene valores de ejemplo ("Peluqueria Ejemplo", "Calle Ejemplo 1", "600 000 000", `WHATSAPP_NUMBER=<NUMERO_DE_PRUEBA>` ficticio, `WHATSAPP_PHONE_ID` de ejemplo). Cambiar y redeploy; el nombre/dirección/teléfono/servicios/horarios se pueden ajustar también desde `/admin/ajustes`.
3. **Activar el backup automático**: añadir en GitHub los secretos `CLOUDFLARE_API_TOKEN` (token de Cloudflare con permiso D1) y `CLOUDFLARE_ACCOUNT_ID` (`<ACCOUNT_ID>`); luego el workflow `.github/workflows/backup.yml` funciona solo (diario 03:00 UTC) o a mano desde *Actions* → *Backup D1* → *Run workflow*.

## Opcionales / mejora continua

- Revisión visual de los paneles: **hecha** (capturas con Edge headless + revisión del HTML/CSS generado; ver "Hecho recientemente"). Si quieres verlo tú: `npm run dev` y abre `http://127.0.0.1:8787`.

## Hecho recientemente (no repetir)

- [x] Módulos `auth.ts`, `config.ts`, `availability.ts`, `phone.ts`, `panels.ts`.
- [x] Rutas `/admin`, `/recepcion`, `/qr` + auditoría + seguridad (CSRF, bloqueo, CSP).
- [x] `npm run check` limpio; e2e 70/70.
- [x] D1 de producción creada (id `<DATABASE_ID>`) + esquema.
- [x] Worker publicado; secretos de panel/subida subidos (valores en manos del usuario).
- [x] Sistema de memoria (`memoria.md`, `AGENTS.md`, `instrucciones/`).
- [x] Sistema de memoria global de el equipo de desarrollo (skill + comando + AGENTS.md global).
- [x] Repositorio git inicializado (commit `3b69ee1`); README actualizado con paneles, pruebas y sistema de memoria (commit `b244c3a`).
- [x] Subido a GitHub: https://github.com/tu-usuario/citasalon (privado, renombrado desde citasalon).
- [x] Backup de D1: `npm run backup` (exporta a `backups/backup.sql`, carpeta fuera de git por privacidad).
- [x] Backup automático: workflow `.github/workflows/backup.yml` (diario 03:00 UTC + manual) que exporta la D1 remota y sube el resultado como artefacto (30 días, nunca al repo); falta solo que el usuario añada los secretos de GitHub.
- [x] Rate-limit por sesión e IP en todos los paneles (tabla `rate_limits`, 120/min sesión, 60/min IP, 429 con Retry-After); esquema aplicado a D1 remoto y desplegado.
- [x] Revisión visual de los paneles: mejoras de CSS (scroll lateral, contraste del subtítulo, `aria-label` en el selector de fecha) y bug corregido (nombre/dirección/teléfono de Ajustes con comillas sobrantes); +2 guardas de regresión e2e (60/60); desplegado (versión `ac97fb1e`).
- [x] Informes por periodo (`/admin/informes`, solo admin): citas, canceladas, ingresos estimados y horas reservadas, desglose por peluquero/servicio; export CSV (`/admin/informes.csv`); +4 pruebas e2e (64/64); desplegado (versión `d65501c1`).
- [x] Horarios por peluquero: horario semanal propio y vacaciones por peluquero (el bot y los paneles lo respetan); +6 pruebas e2e (70/70).
- [x] CI en GitHub Actions (`.github/workflows/ci.yml`): tipos + e2e en cada push/PR/manual.
- [x] Plantillas de datos del salón en `datos-salon/` (`LEEME.md`, `01-salon.md`, `02-peluqueros.md`, `03-servicios.md`).
