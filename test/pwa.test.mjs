// Test automatizado para validar la PWA, el manifiesto y las dimensiones reales de los iconos PNG
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, makeEnv } from "./helpers/d1-sqlite.mjs";
import worker from "../src/index.ts";

function getPngDimensionsFromBuffer(buffer) {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.slice(0, 8).equals(pngSignature)) {
    throw new Error("No es un archivo PNG válido");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("PWA: manifest.json existe, es válido y los iconos PNG tienen dimensiones reales correctas", () => {
  const manifestPath = path.resolve("public/manifest.json");
  assert.ok(fs.existsSync(manifestPath), "el archivo manifest.json debe existir en public/");

  const content = fs.readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(content);

  assert.equal(manifest.display, "standalone");
  assert.ok(Array.isArray(manifest.icons), "el manifest debe declarar un array de iconos");
  assert.ok(manifest.icons.length >= 2, "debe haber al menos dos iconos");

  for (const icon of manifest.icons) {
    assert.ok(icon.src, "cada icono debe tener src");
    assert.ok(icon.sizes, "cada icono debe tener sizes");
    assert.equal(icon.type, "image/png");

    const iconFilePath = path.resolve("public", icon.src.replace(/^\//, ""));
    assert.ok(fs.existsSync(iconFilePath), `el archivo físico del icono debe existir en ${iconFilePath}`);

    const [expectedWidth, expectedHeight] = icon.sizes.split("x").map(Number);
    const { width, height } = getPngDimensionsFromBuffer(fs.readFileSync(iconFilePath));

    assert.equal(width, expectedWidth, `el ancho del icono ${icon.src} debe coincidir con ${expectedWidth}`);
    assert.equal(height, expectedHeight, `el alto del icono ${icon.src} debe coincidir con ${expectedHeight}`);
  }
});

async function fetchRoute(pathname, envOverrides = {}) {
  const db = createTestDb();
  // Ajustes mínimos para que loadSettings no falle en /qr-recepcion
  await db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?)",
  ).bind("salonName", JSON.stringify("Peluqueria Prueba")).run();
  await db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?)",
  ).bind("address", JSON.stringify("Calle Prueba 1")).run();
  await db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?)",
  ).bind("phone", JSON.stringify("600 000 000")).run();
  const env = makeEnv(db, envOverrides);
  const req = new Request(`https://peluqueria-test.workers.dev${pathname}`);
  const res = await worker.fetch(req, env, {});
  db.close();
  return res;
}

test("PWA: GET /manifest.json devuelve 200, MIME application/manifest+json y campos obligatorios", async () => {
  const res = await fetchRoute("/manifest.json");
  assert.equal(res.status, 200, "debe devolver 200");
  assert.ok(res.headers.get("content-type")?.includes("application/manifest+json"),
    `Content-Type debe ser application/manifest+json, fue: ${res.headers.get("content-type")}`);
  const body = await res.text();
  const manifest = JSON.parse(body);
  assert.equal(manifest.name, "Peluqueria Prueba");
  assert.equal(manifest.short_name, "Peluqueria P…");
  assert.equal(manifest.start_url, "/recepcion/");
  assert.equal(manifest.scope, "/recepcion/");
  assert.equal(manifest.display, "standalone");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2,
    "debe declarar al menos dos iconos");
  // CSP restrictiva
  assert.ok(res.headers.get("content-security-policy")?.includes("'none'"),
    "la CSP del manifest debe ser restrictiva");
});

test("PWA: GET /icon-192.png devuelve el PNG real de 192x192 con Content-Type image/png", async () => {
  const res = await fetchRoute("/icon-192.png");
  assert.equal(res.status, 200, "debe devolver 200");
  assert.ok(res.headers.get("content-type")?.includes("image/png"),
    `Content-Type debe ser image/png, fue: ${res.headers.get("content-type")}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  // Cabecera PNG
  assert.equal(bytes[0], 137);
  assert.equal(bytes[1], 80);
  assert.equal(bytes[2], 78);
  assert.equal(bytes[3], 71);
  // Dimensiones reales servidas por HTTP
  const { width, height } = getPngDimensionsFromBuffer(bytes);
  assert.equal(width, 192, "el icono servido debe medir 192 px de ancho");
  assert.equal(height, 192, "el icono servido debe medir 192 px de alto");
  // Debe ser exactamente el mismo binario que public/icon-192.png
  assert.ok(bytes.equals(fs.readFileSync(path.resolve("public/icon-192.png"))),
    "el icono servido debe coincidir con public/icon-192.png");
  // Caché larga e inmutable
  assert.ok(res.headers.get("cache-control")?.includes("max-age=31536000"),
    "el icono debe tener caché larga");
  assert.ok(res.headers.get("cache-control")?.includes("immutable"),
    "el icono debe ser inmutable");
});

test("PWA: GET /icon-512.png devuelve el PNG real de 512x512 con Content-Type image/png", async () => {
  const res = await fetchRoute("/icon-512.png");
  assert.equal(res.status, 200, "debe devolver 200");
  assert.ok(res.headers.get("content-type")?.includes("image/png"),
    `Content-Type debe ser image/png, fue: ${res.headers.get("content-type")}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes[0], 137);
  assert.equal(bytes[1], 80);
  assert.equal(bytes[2], 78);
  assert.equal(bytes[3], 71);
  const { width, height } = getPngDimensionsFromBuffer(bytes);
  assert.equal(width, 512, "el icono servido debe medir 512 px de ancho");
  assert.equal(height, 512, "el icono servido debe medir 512 px de alto");
  assert.ok(bytes.equals(fs.readFileSync(path.resolve("public/icon-512.png"))),
    "el icono servido debe coincidir con public/icon-512.png");
});

test("PWA: GET /qr-recepcion devuelve 200 con HTML, QR SVG y datos del salón", async () => {
  const res = await fetchRoute("/qr-recepcion");
  assert.equal(res.status, 200, "debe devolver 200");
  assert.ok(res.headers.get("content-type")?.includes("text/html"),
    `Content-Type debe ser text/html, fue: ${res.headers.get("content-type")}`);
  const body = await res.text();
  assert.ok(body.includes("<svg"), "la página debe contener un SVG del QR");
  assert.ok(body.includes("Peluqueria Prueba"), "debe mostrar el nombre del salón");
  assert.ok(body.includes("/recepcion"), "el QR debe apuntar a la página de recepción");
  // CSP de la página QR (sin scripts externos, solo estilos inline)
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.ok(csp.includes("'none'"), "la CSP del QR debe ser restrictiva");
});

test("PWA: rutas PWA son públicas (no requieren autenticación)", async () => {
  for (const pathname of ["/manifest.json", "/icon-192.png", "/icon-512.png"]) {
    const res = await fetchRoute(pathname);
    assert.notEqual(res.status, 401, `${pathname} no debe exigir autenticación`);
    assert.notEqual(res.status, 403, `${pathname} no debe prohibir el acceso`);
  }
});
