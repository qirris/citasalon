# AGENTS.md — CitaSalón (bot WhatsApp + paneles)

Proyecto en la carpeta que contiene este archivo (es la raíz real del proyecto). El directorio padre es solo un contenedor.

Bot de reservas de peluquería por WhatsApp + paneles `/admin`, `/recepcion` y cartel `/qr`, en Cloudflare Worker con D1. TODO en español.

## ANTES DE TRABAJAR (obligatorio, en este orden)

1. Leer `memoria.md` (raíz): estado actual, decisiones, pruebas verificadas, pendientes e historial.
2. Leer `instrucciones/INSTRUCCIONES_GENERALES.md`.
3. Consultar el documento que corresponda a la tarea:
   - **Reglas de trabajo** (`instrucciones/`):
     - `INSTRUCCIONES_GENERALES.md` — punto de entrada y reglas duras.
     - `ARQUITECTURA.md` — módulos, flujo de datos, modelo de datos.
     - `NORMAS_DE_CODIGO.md` — estilo, compatibilidad, HTML de paneles, teléfonos, fechas.
     - `SEGURIDAD.md` — sesiones, secretos, CSP, webhooks.
     - `PRUEBAS.md` — comandos y procedimiento.
     - `DECISIONES.md` — por qué el código es así (no cambiar decisiones sin motivo).
     - `TAREAS_PENDIENTES.md` — qué queda por hacer y qué NO repetir.
   - **Guías para personas** (`docs/`):
     - `INDICE_DOCUMENTACION.md` — índice completo.
     - `PUESTA_EN_MARCHA.md` — puesta en marcha en un salón nuevo.
     - `CONFIGURACION_PELUQUERIA_REAL.md` — datos, decisiones y checklist de personalización.
     - `AUDITORIA_TEXTOS_FIJOS.md` — textos comunes vs. personalizables.
     - `RUTAS_Y_API.md`, `MODELO_DE_DATOS.md`, `OPERACION_Y_DESPLIEGUE.md` — referencia técnica.
4. Comprobar el estado real del código y contrastarlo con la memoria. Si difieren: manda el código y actualiza `memoria.md`.
5. Revisar `instrucciones/TAREAS_PENDIENTES.md` y continuar desde el último estado conocido.

El historial de cambios de `memoria.md` (§11) **no es fuente de verdad** para el código actual: explica el pasado y puede citar rutas o cifras antiguas.

## Reglas duras (resumen; el detalle está en `instrucciones/`)

- Trabajar y responder SIEMPRE en español.
- NO romper el bot existente; cambios compatibles.
- El panel es HTML server-side + formularios + 303. **Permitidos solo dos scripts inline estáticos, en sus propias páginas y con su propia CSP**: el selector de huecos del formulario de cita (`CSP_FORM`, necesita `connect-src 'self'` para pedir `/slots`) y el refresco automático de la agenda (`CSP_AGENDA`, con `connect-src 'self'` para `/agenda-json`). El resto de páginas no permite JS. `test/e2e.mjs` es la especificación.
- `npm run check` tras cualquier cambio en `src/`; e2e completo si se toca panel/bot/db/disponibilidad, **solo con autorización** (`npm run e2e` borra las tablas locales).
- NO guardar secretos, contraseñas ni tokens en ningún `.md`.
- Arquitectura actual: **una peluquería = un Worker + una D1 + secretos propios**. No hay multi-tenant; no compartir una D1 entre salones.
- NO inventar pruebas ni resultados; NO marcar terminado algo no verificado.
- WhatsApp en producción está DESACTIVADO: no poner `WHATSAPP_TOKEN`/`APP_SECRET` ni configurar el webhook en Meta sin que se pida expresamente. Los secretos nunca van al repositorio.
- Actualizar `memoria.md` tras cada avance importante (y antes de dar una tarea por terminada).
- Instrucciones permanentes nuevas del usuario: guardarlas en el `.md` correspondiente de `instrucciones/` en el momento.
- No tocar `.dev.vars`, `.wrangler/`, `node_modules/`, `backups/`, `.git/`, bases de datos locales ni secretos. No hacer commit, push ni deploy sin que el usuario lo pida.

## Estado rápido

- Despliegue: cada instalación crea su propio Worker, D1 y cola (ver `docs/PUESTA_EN_MARCHA.md`). La URL y los IDs van en `wrangler.jsonc` o en `wrangler.local.jsonc` (fuera de Git); el repositorio no guarda datos de ninguna cuenta real.
- Cambios locales sin commit ni deploy (2026-10-26): paso de peluquero en el bot, servicios activables, bloque «Próximas citas», idempotencia por `wamid`, filtro de agenda por peluquero, retirada del botón manual, corrección de CSP/huecos/alta de peluquero, estado `done`, modernización visual. `npm run check` limpio tras todos los cambios.
- `npm run e2e` re-ejecutado el 2026-10-30: **última ejecución 189/189, 0 fallidas, exit 0** contra `wrangler dev --local` y la D1 local, incluida la **reprogramación desde «Mis citas» (14/14)**. Siguen corregidos los 4 fallos de la Fase 2 (cancelación desde «Mis citas», ingresos 80 €, navegación de `/admin`, mensaje de horarios) y pasa el resto de la suite. Para llegar al verde se corrigieron **dos defectos del propio test**, no del Worker: el selector `name="service_id">` → `name="service_id"[^>]*>` y el conteo de tarjetas `split('<article class="appt-card">').slice(1)` (el separador sin `>` casaba con la plantilla JS del refresco y el primer trozo incluía la fila de tabla). Ver `memoria.md` §8, §9 y §11.
- Documentación organizada el 2026-10-29: guías en `docs/`, reglas de trabajo en `instrucciones/` e historial cronológico en `memoria.md` §11.
