# Índice de documentación

Punto de partida para saber **qué documento leer** y **cuál manda** cuando hay diferencias.

## Orden de lectura recomendado

| Cuándo | Documento |
|---|---|
| Primera vez en el proyecto | `../README.md` |
| Antes de tocar código | `../AGENTS.md` → `../memoria.md` → `../instrucciones/INSTRUCCIONES_GENERALES.md` |
| Entender el estado real y lo verificado | `../memoria.md` |
| Entender la arquitectura y el modelo de datos | `ARQUITECTURA` en `../instrucciones/ARQUITECTURA.md`, `MODELO_DE_DATOS.md`, `RUTAS_Y_API.md` |
| Poner el sistema en marcha en un salón | `PUESTA_EN_MARCHA.md` |
| Recoger datos y decisiones de una peluquería real | `CONFIGURACION_PELUQUERIA_REAL.md` |
| Saber qué se puede personalizar y qué es texto fijo | `AUDITORIA_TEXTOS_FIJOS.md` |
| Operar, desplegar, hacer copias y diagnosticar | `OPERACION_Y_DESPLIEGUE.md` |
| Saber qué queda pendiente | `../instrucciones/TAREAS_PENDIENTES.md` |

## Documentos de esta carpeta (`docs/`)

| Archivo | Para qué sirve | Estado |
|---|---|---|
| `INDICE_DOCUMENTACION.md` | Este índice. | Vigente |
| `PUESTA_EN_MARCHA.md` | Secuencia técnica paso a paso para un salón nuevo. | Vigente |
| `CONFIGURACION_PELUQUERIA_REAL.md` | Datos a pedir, decisiones del propietario y checklist de personalización. | Vigente; documento de preparación (aún no hay salón cliente). |
| `AUDITORIA_TEXTOS_FIJOS.md` | Qué textos son comunes al producto y cuáles se personalizan. Auditoría del 2026-10-23; las rutas de línea pueden haber cambiado. | Histórico-técnico: útil, pero no garantiza números de línea actuales. |
| `RUTAS_Y_API.md` | Inventario de rutas HTTP, métodos, permisos y endpoints JSON. | Vigente (verificado contra `src/`). |
| `MODELO_DE_DATOS.md` | Tablas D1, columnas, estados, retención y valores por defecto. | Vigente (verificado contra `schema.sql` y `src/`). |
| `OPERACION_Y_DESPLIEGUE.md` | Comandos, despliegue, secretos, backups, diagnóstico y comprobaciones seguras. | Vigente |

## Reglas de trabajo (`instrucciones/`)

| Archivo | Contenido |
|---|---|
| `INSTRUCCIONES_GENERALES.md` | Procedimiento de trabajo y reglas duras. |
| `ARQUITECTURA.md` | Módulos, flujo del bot, capas y modelo de datos resumido. |
| `NORMAS_DE_CODIGO.md` | Estilo, compatibilidad, HTML/CSP, teléfonos, fechas y SQL. |
| `SEGURIDAD.md` | Secretos, sesiones, CSRF, rate-limit, webhook, CSP y validaciones. |
| `PRUEBAS.md` | Comandos y criterios de verificación. |
| `DECISIONES.md` | Decisiones técnicas y sus motivos (histórico cronológico). |
| `TAREAS_PENDIENTES.md` | Pendientes reales, ordenados por prioridad, y qué no repetir. |

## Qué documento manda

1. **El código real** (`src/`, `schema.sql`, `wrangler.jsonc`, `test/e2e.mjs`) manda sobre cualquier documento.
2. **`memoria.md`** manda sobre el estado y las verificaciones.
3. **`instrucciones/`** manda sobre cómo trabajar.
4. **`docs/`** explica el producto para personas; si contradice al código, se corrige el documento.
5. El **historial de `memoria.md` §11** no manda: se conserva como trazabilidad.

## Mantenimiento

- Al mover o renombrar un documento activo, actualizar este índice y las referencias de `README.md`, `AGENTS.md` y `memoria.md`.
- No duplicar contenido: enlazar al documento que corresponda.
- El historial de `memoria.md` §11 no se reescribe; se conserva como trazabilidad.
- No guardar secretos, contraseñas ni tokens en ningún documento.
