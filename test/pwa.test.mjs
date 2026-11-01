// Test automatizado para validar la PWA, el manifiesto y las dimensiones reales de los iconos PNG
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function getPngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  // Verificar cabecera PNG
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.slice(0, 8).equals(pngSignature)) {
    throw new Error("No es un archivo PNG válido");
  }
  // Leer ancho y alto del chunk IHDR (offset 16 y 20)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
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
    const { width, height } = getPngDimensions(iconFilePath);

    assert.equal(width, expectedWidth, `el ancho del icono ${icon.src} debe coincidir con ${expectedWidth}`);
    assert.equal(height, expectedHeight, `el alto del icono ${icon.src} debe coincidir con ${expectedHeight}`);
  }
});
