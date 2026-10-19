# AGENTS.md — Peluquería Cloudflare (bot WhatsApp + paneles)

Proyecto en `C:\Users\<usuario>\Documents\NEGOCIOS\bot\citasalon` (si trabajas desde otro directorio, ir a esta carpeta: es la raíz real del proyecto).

Bot de reservas de peluquería por WhatsApp + paneles `/admin`, `/recepcion` y cartel `/qr`, en Cloudflare Worker con D1. TODO en español.

## ANTES DE TRABAJAR (obligatorio, en este orden)

1. Leer `memoria.md` (raíz): estado actual, decisiones, pruebas verificadas, pendientes e historial.
2. Leer `instrucciones/INSTRUCCIONES_GENERALES.md`.
3. Consultar el documento de `instrucciones/` que corresponda a la tarea:
   - `ARQUITECTURA.md` — módulos, flujo de datos, modelo de datos.
   - `NORMAS_DE_CODIGO.md` — estilo, compatibilidad, HTML de paneles, teléfonos, fechas.
   - `SEGURIDAD.md` — sesiones, secretos, CSP, webhooks.
   - `PRUEBAS.md` — comandos y procedimiento (`npm run check`, `npm run e2e`).
   - `DECISIONES.md` — por qué el código es así (no cambiar decisiones sin motivo).
   - `TAREAS_PENDIENTES.md` — qué queda por hacer y qué NO repetir.
   - `PUESTA_EN_MARCHA.md` — guía paso a paso para poner el sistema en marcha en un salón nuevo.
4. Comprobar el estado real del código y contrastarlo con la memoria. Si difieren: manda el código y actualiza `memoria.md`.
5. Revisar `instrucciones/TAREAS_PENDIENTES.md` y continuar desde el último estado conocido.

## Reglas duras (resumen; el detalle está en `instrucciones/`)

- Trabajar y responder SIEMPRE en español.
- NO romper el bot existente; cambios compatibles.
- El panel NO usa JavaScript en navegador (formularios + 303; lo exige `test/e2e.mjs`, que es la especificación).
- `npm run check` tras cualquier cambio en `src/`; e2e completo si se toca panel/bot/db/disponibilidad.
- NO guardar secretos, contraseñas ni tokens en ningún `.md`.
- NO inventar pruebas ni resultados; NO marcar terminado algo no verificado.
- WhatsApp en producción está DESACTIVADO a petición del usuario: no poner `WHATSAPP_TOKEN`/`APP_SECRET` ni configurar el webhook en Meta hasta que lo pida.
- Actualizar `memoria.md` tras cada avance importante (y antes de dar una tarea por terminada).
- Instrucciones permanentes nuevas del usuario: guardarlas en el `.md` correspondiente de `instrucciones/` en el momento.

## Estado rápido

- Producción: `https://<tu-worker>.workers.dev` (worker + D1 desplegados 2026-10-19).
- Última verificación: `npm run check` limpio; e2e **70/70**; salud/QR/admin comprobados en vivo; rate-limit activo en producción. Detalle en `memoria.md` secciones 8 y 11.
