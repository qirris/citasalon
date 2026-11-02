#!/usr/bin/env python3
"""Valida un export SQL de D1 sin tocar ninguna base de datos remota.

El archivo se ejecuta completo en una base SQLite en memoria y después se
comprueba que las tablas requeridas existen de verdad. Así se rechazan los
archivos que solo mencionan una tabla en un comentario o en una cadena de
texto, además de los SQL inválidos o truncados de forma detectable.

Uso:
    python3 scripts/validate-d1-backup.py backups/backup.sql --require-table appointments

Código de salida: 0 si el backup es válido, 1 si no lo es.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path


def fail(message: str) -> int:
    print(f"ERROR: {message}", file=sys.stderr)
    return 1


def validate(path: Path, required_tables: list[str]) -> int:
    if not path.is_file():
        return fail(f"no existe el archivo {path}")

    try:
        size = path.stat().st_size
    except OSError as exc:
        return fail(f"no se puede leer {path}: {exc}")

    if size <= 0:
        return fail(f"el archivo {path} está vacío")

    try:
        sql = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return fail(f"el archivo {path} no es texto UTF-8 válido")
    except OSError as exc:
        return fail(f"no se puede leer {path}: {exc}")

    if not sql.strip():
        return fail(f"el archivo {path} solo contiene espacios en blanco")

    connection = sqlite3.connect(":memory:")
    try:
        try:
            connection.executescript(sql)
        except (sqlite3.Error, ValueError) as exc:
            return fail(
                "el SQL no se puede ejecutar completo "
                f"(posible error de sintaxis o archivo truncado): {exc}"
            )

        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            return fail(f"PRAGMA integrity_check no devolvió 'ok': {integrity}")

        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        normalized = {name.casefold(): name for name in tables}
        missing = [name for name in required_tables if name.casefold() not in normalized]
        if missing:
            found = ", ".join(sorted(tables)) or "ninguna"
            return fail(
                "el SQL no crea la(s) tabla(s) requerida(s): "
                f"{', '.join(missing)}. Tablas encontradas: {found}"
            )

        found_required = ", ".join(
            sorted(normalized[name.casefold()] for name in required_tables)
        )
        print(
            f"OK: {path} ({size} bytes) ejecutado en SQLite; "
            f"integrity_check=ok; tablas requeridas presentes: {found_required}"
        )
        return 0
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Valida un export SQL de D1 en una SQLite en memoria."
    )
    parser.add_argument("file", type=Path, help="Ruta del archivo .sql exportado")
    parser.add_argument(
        "--require-table",
        action="append",
        dest="required_tables",
        metavar="TABLA",
        help="Tabla que debe existir (se puede repetir). Por defecto: appointments.",
    )
    args = parser.parse_args()

    required_tables = args.required_tables or ["appointments"]
    return validate(args.file, required_tables)


if __name__ == "__main__":
    sys.exit(main())
