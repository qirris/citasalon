# Normas de código

## Lenguaje y estilo

- TypeScript estricto (`tsconfig.json`: `strict`, imports con extensión `.ts`, módulos ES2022).
- Sin comentarios en el código salvo que el usuario los pida explícitamente (regla del usuario).
- Nombres en español para textos visibles; identificadores en inglés (convención del código existente).
- Sin frameworks: seguir el estilo del proyecto (plantillas de string para HTML, helpers pequeños).
- Mantener el formato existente: sin formateadores, sin retoques cosméticos de ficheros no relacionados.

## Reglas de compatibilidad

- NO romper el bot existente (`bot.ts`, `db.ts`, `time.ts`, `whatsapp.ts`, `reminders.ts` son código en producción con usuarios reales potenciales).
- Si se cambia un módulo compartido, revisar todos sus consumidores (`grep` del símbolo).
- Los cambios de esquema D1 son aditivos (`CREATE TABLE IF NOT EXISTS` / nuevas columnas con valores por defecto); nunca alterar columnas existentes sin plan de migración.
- `test/e2e.mjs` es la especificación del panel: no "arreglar" la prueba cambiando expectativas sin que el usuario lo pida.

## Paneles HTML

- Puro HTML + CSS inline en `<style>`; prohibido `<script>` (lo verifica el e2e).
- Escapear SIEMPRE contenido dinámico con `esc()` (nombres, notas, teléfonos, mensajes de error…).
- CSP en todas las respuestas HTML: `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`.
- Tiempos mostrados con rayita en dash "–" (U+2013): `17:00–18:30` (lo verifica el e2e).
- Errores de validación claros en español; códigos: 422 (datos), 409 (choque "solapa"), 404 (no existe), 401 (auth), 429 (bloqueo), 303 (éxito con `?ok=`).

## Teléfonos

- Siempre normalizados con `normalizePhone` (`phone.ts`) al GUARDAR (panel y webhook). Mostrar con `displayPhone`.
- Ejemplos: `600 111 222` → `+34600111222`; `34600111222` → `+34600111222`; vacío permitido; basura → null (error en panel, fallback al original en webhook).

## Fechas y horas

- Usar SIEMPRE las utilidades de `time.ts` (fechas de pared). No calcular horas con timestamps de sistema.
- Validar entradas con `isValidDay` / `isValidTime`.

## Consultas SQL

- Solo SQL parametrizado (`.bind(...)`). Nunca interpolación de valores.
- `LIKE` con `ESCAPE '\'` y escape de `%_` (ya implementado en `db.searchAppointments`).

## Después de cada cambio

- `npm run check` obligatorio; e2e si se tocó panel/bot/disponibilidad (ver `PRUEBAS.md`).
- Actualizar `memoria.md`.
