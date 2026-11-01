#!/usr/bin/env node
import { writeFileSync } from "fs";
import { renderSVG } from "uqr";

function main() {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("Usage: node scripts/generate-qr-recepcion.mjs <baseUrl>");
    console.error("Example: node scripts/generate-qr-recepcion.mjs https://example.workers.dev");
    process.exit(1);
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    console.error("Invalid URL:", baseUrl);
    process.exit(1);
  }
  const target = `${url.origin}/recepcion`;
  const svg = renderSVG(target, { ecc: "M", border: 4, pixelSize: 8 });
  writeFileSync("public/qr-recepcion.svg", svg);
  console.log(`Generated public/qr-recepcion.svg for ${target}`);
}

main();
