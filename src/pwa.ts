import type { Env, Settings } from "./types.ts";

// ------------------------------------------------------------------ PWA: manifest.json
export function manifestJson(s: Settings): string {
  return JSON.stringify({
    name: s.salonName,
    short_name: s.salonName.length > 12 ? s.salonName.slice(0, 12) + "…" : s.salonName,
    description: `Panel de citas de ${s.salonName}`,
    start_url: "/recepcion/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    orientation: "portrait-primary",
    scope: "/recepcion/",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
    categories: ["business", "productivity"],
    lang: "es",
    dir: "ltr",
  }, null, 2);
}

// Iconos PNG 1x1 px transparentes codificados en base64 (placeholders mínimos)
// En producción se recomienda reemplazar por iconos reales del salón.
// 192x192 PNG transparente (67 bytes)
export const ICON_192_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// 512x512 PNG transparente (67 bytes - mismo contenido, el navegador lo escala)
export const ICON_512_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function iconResponse(base64: string): Response {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes.buffer, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; img-src 'self' data:",
    },
  });
}

// ------------------------------------------------------------------ QR de Recepción
import { renderSVG } from "uqr";

export function qrRecepcionSvg(baseUrl: string): string {
  const url = baseUrl.replace(/\/$/, "") + "/recepcion";
  return renderSVG(url, { ecc: "M", border: 4, pixelSize: 8 });
}

export function qrRecepcionPage(env: Env, s: Settings, baseUrl: string): Response {
  const svg = qrRecepcionSvg(baseUrl);
  const css = `
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 30px 16px }
.card { background: #fff; color: #1e2430; border-radius: 18px; padding: 34px 30px; max-width: 430px; width: 100%; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,.4) }
h1 { font-size: 24px; margin-bottom: 6px }
p { color: #475569; font-size: 14.5px }
svg { width: 260px; height: 260px; margin: 20px auto; display: block }
.foot { font-size: 13px; color: #64748b; margin-top: 14px }
.info { background: #f1f5f9; border-radius: 10px; padding: 16px; margin-top: 16px; text-align: left; font-size: 13.5px }
.info strong { color: #0f172a }
`;
  const body = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR Recepción · ${s.salonName}</title><style>${css}</style></head>
<body><div class="card">
<h1>Recepción — Personal</h1>
<p>Escanea para abrir el panel de recepción en el móvil.</p>
${svg}
<p><strong>${s.salonName}</strong><br>${s.address} · ${s.phone}</p>
<div class="info">
<strong>URL:</strong> ${baseUrl}/recepcion<br>
<strong>Nota:</strong> Requiere contraseña de recepción. El QR solo abre la página de login.
</div>
<p class="foot">Imprime este código y colócalo en zona de personal.</p>
</div></body></html>`;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:" },
  });
}