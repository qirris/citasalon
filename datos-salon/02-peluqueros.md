# 02 — Peluqueros y sus horarios

Copia esta información en el panel: **Ajustes → Peluqueros y horario** y en las
tarjetas **«Horario de <peluquero>»**.

## Lista de peluqueros
Escribe los nombres separados por comas, en el orden en que quieras que
aparezcan. Ejemplo:

```
Nombres: Ana, Luis, Marta
```

Rellena el tuyo:

```
Nombres: <!-- RELLENA -->
```

## Horario general del salón
Es el horario que se usa para cualquier peluquero al que **no** le pongas un
horario propio. Formato: `HH:MM-HH:MM`. Si un día está cerrado, déjalo vacío.
Para partir el día (mañana y tarde) separa los tramos con ` y `.

```
Lunes:     10:00-14:00 y 16:00-20:00
Martes:    <!-- RELLENA -->
Miércoles: <!-- RELLENA -->
Jueves:    <!-- RELLENA -->
Viernes:   <!-- RELLENA -->
Sábado:    <!-- RELLENA -->
Domingo:   (vacío = cerrado)
```

## Horario propio de cada peluquero (opcional)
Si un peluquero tiene un horario distinto al general, rellénalo aquí.

Reglas:
- Si rellenas **algún** día, los que dejes vacíos serán su **día libre**.
- Si lo dejas **todo** vacío, ese peluquero sigue el **horario general** del salón.

### Ana
```
Lunes:     10:00-12:00
Martes:    10:00-12:00
Miércoles: 10:00-12:00
Jueves:    10:00-12:00
Viernes:   10:00-12:00
Sábado:    10:00-14:00
Domingo:   (vacío = libre)
```

### Luis
```
Lunes:     16:00-20:00
Martes:    16:00-20:00
Miércoles: 16:00-20:00
Jueves:    16:00-20:00
Viernes:   16:00-20:00
Sábado:    (vacío = libre)
Domingo:   (vacío = libre)
```

### <!-- RELLENA: nombre del siguiente peluquero -->
```
<!-- RELLENA -->
```

## Vacaciones / días libres por peluquero
Una fecha por línea en formato `AAAA-MM-DD`. En el panel van en el campo
**«Vacaciones de <peluquero>»**.

### Ana
```
2026-08-01
2026-08-02
2026-08-03
```

### Luis
```
<!-- RELLENA (o déjalo vacío) -->
```

## Días cerrados del salón (todos)
Fechas en las que cierra todo el salón (una por línea, `AAAA-MM-DD`).
En el panel: **Ajustes → Peluqueros y horario → Días cerrados**.

```
2026-12-25
2026-01-01
```
