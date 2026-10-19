# 03 — Servicios, duración y precios

Copia la lista en el panel: **Ajustes → Servicios**.

## Formato exacto

Una línea por servicio, con los campos separados por ` | ` (barra vertical con
un espacio a cada lado):

```
id | nombre | minutos | precio
```

- **id**: nombre corto, sin espacios ni tildes (corte_mujer, tinte...). Es el
  identificador interno; no lo repitas.
- **nombre**: lo que ve el cliente.
- **minutos**: duración entera en minutos (sin el símbolo).
- **precio**: texto libre, por ejemplo `25 €`.

## Ejemplo listo para copiar

```
corte_mujer | Corte mujer | 45 | 25 €
corte_hombre | Corte hombre | 30 | 15 €
tinte | Tinte | 90 | 35 €
```

## Tu lista

Rellena debajo (puedes añadir o quitar líneas):

```
<!-- RELLENA: una línea por servicio con el formato id | nombre | minutos | precio -->




```

## Reglas de reserva (Ajustes → Reglas de reserva)

- **Minutos por hueco**: cada cuántos minutos el bot ofrece una hora (p. ej. 15).
  Rellena: `<!-- RELLENA (p. ej. 15) -->`
- **Días máximos por delante**: hasta cuándo se puede reservar (p. ej. 30).
  Rellena: `<!-- RELLENA (p. ej. 30) -->`
- **Antelación mínima (minutos)**: con cuánta antelación hay que reservar (p. ej. 60).
  Rellena: `<!-- RELLENA (p. ej. 60) -->`
- **Citas máximas por cliente**: cuántas citas activas puede tener un cliente (p. ej. 5).
  Rellena: `<!-- RELLENA (p. ej. 5) -->`
