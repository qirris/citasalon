# Instrucciones generales (punto de entrada)

Reglas de trabajo permanentes en este proyecto. El usuario trabaja en **español**: respuestas, UI y documentación en español.

## Procedimiento al empezar cada sesión

Antes de tocar nada:

1. Leer `memoria.md` (raíz) — estado real, decisiones, pendientes.
2. Leer este archivo.
3. Consultar los documentos de `instrucciones/` relacionados con la tarea:
   - `ARQUITECTURA.md` — estructura y flujo de datos.
   - `NORMAS_DE_CODIGO.md` — estilo y convenciones.
   - `SEGURIDAD.md` — sesiones, secretos, CSP, validaciones.
   - `PRUEBAS.md` — cómo verificar cambios.
   - `DECISIONES.md` — por qué el código es así.
   - `TAREAS_PENDIENTES.md` — qué queda por hacer.
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
- El panel NO lleva JavaScript en el navegador (formularios HTML + redirecciones).
- No ejecutar operaciones destructivas (borrar BD, ficheros, secretos) sin autorización explícita.
- WhatsApp en producción sigue desactivado hasta que el usuario lo pida (ver pendientes).

## Convención de archivos de memoria

- `memoria.md`: memoria viva del proyecto (única fuente de estado).
- `instrucciones/*.md`: reglas permanentes organizadas por tema. No duplicar contenido; enlazar.
- `AGENTS.md`: mapa de entrada del proyecto; no meter en él detalles que ya estén en la memoria.
- Si el usuario da una instrucción permanente, guardarla en el documento correspondiente en el momento.
