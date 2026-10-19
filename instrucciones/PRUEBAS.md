# Pruebas

## Comandos

```bash
npm run check   # tsc --noEmit. Obligatorio tras CUALQUIER cambio en src/.
npm run e2e     # limpia las tablas de la D1 local y ejecuta test/e2e.mjs (requiere npm run dev en otra terminal, puerto 8787)
```

## Procedimiento local completo

1. `npx wrangler d1 execute citasalon --local --file=schema.sql` (primera vez o si se cambió el esquema).
2. `npm run dev` → servidor en `http://localhost:8787` (lee `.dev.vars`).
3. `npm run e2e` → objetivo: **64/64 pruebas correctas, 0 fallidas**.

Notas:
- El e2e borra las tablas locales al empezar (no usa la BD de producción).
- El e2e usa los mismos secretos que `.dev.vars` (contraseñas `admin-pass-1` y `staff-pass-1`).
- Cada mensaje al bot espera 350 ms; la prueba tarda ~1-2 min.

## Qué cubre el e2e

- Básicos: `/health`, verificación del webhook de Meta, firma correcta/inexistente/falsa, `/qr`.
- Bot: reserva con botones, con texto libre, choque de horario (3.º cliente rechazado), cancelación propia, intento de cancelar cita ajena.
- Login: 401 con contraseña mala, 303 + cookie con la buena, roles (staff no ve `/admin`, `/admin/ajustes`, `/admin/historial`), cookie falsificada rechazada, CSRF por Origin → 403, bloqueo 429 tras 5 fallos, logout.
- Paneles: visibilidad de citas, teléfono normalizado, crear/editar sin solapes, choque → 409 "solapa", datos inválidos → 422 con mensajes concretos, confirmación antes de cancelar, borrar solo admin (404 para staff), ver canceladas solo admin, restaurar/borrar.
- Buscador: encuentra por nombre; inyección SQL → "No hay citas".
- Ajustes: validación ("Servicio, línea 1", "tramo válido"), guardado y efecto inmediato en el bot.
- Seguridad: historial completo con los 6 tipos de acción y los 3 actores, sin `<script>`, cabecera CSP con `default-src 'none'`.
- Rate-limit: 429 tras superar 120 peticiones/minuto con una sesión; 429 en `/qr` tras superar el límite por IP (sin sesión).
- Regresión (revisión visual): tras guardar Ajustes, el nombre no lleva comillas sobrantes ni en el panel ni en el cartel QR (guarda contra el bug de `config.ts`).
- Informes: Recepción no accede a `/admin/informes`; el informe suma bien los ingresos del periodo y desglosa por servicio; `/admin/informes.csv` devuelve `text/csv` con las citas del periodo.

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

- 2026-10-19: check limpio y e2e 64/64 en local (incl. informes/CSV y las 2 guardas de regresión de la revisión visual); verificación en vivo de producción correcta; rate-limit verificado en producción (las 2 pruebas remotas pasan). El e2e completo NO se puede ejecutar contra producción: el worker remoto no tiene secretos de panel (decisión del usuario de no activar WhatsApp aún). Detalle en `memoria.md` sección 8.
