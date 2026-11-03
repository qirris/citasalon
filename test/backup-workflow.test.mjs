// Pruebas del flujo REAL del workflow de backup: scripts/encrypt-backup.mjs y
// scripts/decrypt-backup.mjs (no solo de src/backup.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "clave-de-prueba-local-suficientemente-larga-0001";
const WRONG_KEY = "otra-clave-de-prueba-local-que-no-es-la-buena-9999";
const SECRET_MARKER = "Cliente Secreto";

const SAMPLE_SQL = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE appointments (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, name TEXT NOT NULL);
INSERT INTO appointments (id, phone, name) VALUES (1, '34600111222', '${SECRET_MARKER}');
INSERT INTO appointments (id, phone, name) VALUES (2, '34600333444', 'Otra Persona');
`;

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.BACKUP_ENCRYPTION_KEY;
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  return { ...env, ...extra };
}

function run(script, args, env) {
  return spawnSync(process.execPath, [path.join("scripts", script), ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pelu-backup-flow-"));
}

function withDir(fn) {
  const dir = tempDir();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Workflow backup: falta BACKUP_ENCRYPTION_KEY y no se genera ningún artefacto", () => {
  withDir((dir) => {
    const sql = path.join(dir, "backup.sql");
    fs.writeFileSync(sql, SAMPLE_SQL);
    const res = run("encrypt-backup.mjs", [sql], cleanEnv());
    assert.notEqual(res.status, 0, "debe fallar sin clave");
    assert.equal(fs.existsSync(`${sql}.enc`), false, "no debe crear el .enc");
    assert.ok(!res.stdout.includes(KEY), "no debe imprimir la clave");
  });
});

test("Workflow backup: un SQL vacío se rechaza", () => {
  withDir((dir) => {
    const sql = path.join(dir, "backup.sql");
    fs.writeFileSync(sql, "   \n");
    const res = run("encrypt-backup.mjs", [sql], cleanEnv({ BACKUP_ENCRYPTION_KEY: KEY }));
    assert.notEqual(res.status, 0, "debe rechazar un SQL vacío");
    assert.equal(fs.existsSync(`${sql}.enc`), false);
  });
});

test("Workflow backup: cifrar, descifrar y restaurar en SQLite aislado conserva los datos", () => {
  withDir((dir) => {
    const sql = path.join(dir, "backup.sql");
    const enc = path.join(dir, "backup.sql.enc");
    const restored = path.join(dir, "restored.sql");
    fs.writeFileSync(sql, SAMPLE_SQL);

    const encRes = run("encrypt-backup.mjs", [sql, "--out", enc], cleanEnv({ BACKUP_ENCRYPTION_KEY: KEY }));
    assert.equal(encRes.status, 0, encRes.stderr);
    assert.ok(fs.existsSync(enc), "debe crear el archivo cifrado");
    assert.ok(!encRes.stdout.includes(KEY), "no debe imprimir la clave");

    const raw = fs.readFileSync(enc, "utf8");
    assert.ok(!raw.includes(SECRET_MARKER), "el .enc no debe contener SQL legible");
    assert.ok(!raw.includes("CREATE TABLE"), "el .enc no debe contener el esquema en claro");

    const envelope = JSON.parse(raw);
    for (const field of ["iv", "authTag", "data", "checksumSha256"]) {
      assert.equal(typeof envelope[field], "string", `debe incluir ${field}`);
    }
    assert.equal(envelope.version, 3);
    assert.equal(envelope.algorithm, "aes-256-gcm");
    assert.ok(envelope.checksumSha256.length === 64, "debe incluir SHA-256 hex");

    const decRes = run("decrypt-backup.mjs", [enc, "--out", restored], cleanEnv({ BACKUP_ENCRYPTION_KEY: KEY }));
    assert.equal(decRes.status, 0, decRes.stderr);
    assert.equal(fs.readFileSync(restored, "utf8"), SAMPLE_SQL, "el SQL descifrado debe coincidir byte a byte");

    const db = new DatabaseSync(":memory:");
    db.exec(fs.readFileSync(restored, "utf8"));
    const rows = db.prepare("SELECT id, name FROM appointments ORDER BY id").all();
    db.close();
    assert.deepEqual(
      rows.map((r) => ({ id: Number(r.id), name: String(r.name) })),
      [{ id: 1, name: SECRET_MARKER }, { id: 2, name: "Otra Persona" }],
      "la restauración debe conservar todas las filas",
    );
  });
});

test("Workflow backup: clave incorrecta no permite descifrar ni escribe SQL", () => {
  withDir((dir) => {
    const sql = path.join(dir, "backup.sql");
    const enc = path.join(dir, "backup.sql.enc");
    const out = path.join(dir, "no-debe-existir.sql");
    fs.writeFileSync(sql, SAMPLE_SQL);
    assert.equal(run("encrypt-backup.mjs", [sql], cleanEnv({ BACKUP_ENCRYPTION_KEY: KEY })).status, 0);
    const res = run("decrypt-backup.mjs", [enc, "--out", out], cleanEnv({ BACKUP_ENCRYPTION_KEY: WRONG_KEY }));
    assert.notEqual(res.status, 0, "debe fallar con clave incorrecta");
    assert.equal(fs.existsSync(out), false, "no debe escribir SQL con la clave incorrecta");
  });
});

test("Workflow backup: detecta ciphertext manipulado, authTag, IV y checksum", () => {
  withDir((dir) => {
    const sql = path.join(dir, "backup.sql");
    const enc = path.join(dir, "backup.sql.enc");
    const out = path.join(dir, "out.sql");
    fs.writeFileSync(sql, SAMPLE_SQL);
    assert.equal(run("encrypt-backup.mjs", [sql], cleanEnv({ BACKUP_ENCRYPTION_KEY: KEY })).status, 0);
    const original = JSON.parse(fs.readFileSync(enc, "utf8"));

    const variants = {
      "ciphertext manipulado": (e) => { e.data = (e.data[0] === "a" ? "b" : "a") + e.data.slice(1); },
      "authTag manipulado": (e) => { e.authTag = (e.authTag[0] === "a" ? "b" : "a") + e.authTag.slice(1); },
      "IV manipulado": (e) => { e.iv = "00".repeat(12); },
      "checksum manipulado": (e) => { e.checksumSha256 = "0".repeat(64); },
      "tamaño manipulado": (e) => { e.sizeBytes += 7; },
    };

    for (const [name, mutate] of Object.entries(variants)) {
      const copy = structuredClone(original);
      mutate(copy);
      fs.writeFileSync(enc, JSON.stringify(copy));
      const res = run("decrypt-backup.mjs", [enc, "--out", out], cleanEnv({ BACKUP_ENCRYPTION_KEY: KEY }));
      assert.notEqual(res.status, 0, `debe fallar con ${name}`);
      assert.equal(fs.existsSync(out), false, `no debe escribir SQL con ${name}`);
    }
  });
});

test("Workflow backup: JSON truncado o inválido se rechaza sin escribir SQL", () => {
  withDir((dir) => {
    const enc = path.join(dir, "backup.sql.enc");
    const out = path.join(dir, "out.sql");
    fs.writeFileSync(enc, '{"format":"peluqueria-d1-backup","version":3,"alg');
    const res = run("decrypt-backup.mjs", [enc, "--out", out], cleanEnv({ BACKUP_ENCRYPTION_KEY: KEY }));
    assert.notEqual(res.status, 0, "debe rechazar JSON truncado");
    assert.equal(fs.existsSync(out), false);
  });
});

test("Workflow backup: el YAML solo publica el .sql.enc, verifica descifrado y limpia siempre", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "backup.yml"), "utf8");

  const uploadStart = yml.indexOf("uses: actions/upload-artifact@v4");
  const nextStep = yml.indexOf("\n      - name:", uploadStart);
  const uploadSection = yml.slice(uploadStart, nextStep === -1 ? undefined : nextStep);
  assert.ok(uploadSection.includes("path: backups/backup.sql.enc"), "la subida debe apuntar al archivo cifrado");
  assert.ok(!/path:\s*backups\/backup\.sql\s*$/m.test(uploadSection), "la subida NO debe apuntar al SQL en claro");

  assert.ok(yml.includes("scripts/decrypt-backup.mjs"), "debe verificar el descifrado antes de publicar");
  assert.ok(yml.includes("cmp -s backups/backup.sql"), "debe comparar el SQL descifrado con el original");
  assert.ok(/if:\s*always\(\)/.test(yml), "la limpieza debe ejecutarse siempre");
  assert.ok(/rm -f backups\/backup\.sql backups\/backup\.sql\.enc/.test(yml), "la limpieza debe borrar el SQL y el .enc temporales");
});
