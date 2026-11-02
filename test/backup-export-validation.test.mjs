import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "scripts",
  "validate-d1-backup.py"
);

function resolvePython() {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    "No se encontró Python 3 (python3 ni python) para probar la validación del backup."
  );
}

const PYTHON = resolvePython();

function runValidation(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-backup-validation-"));
  const file = path.join(dir, "backup.sql");
  try {
    if (sql !== null) fs.writeFileSync(file, sql, "utf8");
    const result = spawnSync(
      PYTHON,
      [SCRIPT, file, "--require-table", "appointments"],
      { encoding: "utf8" }
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertAccepted(sql) {
  const result = runValidation(sql);
  assert.equal(
    result.status,
    0,
    `Se esperaba un backup válido, pero falló:\n${result.stderr}`
  );
  assert.match(result.stdout, /integrity_check=ok/);
}

function assertRejected(sql) {
  const result = runValidation(sql);
  assert.equal(
    result.status,
    1,
    `Se esperaba un rechazo, pero la validación aceptó el archivo:\n${result.stdout}`
  );
  assert.match(result.stderr, /^ERROR:/m);
}

test("acepta un SQL válido con la tabla appointments", () => {
  assertAccepted(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      'CREATE TABLE "appointments" (',
      "  id INTEGER PRIMARY KEY,",
      "  phone TEXT NOT NULL",
      ");",
      ""
    ].join("\n")
  );
});

test("acepta un SQL válido con appointments y datos", () => {
  assertAccepted(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      'CREATE TABLE "appointments" (',
      "  id INTEGER PRIMARY KEY,",
      "  phone TEXT NOT NULL",
      ");",
      'INSERT INTO "appointments" ("id","phone") VALUES(1,\'600000000\');',
      ""
    ].join("\n")
  );
});

test("acepta un SQL válido con otras tablas además de appointments", () => {
  assertAccepted(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE clients (id INTEGER PRIMARY KEY);",
      "CREATE TABLE services (id INTEGER PRIMARY KEY);",
      "CREATE TABLE appointments (id INTEGER PRIMARY KEY);",
      "CREATE TABLE stylists (id INTEGER PRIMARY KEY);",
      ""
    ].join("\n")
  );
});

test("rechaza CREATE TABLE appointments dentro de un comentario", () => {
  assertRejected(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "-- CREATE TABLE appointments (id INTEGER PRIMARY KEY);",
      ""
    ].join("\n")
  );
});

test("rechaza CREATE TABLE appointments dentro de un comentario de bloque", () => {
  assertRejected(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "/*",
      "CREATE TABLE appointments (id INTEGER PRIMARY KEY);",
      "*/",
      ""
    ].join("\n")
  );
});

test("rechaza CREATE TABLE appointments dentro de una cadena de texto", () => {
  assertRejected(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "SELECT 'CREATE TABLE appointments (id INTEGER PRIMARY KEY);';",
      ""
    ].join("\n")
  );
});

test("rechaza una tabla llamada appointments_old", () => {
  assertRejected(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE appointments_old (id INTEGER PRIMARY KEY);",
      ""
    ].join("\n")
  );
});

test("rechaza un archivo vacío", () => {
  assertRejected("");
});

test("rechaza un archivo que solo contiene el PRAGMA inicial", () => {
  assertRejected("PRAGMA defer_foreign_keys=TRUE;\n");
});

test("rechaza un SQL con un paréntesis sin cerrar", () => {
  assertRejected(
    ["CREATE TABLE appointments (", "  id INTEGER PRIMARY KEY", ""].join("\n")
  );
});

test("rechaza un SQL truncado de forma detectable", () => {
  assertRejected(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE appointments (id INTEGER PRIMARY KEY, phone TEXT);",
      "INSERT INTO appointments (phone) VALUES ('600000000",
      ""
    ].join("\n")
  );
});

test("rechaza un SQL válido sin la tabla appointments", () => {
  assertRejected(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE clients (id INTEGER PRIMARY KEY);",
      ""
    ].join("\n")
  );
});

test("rechaza un archivo inexistente", () => {
  assertRejected(null);
});
