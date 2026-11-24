# Instrucciones generales (punto de entrada)

Reglas de trabajo permanentes en este proyecto. El usuario trabaja en **español**: respuestas, UI y documentación en español.

## Procedimiento al empezar cada sesión

Antes de tocar nada:

1. Leer `memoria.md` (raíz) — estado real, decisiones, pendientes.
2. Leer este archivo.
3. Consultar los documentos relacionados con la tarea:
   - **Reglas** (`instrucciones/`): `ARQUITECTURA.md`, `NORMAS_DE_CODIGO.md`, `SEGURIDAD.md`, `PRUEBAS.md`, `DECISIONES.md`, `TAREAS_PENDIENTES.md`.
   - **Guías** (`docs/`): `INDICE_DOCUMENTACION.md`, `PUESTA_EN_MARCHA.md`, `CONFIGURACION_PELUQUERIA_REAL.md`, `AUDITORIA_TEXTOS_FIJOS.md`, `RUTAS_Y_API.md`, `MODELO_DE_DATOS.md`, `OPERACION_Y_DESPLIEGUE.md`.
4. Contrastar la memoria con el código real (si difieren, manda el código y actualizar la memoria).
5. Continuar desde el último estado conocido; no rehacer trabajo terminado.

## Procedimiento al terminar cada tarea

1. Ejecutar las pruebas que corresponda (`npm run check`; e2e si toca — ver `PRUEBAS.md`).
2. Actualizar `memoria.md` (secciones 2, 5, 6, 8, 9, 11 según aplique).
3. Guardar cualquier instrucción nueva del usuario en el `.md` correspondiente.
4. Actualizar `instrucciones/TAREAS_PENDIENTES.md`.
5. Confirmar al usuario brevemente qué se ha hecho y dónde queda documentado.

## Reglas duras

- No inventar resultados, pruebas ni cambios. No marcar como terminado algo no verificado.
- No guardar contraseñas, tokens, claves ni secretos en ningún `.md` (ni siquiera los de prueba si se usan en producción). Los secretos: Cloudflare (producción) o `.dev.vars` (local, no commiteable).
- No borrar decisiones ni documentación previa sin dejar constancia del motivo.
- No romper el bot de WhatsApp existente: los cambios deben ser compatibles.
- `test/e2e.mjs` es la especificación del panel: si se toca el panel, se ejecuta el e2e completo.
- El panel es HTML server-side + formularios + redirecciones 303. Solo dos scripts inline estáticos, en sus propias páginas y con su propia CSP: el selector de huecos del formulario de cita (`CSP_FORM`, con `connect-src 'self'` para `/slots`) y el refresco automático de la agenda (`CSP_AGENDA`, con `connect-src 'self'` para `/agenda-json`). El resto de páginas no permite JS. `test/e2e.mjs` es la especificación.
- No ejecutar operaciones destructivas (borrar BD, ficheros, secretos) sin autorización explícita.
- Arquitectura actual: una peluquería = un Worker + una D1 + secretos propios. No hay multi-tenant; no compartir una D1 entre salones.
- WhatsApp en producción sigue desactivado hasta que el usuario lo pida (ver pendientes).

## Convención de archivos de memoria

- `memoria.md`: memoria viva del proyecto (única fuente de estado).
- `instrucciones/*.md`: reglas permanentes organizadas por tema. No duplicar contenido; enlazar.
- `AGENTS.md`: mapa de entrada del proyecto; resume el orden de lectura y las reglas principales. No meter en él detalles que ya estén en la memoria.
- Si el usuario da una instrucción permanente, guardarla en el documento correspondiente en el momento.

## Presentación del proyecto (2026-11-24)

- Para el README y el portfolio, el propietario quiere capturas reales de cómo se ve la aplicación. Utilizar la interfaz ejecutada en navegador con datos ficticios y documentar su procedencia; no sustituirla por imágenes generadas por IA ni mockups inventados.
