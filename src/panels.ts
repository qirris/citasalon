import * as db from "./db.ts";
import { loadSettings, saveSettings } from "./config.ts";
import { freeSlots, stylistClosed, stylistSpans, workingStylists } from "./availability.ts";

import { cleanName } from "./bot.ts";
import { changedForNotice, notifyCancellation, notifyCreation, notifyUpdate, type NoticeAppt } from "./notices.ts";
import { badOrigin, clearCookie, readSession, safeEqual, sessionCookie, type PanelRole } from "./auth.ts";
import { displayPhone, normalizePhone } from "./phone.ts";
import { renderSVG } from "uqr";
import {
  DAYS, addMin, atTime, dayStr, fmtDay, hhmm, iso, isValidDay, isValidTime, nowLocal,
  parseDT, parseDay, shortDay, startOfDay, weekday,
} from "./time.ts";
import type { Appt, Env, Service, Settings } from "./types.ts";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// El único JS del panel son tres scripts inline estáticos: selector de huecos (CSP_FORM),
// refresco de la agenda (CSP_AGENDA), y tema oscuro/claro (CSP_THEME, todas las páginas).
// connect-src es imprescindible: el selector de huecos pide /slots por fetch (si falta, la CSP
// bloquea la petición y el formulario muestra «No se han podido cargar los huecos»).
const CSP_FORM = CSP.replace("style-src 'unsafe-inline';",
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';");
// La agenda además pide sus datos por fetch al mismo origen (/agenda-json).
const CSP_AGENDA = CSP.replace("style-src 'unsafe-inline';",
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';");
// El script de tema oscuro se ejecuta en todas las páginas (incluso CSP_FORM y CSP_AGENDA lo heredan).
const CSP_THEME = CSP.replace("style-src 'unsafe-inline';",
  "style-src 'unsafe-inline'; script-src 'unsafe-inline';");

const RATE_WINDOW_MS = 60_000;
const RATE_SESSION_LIMIT = 120;
const RATE_IP_LIMIT = 60;

/** Un servicio sin `active` (guardado antes de esta función) se considera activo. */
const isServiceActive = (svc: Service): boolean => svc.active !== false;
const activeServices = (s: Settings): Service[] => s.services.filter(isServiceActive);


const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const euro = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",")) + " €";
const parsePrice = (p: string): number => {
  const m = String(p ?? "").replace(/\s/g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const priceOf = (s: Settings, a: Appt): number => {
  const svc = s.services.find((x) => x.id === a.service_id) ?? s.services.find((x) => x.name === a.service_name);
  return svc ? parsePrice(svc.price) : 0;
};
const durationMin = (a: Appt): number =>
  Math.max(0, (parseDT(a.ends_at).getTime() - parseDT(a.starts_at).getTime()) / 60000);
const csvCell = (v: unknown): string => {
  const t = String(v ?? "");
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
function csvResponse(rows: string[][], filename: string): Response {
  const body = "\uFEFF" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-security-policy": CSP,
    },
  });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    // Los paneles muestran datos que cambian (citas, agenda): nunca se cachean en el navegador.
    headers: {
      "content-type": "text/html; charset=utf-8", "content-security-policy": CSP,
      "cache-control": "no-store", ...headers,
    },
  });
}

/** Respuesta del formulario de cita: única página que permite su script inline controlado. */
function formResponse(body: string, status = 200): Response {
  return html(body, status, { "content-security-policy": CSP_FORM });
}

const redirect = (loc: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 303, headers: { location: loc, ...headers } });

const css = `
:root{
  --bg-primary:#f0f2f5;--bg-secondary:#fff;--bg-tertiary:#f9fafb;--bg-quaternary:#f3f4f6;
  --text-primary:#1e2430;--text-secondary:#6b7280;--text-tertiary:#9ca3af;--text-inverse:#fff;
  --border-primary:#e5e7eb;--border-secondary:#d1d5db;--border-tertiary:#f3f4f6;
  --sidebar-bg:#1f2937;--sidebar-text:#e5e7eb;--sidebar-text-hover:#f3f4f6;--sidebar-active-bg:#7c3aed;
  --sidebar-border:#374151;--link-color:#7c3aed;--link-hover:#6d28d9;--link-active:#7c3aed;
  --success-bg:#f0fdf4;--success-border:#bbf7d0;--success-text:#14532d;
  --error-bg:#fef2f2;--error-border:#fecaca;--error-text:#9f1239;
  --warning-bg:#eff6ff;--warning-border:#bfdbfe;--warning-text:#1e3a8a;
  --input-bg:#fff;--input-border:#d1d5db;--input-focus-border:#7c3aed;
  --card-hover-shadow:rgba(0,0,0,.08);--card-shadow:rgba(0,0,0,.06);
}
html[data-theme="dark"]{
  --bg-primary:#0f172a;--bg-secondary:#1e293b;--bg-tertiary:#334155;--bg-quaternary:#475569;
  --text-primary:#f1f5f9;--text-secondary:#cbd5e1;--text-tertiary:#94a3b8;--text-inverse:#0f172a;
  --border-primary:#334155;--border-secondary:#475569;--border-tertiary:#1e293b;
  --sidebar-bg:#0f172a;--sidebar-text:#cbd5e1;--sidebar-text-hover:#f1f5f9;--sidebar-active-bg:#a78bfa;
  --sidebar-border:#1e293b;--link-color:#a78bfa;--link-hover:#c4b5fd;--link-active:#a78bfa;
  --success-bg:#064e3b;--success-border:#6ee7b7;--success-text:#d1fae5;
  --error-bg:#7f1d1d;--error-border:#fca5a5;--error-text:#fecaca;
  --warning-bg:#082f49;--warning-border:#7dd3fc;--warning-text:#cffafe;
  --input-bg:#1e293b;--input-border:#475569;--input-focus-border:#a78bfa;
  --card-hover-shadow:rgba(255,255,255,.1);--card-shadow:rgba(0,0,0,.3);
  color-scheme:dark;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh;transition:background .3s,color .3s}
a{color:inherit;text-decoration:none}
.shell{display:flex;min-height:100vh}
/* Sidebar */
.side{width:220px;flex:0 0 220px;background:var(--sidebar-bg);color:var(--sidebar-text);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;transition:background .3s,color .3s}
.brand{padding:18px 14px 14px;border-bottom:1px solid var(--sidebar-border);transition:border-color .3s}
.brand-name{font-size:16px;font-weight:700;color:var(--text-inverse);letter-spacing:-.2px}
.brand-sub{font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.6px;margin-top:2px}
.nav-group{padding:10px 8px;flex:1}
.side a.nav-item{display:flex;align-items:center;gap:9px;color:var(--sidebar-text);padding:10px 12px;border-radius:8px;font-size:13.5px;margin-bottom:3px;transition:all .12s}
.side a.nav-item:hover{background:var(--sidebar-border);color:var(--sidebar-text-hover)}
.side a.nav-item.on{background:var(--sidebar-active-bg);color:#fff;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,.15)}
.side a.nav-item .icon{font-size:15px;width:18px;text-align:center;flex-shrink:0}
.side-footer{padding:10px 8px;border-top:1px solid var(--sidebar-border);transition:border-color .3s}
/* Barra inferior móvil (recepción) */
.mobile-bar{display:none}
.logout-btn{width:100%;background:none;border:1px solid var(--border-secondary);color:var(--text-secondary);padding:8px 12px;border-radius:8px;font-size:13px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:8px;transition:all .3s}
.logout-btn:hover{border-color:#ef4444;color:#fca5a5}
/* Main */
.main{flex:1;min-width:0;padding:24px 32px 80px;transition:background .3s}
h1{font-size:24px;font-weight:700;color:var(--text-primary);margin-bottom:4px;line-height:1.2;transition:color .3s}
h2{font-size:17px;font-weight:600;margin:22px 0 12px;color:var(--text-primary);transition:color .3s}
.sub,.page-sub{color:var(--text-secondary);font-size:14px;margin-bottom:20px;line-height:1.5;transition:color .3s}
/* Cards */
.card{background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:14px;padding:20px 24px;margin-bottom:16px;box-shadow:0 2px 6px var(--card-shadow);transition:box-shadow .2s, background .3s, border-color .3s}
.card:hover{box-shadow:0 4px 12px var(--card-hover-shadow)}
.card-title{font-size:15px;font-weight:700;color:var(--text-primary);margin:0 0 14px;text-transform:uppercase;letter-spacing:.3px;transition:color .3s}
/* Stats */
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px}
.stat{background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:14px;padding:16px 20px;min-width:120px;flex:1;transition:all .2s}
.stat{background:linear-gradient(135deg,var(--bg-secondary) 0%,var(--bg-tertiary) 100%)}
.stat b{display:block;font-size:28px;font-weight:700;color:var(--text-primary);line-height:1.15;transition:color .3s}
.stat span{font-size:12px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-top:4px;display:block;font-weight:600;transition:color .3s}
.stat-link{text-decoration:none;transition:all .15s;cursor:pointer}
.stat-link:hover{border-color:var(--link-color);box-shadow:0 4px 12px rgba(124,58,237,.15);transform:translateY(-2px)}
html[data-theme="dark"] .stat-link:hover{box-shadow:0 4px 12px rgba(167,139,250,.15)}
.stat-link.on{border-color:var(--link-color);background:linear-gradient(135deg,var(--bg-tertiary) 0%,var(--bg-quaternary) 100%);box-shadow:0 0 0 2px rgba(124,58,237,.2)}
html[data-theme="dark"] .stat-link.on{box-shadow:0 0 0 2px rgba(167,139,250,.2)}
/* Table */
table{width:100%;border-collapse:collapse;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:14px;overflow:hidden;font-size:13.5px;box-shadow:0 2px 6px var(--card-shadow);transition:background .3s, border-color .3s}
th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--border-tertiary);vertical-align:top;transition:border-color .3s}
th{background:var(--bg-tertiary);font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-secondary);font-weight:700;border-bottom:1px solid var(--border-primary);transition:background .3s, color .3s}
tr:hover{background:var(--bg-tertiary);transition:background .2s}
tr:last-child td{border-bottom:none}
tr.cancelada td{background:var(--error-bg);color:var(--error-text);font-weight:500;transition:background .3s, color .3s}
tr.realizada td{background:var(--success-bg);color:var(--success-text);font-weight:500;transition:background .3s, color .3s}
.time{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.mono{font-variant-numeric:tabular-nums}
.note{color:var(--text-secondary);font-size:13px;transition:color .3s}
/* Pills & badges */
.pill{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
.src-whatsapp{background:#dcfce7;color:#166534}
.src-admin{background:#e0e7ff;color:#3730a3}
.src-staff{background:#fef3c7;color:#92400e}
.badge{background:var(--error-bg);color:var(--error-text);font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;transition:background .3s, color .3s}
.alert{padding:12px 16px;border-radius:9px;margin-bottom:14px;font-size:14px;transition:background .3s, border-color .3s, color .3s}
.alert.err{background:var(--error-bg);border:1px solid var(--error-border);color:var(--error-text)}
.alert.ok{background:var(--success-bg);border:1px solid var(--success-border);color:var(--success-text);font-weight:600}
.alert ul{margin:6px 0 0 18px}
/* compat aliases */
.flash{background:var(--success-bg);border:1px solid var(--success-border);color:var(--success-text);font-weight:600;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14px;transition:background .3s, border-color .3s, color .3s}
.err{background:var(--error-bg);border:1px solid var(--error-border);color:var(--error-text);padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14px;transition:background .3s, border-color .3s, color .3s}
.err ul{margin:6px 0 0 18px}
/* Forms */
label,.label{display:block;font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px;transition:color .3s}
form.stack label{margin-top:16px}
input[type=text],input[type=password],input[type=date],input[type=time],input[type=number],input[type=search],select,textarea{
  width:100%;padding:11px 14px;border:1.5px solid var(--input-border);border-radius:10px;font:inherit;font-size:16px;background:var(--input-bg);color:var(--text-primary);transition:all .15s;-webkit-appearance:none}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--input-focus-border);box-shadow:0 0 0 4px rgba(124,58,237,.1)}
html[data-theme="dark"] input:focus,html[data-theme="dark"] select:focus,html[data-theme="dark"] textarea:focus{box-shadow:0 0 0 4px rgba(167,139,250,.1)}
textarea{resize:vertical;min-height:100px}
.hint{display:block;font-size:13px;color:var(--text-secondary);margin-top:6px;line-height:1.4;transition:color .3s}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 20px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 20px}
.field{margin-bottom:16px}
.actions,.form-actions{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
/* Botones base */
.btn{display:inline-flex;align-items:center;justify-content:center;background:var(--link-color);color:#fff;border:none;padding:12px 22px;min-height:46px;border-radius:12px;font:inherit;font-size:14.5px;font-weight:700;cursor:pointer;text-decoration:none;text-align:center;box-shadow:0 2px 6px rgba(124,58,237,.25);transition:all .15s;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
html[data-theme="dark"] .btn{box-shadow:0 2px 6px rgba(167,139,250,.25)}
.btn:hover{background:var(--link-hover);box-shadow:0 4px 12px rgba(124,58,237,.35);color:#fff}
html[data-theme="dark"] .btn:hover{box-shadow:0 4px 12px rgba(167,139,250,.35)}
.btn:active{transform:scale(.99)}
.btn.sec{background:var(--bg-secondary);color:var(--text-secondary);border:1.5px solid var(--border-secondary);box-shadow:0 1px 2px rgba(0,0,0,.04);transition:all .15s}
.btn.sec:hover{background:var(--bg-tertiary);border-color:var(--link-color);color:var(--link-color);box-shadow:0 2px 6px rgba(0,0,0,.08)}
.btn.sm{padding:7px 15px;min-height:38px;font-size:13px;border-radius:10px}
.btn.danger{background:#dc2626;color:#fff;box-shadow:0 2px 6px rgba(220,38,38,.25);transition:all .15s}
.btn.danger:hover{background:#b91c1c;box-shadow:0 4px 12px rgba(220,38,38,.35)}
.btn.ghost{background:none;color:#dc2626;border:1px solid #fecaca;box-shadow:none;transition:all .15s}
.btn.ghost:hover{background:var(--error-bg);border-color:#f87171}
/* Agenda top bar */
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px;padding:12px 0;border-bottom:1px solid var(--border-tertiary);transition:border-color .3s}
.date-nav{display:flex;align-items:center;gap:10px}
.date-nav .nav-arrow{width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;background:var(--bg-secondary);border:1.5px solid var(--border-secondary);border-radius:10px;font-size:18px;color:var(--text-primary);text-decoration:none;transition:all .15s;cursor:pointer;font-weight:700;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.date-nav .nav-arrow:hover{background:var(--bg-tertiary);border-color:var(--link-color);color:var(--link-color)}
.date-label{font-size:18px;font-weight:700;color:var(--text-primary);min-width:160px;text-align:center;transition:color .3s}
/* Filtro por peluquero */
.stylist-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.stylist-bar-label{font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;transition:color .3s}
.chip{display:inline-flex;align-items:center;justify-content:center;background:var(--bg-secondary);border:1.5px solid var(--border-secondary);border-radius:999px;padding:7px 16px;font-size:13.5px;font-weight:600;color:var(--text-secondary);text-decoration:none;min-height:36px;transition:all .15s;cursor:pointer}
.chip:hover{background:var(--bg-tertiary);border-color:var(--text-secondary)}
.chip.on{background:var(--link-color);border-color:var(--link-color);color:#fff;font-weight:700}
.chip.on:hover{background:var(--link-hover);border-color:var(--link-hover)}
.stylist-link{color:var(--link-color);text-decoration:none;font-weight:600;transition:color .15s}
.stylist-link:hover{color:var(--link-hover);text-decoration:underline}
.filter-note{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--warning-bg);border:1px solid var(--warning-border);color:var(--warning-text);border-radius:10px;padding:10px 14px;font-size:13.5px;margin-bottom:14px;transition:background .3s, border-color .3s, color .3s}
.filter-note .btn{margin-left:auto}
/* Agenda cita tarjetas (móvil) */
.appt-list{display:none}
.appt-card{background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:12px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 2px var(--card-shadow);transition:background .3s, border-color .3s}
.appt-card.cancelada{background:var(--error-bg);border-color:var(--error-border)}
.appt-card.realizada{background:var(--success-bg);border-color:var(--success-border)}
.badge.ok{background:var(--success-bg);color:var(--success-text);transition:background .3s, color .3s}
.appt-card-when{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.appt-card-time{font-variant-numeric:tabular-nums;font-weight:700;font-size:16px;color:var(--text-primary);transition:color .3s}
.appt-card-client{font-weight:600;font-size:15px;color:var(--text-primary);word-break:break-word;transition:color .3s}
.appt-card-service,.appt-card-svc{font-size:14px;color:var(--text-secondary);margin-bottom:4px;transition:color .3s}
.appt-card-meta{color:var(--text-secondary);font-size:13px;display:flex;flex-wrap:wrap;gap:2px 12px;margin-bottom:8px;transition:color .3s}
.appt-card-notes{color:var(--text-secondary);font-size:13px;margin-bottom:10px;white-space:pre-wrap;word-break:break-word;transition:color .3s}
.appt-card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.appt-card-actions .btn{flex:1 1 120px;min-height:44px}
.appt-card-actions .btn-action{flex:1 1 110px;min-height:44px;font-size:13px;border-radius:10px}
.appt-card-actions form{flex:1 1 120px;display:flex}
.appt-card-actions form .btn{width:100%}
.appt-card-actions form .btn-action{width:100%}
.agenda-table{}
.is-hidden{display:none!important}
.row-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
/* Botones de acciones en tabla/tarjetas */
.btn-action{display:inline-flex;align-items:center;justify-content:center;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;border:none;cursor:pointer;transition:all .15s;min-height:32px;white-space:nowrap}
.btn-action.edit{background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-secondary);transition:all .15s}
.btn-action.edit:hover{background:var(--border-secondary);border-color:var(--link-color);color:var(--link-color)}
.btn-action.done{background:var(--link-color);color:#fff;border:1px solid var(--link-color);font-size:12.5px;padding:7px 14px;transition:all .15s}
.btn-action.done:hover{background:var(--link-hover);border-color:var(--link-hover);box-shadow:0 2px 8px rgba(124,58,237,.4)}
html[data-theme="dark"] .btn-action.done:hover{box-shadow:0 2px 8px rgba(167,139,250,.4)}
.btn-action.restore{background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-secondary);transition:all .15s}
.btn-action.restore:hover{background:var(--border-secondary);border-color:var(--link-color);color:var(--link-color)}
.btn-action.cancel{background:var(--bg-secondary);color:#dc2626;border:1px solid #fecaca;transition:all .15s}
.btn-action.cancel:hover{background:var(--error-bg);border-color:#f87171}
.btn-action.delete{background:var(--bg-secondary);color:#b91c1c;border:1px solid #fca5a5;transition:all .15s}
.btn-action.delete:hover{background:#fee2e2;border-color:#f87171}
.btn-action.sm{padding:5px 10px;font-size:11.5px;min-height:28px}
/* Slots */
.slot-grid{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.slot-btn{min-height:46px;padding:10px 18px;border-radius:10px;border:1.5px solid var(--border-secondary);background:var(--bg-secondary);color:var(--text-primary);font:inherit;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center}
.slot-btn:hover{background:var(--bg-tertiary);border-color:var(--text-secondary);transform:translateY(-1px)}
.slot-btn.active{background:var(--link-color);border-color:var(--link-color);color:#fff;font-weight:700;box-shadow:0 4px 12px rgba(124,58,237,.3)}
html[data-theme="dark"] .slot-btn.active{box-shadow:0 4px 12px rgba(167,139,250,.3)}
.slot-empty{color:var(--text-secondary);font-size:14px;margin-top:10px;font-weight:500;transition:color .3s}
.slot-error{color:var(--error-text);font-size:14px;margin-top:10px;font-weight:500;transition:color .3s}
/* Servicios */
.svc-list{display:flex;flex-direction:column;gap:12px;margin-bottom:18px}
.svc-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px 18px;display:flex;align-items:center;gap:16px;box-shadow:0 2px 6px rgba(0,0,0,.06);transition:all .2s}
.svc-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08);border-color:#d1d5db}
.svc-card.off{background:#f9fafb;border-style:dashed;border-color:#cbd5e1;opacity:.75}
.svc-card.off .svc-name{color:#6b7280}
.svc-name{font-weight:700;font-size:16px;color:#0f172a;flex:1}
.svc-meta{font-size:13.5px;color:#6b7280;margin-top:3px;font-weight:500}
.svc-actions{display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;align-items:center}
.svc-actions form{display:flex}
.svc-badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:3px 8px;border-radius:999px;vertical-align:middle;margin-left:6px}
.svc-badge.on{background:#bbf7d0;color:#14532d}
.svc-badge.off{background:#e2e8f0;color:#475569}
.check-field label{display:flex;align-items:center;gap:10px;font-weight:600;margin-bottom:0;cursor:pointer}
.check-field input[type=checkbox]{width:20px;height:20px;accent-color:#7c3aed;flex-shrink:0;cursor:pointer}
/* Peluqueros */
.stylist-list,.stylist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:18px}
.stylist-card{background:#fff;border:1px solid #e5e7eb;border-left:4px solid #7c3aed;border-radius:14px;padding:18px 20px;box-shadow:0 2px 6px rgba(0,0,0,.06);transition:all .2s}
.stylist-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.1);border-color:#c4b5fd;border-left-color:#7c3aed;transform:translateY(-2px)}
.stylist-card h3{margin:0 0 6px;font-size:17px;font-weight:700;color:#0f172a}
.stylist-card .hint{font-size:13.5px;color:#6b7280;margin-bottom:12px;line-height:1.5}
.stylist-card-actions{display:flex;gap:8px;flex-wrap:wrap}
/* Horarios */
.hours,.hours-grid{display:grid;grid-template-columns:100px 1fr;gap:8px 14px;align-items:center}
.hours span,.day-label{font-size:14px;font-weight:700;color:#0f172a}
/* Búsqueda */
.search-panel{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;margin-bottom:20px;box-shadow:0 2px 6px rgba(0,0,0,.06)}
.search-row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.search-row .field{flex:1 1 240px;margin:0}
.search-item{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px 18px;margin-bottom:12px;box-shadow:0 2px 6px rgba(0,0,0,.06);transition:all .2s}
.search-item:hover{box-shadow:0 4px 12px rgba(0,0,0,.08);border-color:#d1d5db}
.search-item-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.search-item-time{font-variant-numeric:tabular-nums;font-weight:700;font-size:15px;color:#0f172a}
.search-item-client{font-weight:700;font-size:15px;color:#0f172a}
.search-item-meta{color:#6b7280;font-size:13.5px;display:flex;flex-wrap:wrap;gap:3px 14px;margin-bottom:10px}
.search-item-actions{display:flex;gap:8px;flex-wrap:wrap}
/* Próximas citas (agenda): evita que una reserva para otro día quede invisible */
.upcoming{margin-top:28px}
.upcoming-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.upcoming-head h2{font-size:17px;margin:0;font-weight:700;color:#0f172a}
.upcoming-list{display:flex;flex-direction:column;gap:10px;margin-top:12px}
/* Vista semanal */
.view-selector{display:flex;gap:8px;align-items:center}
.view-btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 16px;border-radius:8px;border:1.5px solid #d1d5db;background:#fff;color:#374151;font-size:13.5px;font-weight:600;cursor:pointer;transition:all .15s}
.view-btn.active{background:#7c3aed;border-color:#7c3aed;color:#fff}
.view-btn:hover:not(.active){background:#f3f4f6;border-color:#9ca3af}
.week-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;margin-bottom:20px}
.day-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;box-shadow:0 2px 6px rgba(0,0,0,.06);transition:all .2s;min-height:200px;display:flex;flex-direction:column}
.day-card.today{border-color:#7c3aed;background:#f5f3ff}
.day-card-header{font-weight:700;font-size:14px;color:#0f172a;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e5e7eb}
.day-card-header span{display:block;font-size:12px;color:#6b7280;font-weight:400;margin-top:2px}
.day-appts{display:flex;flex-direction:column;gap:8px;flex:1}
.day-appt{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:12px}
.day-appt.confirmed{background:#f0fdf4;border-color:#bbf7d0}
.day-appt.cancelled{background:#fef2f2;border-color:#fecaca;opacity:.7}
.day-appt.done{background:#f0fdf4;border-color:#bbf7d0}
.day-appt-time{font-weight:700;color:#0f172a;display:block;font-variant-numeric:tabular-nums}
.day-appt-client{font-size:11.5px;color:#6b7280;display:block;margin-top:2px}
.day-appt-service{font-size:11.5px;color:#6b7280;display:block;margin-top:1px}
.day-empty{color:#9ca3af;font-size:12px;text-align:center;padding:20px 10px}
@media(max-width:820px){
  .week-grid{grid-template-columns:1fr;gap:10px}
  .day-card{min-height:auto;padding:12px}
  .day-card-header{font-size:13px;padding-bottom:6px;margin-bottom:8px}
  .day-card-header span{font-size:11px}
  .day-appts{gap:6px}
  .day-appt{padding:8px;font-size:11.5px}
}
.upcoming-item{display:flex;align-items:baseline;justify-content:space-between;gap:6px 16px;flex-wrap:wrap;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 16px;text-decoration:none;color:inherit;box-shadow:0 2px 6px rgba(0,0,0,.06);transition:all .2s}
.upcoming-item:hover{border-color:#d1d5db;box-shadow:0 4px 12px rgba(0,0,0,.08)}
.upcoming-when{font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;color:#0f172a}
.upcoming-meta{color:#6b7280;font-size:13.5px;display:flex;flex-wrap:wrap;gap:3px 14px;font-weight:500}
/* Empty state */
.empty{background:#fff;border:2px dashed #d1d5db;border-radius:14px;padding:36px 24px;text-align:center;color:#6b7280;line-height:1.6}
.empty p+p{margin-top:10px}
/* Login */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:20px}
.login-box,.login{background:#fff;border-radius:18px;padding:40px 36px;width:100%;max-width:400px;box-shadow:0 25px 50px rgba(0,0,0,.15)}
.login-box h1,.login h1{font-size:24px;margin-bottom:8px;font-weight:700;color:#0f172a}
.login-box .btn,.login .btn{width:100%;margin-top:12px;min-height:48px;font-size:15px;font-weight:700}
/* QR */
.qr-wrap{min-height:100vh;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#e2e8f0;display:flex;align-items:center;justify-content:center;padding:30px 16px}
.qr-card{background:#fff;color:#0f172a;border-radius:20px;padding:40px 36px;max-width:460px;width:100%;text-align:center;box-shadow:0 25px 50px rgba(0,0,0,.15)}
.qr-card h1{font-size:26px;margin-bottom:8px;font-weight:700;color:#0f172a}
.qr-card p{color:#6b7280;font-size:15px;line-height:1.6}
.qr-card svg{width:260px;height:260px;margin:20px auto;display:block}
.qr-card .foot{font-size:13px;color:#64748b;margin-top:14px}
/* Historial */
.audit-row td{font-size:13px}
/* Form-section compat */
.form-section{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px 24px;margin-bottom:16px;box-shadow:0 2px 6px rgba(0,0,0,.06)}
.form-section h2{font-size:16px;margin:0 0 14px;color:#0f172a;font-weight:700}
.form-section label{display:block;font-size:14px;font-weight:600;color:#374151;margin:12px 0 6px}
.btn-big{min-height:48px}
/* Responsive mobile ≤820px */
@media(max-width:820px){
  .shell{flex-direction:column}
  .side{width:100%;flex:none;height:auto;position:static;flex-direction:row;overflow-x:auto;overflow-y:visible;background:#1f2937;padding:0}
  .brand{padding:14px 16px 14px;display:flex;gap:14px;align-items:center;flex-shrink:0;white-space:nowrap}
  .brand-name{font-size:15px}
  .brand-sub{font-size:10px;margin-top:0}
  .nav-group{padding:0 8px;display:flex;flex-wrap:nowrap;gap:4px;flex:1;overflow-x:auto;scrollbar-width:none}
  .nav-group::-webkit-scrollbar{display:none}
  .side a.nav-item{padding:8px 12px;font-size:12.5px;flex:0 0 auto;white-space:nowrap}
  .side a.nav-item .icon{font-size:14px;width:14px}
  .side-footer{padding:8px 12px;border-top:none;border-left:1px solid #374151;display:flex;justify-content:flex-end;flex-shrink:0}
  .logout-btn{width:auto;padding:8px 12px;font-size:12px}
  .main{padding:16px 16px 100px}
  h1{font-size:20px;margin-bottom:6px}
  h2{font-size:15px;margin:16px 0 10px}
  .grid2,.grid3{grid-template-columns:1fr;gap:0 0}
  .hours,.hours-grid{grid-template-columns:80px 1fr}
  .card{padding:16px;border-radius:12px;margin-bottom:12px}
  .card:hover{box-shadow:0 2px 6px rgba(0,0,0,.06)}
  .form-section{padding:16px;border-radius:12px}
  /* Agenda */
  .agenda-table{display:none}
  .appt-list{display:block}
  .appt-card{margin-bottom:12px;border-radius:12px;padding:14px}
  .appt-card-actions{display:flex;flex-direction:column;gap:8px;margin-top:12px}
  .appt-card-actions .btn{flex:1;min-height:44px;width:100%}
  .appt-card-actions .btn-action{flex:1;min-height:46px;width:100%;font-size:13.5px;border-radius:10px;justify-content:center}
  .appt-card-actions form{flex:1;display:flex}
  .appt-card-actions form .btn-action{width:100%}
  /* Stats */
  .stats{gap:10px;margin-bottom:16px}
  .stat{flex:1 1 45%;padding:14px 12px;border-radius:12px}
  .stat b{font-size:24px}
  .stat span{font-size:11px}
  .btn.lg{min-height:48px;font-size:14px}
  /* Date nav */
  .top{gap:10px;padding:10px 0;margin-bottom:14px}
  .date-nav{gap:8px}
  .date-nav .nav-arrow{width:44px;height:44px;font-size:18px;border-radius:12px}
  .date-label{min-width:130px;font-size:17px}
  /* Formularios */
  .actions,.form-actions{flex-direction:column;align-items:stretch;gap:10px}
  .actions .btn,.form-actions .btn{min-height:46px;width:100%}
  .btn{padding:10px 16px;min-height:44px;font-size:13.5px}
  .btn.sm{min-height:38px;padding:8px 12px}
  /* Slots */
  .slot-btn{flex:1 1 45%;min-height:48px;justify-content:center;display:inline-flex;align-items:center}
  /* Buscador */
  .search-row{flex-direction:column;align-items:stretch}
  .search-row .field{width:100%}
  .search-table{display:none}
  .search-list{display:block}
  .search-item-actions .btn{min-height:44px}
  .search-item-actions .btn-action{min-height:44px;font-size:13px}
  /* Peluqueros */
  .stylist-list,.stylist-grid{grid-template-columns:1fr}
  /* Servicios */
  .svc-card{flex-direction:column;align-items:flex-start}
  .svc-actions{width:100%}
  .svc-actions .btn{flex:1;min-height:44px}
  /* Row actions */
  .row-actions{flex-direction:column}
  /* Cita form en móvil */
  .grid2,.grid3{grid-template-columns:1fr}
  /* Slot buttons más grandes en móvil */
  .slot-btn{flex:1 1 calc(50% - 8px);font-size:15px;min-height:52px}
  /* Formulario: actions en columna */
  .form-actions{flex-direction:column;align-items:stretch}
  .form-actions .btn,.form-actions a.btn{min-height:50px;width:100%}
  /* Agenda top */
  .top{gap:6px}
  .top .btn{min-height:44px}
  .top form{flex:1 1 100%;display:flex;gap:6px}
  .top form input[type=date]{flex:1;min-height:44px}
  /* Filtro por peluquero */
  .stylist-bar{gap:6px}
  .stylist-bar-label{flex:0 0 100%}
  .chip{min-height:40px;padding:8px 14px;font-size:13.5px;flex:0 0 auto}
  .filter-note{flex-direction:column;align-items:stretch;gap:8px}
  .filter-note .btn{margin-left:0;width:100%;min-height:44px}
  /* Stat */
  .stat{flex:1 1 calc(50% - 6px)}
  /* Inputs bigger on mobile */
  input[type=text],input[type=number],input[type=date],input[type=time],input[type=search],select{min-height:46px}
  textarea{min-height:80px}
  /* Card padding */
  .card{padding:16px 14px}
  /* h1 size */
  h1{font-size:21px}
  /* Search panel */
  .search-panel{padding:14px}
  /* Recepción en móvil: navegación inferior fija y accesible con el pulgar */
  .side-recept{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;padding:0 8px}
  .side-recept .brand{padding:10px 6px;border-bottom:none;flex:1 1 auto;min-width:0}
  .side-recept .brand-name{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .side-recept .nav-group{display:none}
  .side-recept .side-footer{padding:0 4px;border-top:none}
  .mobile-bar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:50;background:#111827;border-top:2px solid #1f2937;gap:8px;padding:8px 6px calc(8px + env(safe-area-inset-bottom));transition:all .3s}
  .mobile-bar .mob-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:56px;padding:6px 4px;border-radius:10px;color:#9ca3af;font-size:11px;font-weight:600;text-align:center;text-decoration:none;transition:all .15s;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  .mobile-bar .mob-item:hover{color:#cbd5e1;background:rgba(124,58,237,.08)}
  .mobile-bar .mob-item span{font-size:20px;line-height:1;display:block}
  .mobile-bar .mob-item.on{background:#7c3aed;color:#fff;font-weight:700;box-shadow:0 -2px 8px rgba(124,58,237,.3)}
  .mobile-bar .mob-item.nueva-cta{background:rgba(124,58,237,.18);color:#c4b5fd;font-weight:700}
  .mobile-bar .mob-item.nueva-cta:hover{background:rgba(124,58,237,.25)}
  .mobile-bar .mob-item:active{transform:scale(.95)}
  .side-recept + .main{padding-bottom:100px}
}
`;

const OK_TEXT: Record<string, string> = {
  creada: "Cita creada correctamente.",
  guardada: "Cambios guardados.",
  cancelada: "Cita cancelada.",
  restaurada: "Cita restaurada.",
  borrada: "Cita borrada.",
  ajustes: "Ajustes guardados.",
  servicio_creado: "Servicio añadido.",
  servicio_editado: "Servicio actualizado.",
  servicio_borrado: "Servicio eliminado.",
  servicio_desactivado: "Servicio desactivado: ya no se ofrece, pero sus citas se conservan.",
  servicio_activado: "Servicio activado: vuelve a estar disponible para reservar.",
  peluquero_creado: "Peluquero añadido.",
  horario_guardado: "Horario guardado.",
};

function flash(url: URL): string {
  const ok = url.searchParams.get("ok");
  if (!ok) return "";
  const msg = OK_TEXT[ok] ?? "";
  return msg ? `<div class="alert ok">${msg}</div>` : "";
}

function pageContext(base: string, active: string): string {
  if (base !== "/recepcion") return "";
  const contexts: Record<string, string> = {
    agenda: "📅 Agenda del día",
    nueva: "➕ Nueva cita",
    citas: "🔍 Buscar citas",
    servicios: "✂️ Servicios",
    peluqueros: "👤 Personal",
  };
  const label = contexts[active] ?? "";
  return label ? `<div class="page-context" style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:8px 0;color:var(--text-secondary);font-size:13px;font-weight:500"><span>${label}</span></div>` : "";
}

function sideNav(base: string, role: PanelRole, active: string): string {
  type Item = [string, string, string, string];
  // Servicios disponible para todos (admin y staff) — requisito del propietario
  const common: Item[] = [
    ["agenda", base + "/", "📅", "Agenda"],
    ["nueva", base + "/nueva", "➕", "Nueva cita"],
    ["citas", base + "/citas", "🔍", "Buscar"],
    ["servicios", base + "/servicios", "✂️", "Servicios"],
    ["peluqueros", base + "/peluqueros", "👤", "Peluqueros"],
  ];
  const adminOnly: Item[] = [
    ["informes", "/admin/informes", "📊", "Informes"],
    ["ajustes", "/admin/ajustes", "⚙️", "Ajustes"],
    ["historial", "/admin/historial", "📋", "Historial"],
  ];
  const items: Item[] = role === "admin" ? [...common, ...adminOnly] : common;
  const links = items.map(([key, href, icon, label]) =>
    `<a href="${href}" class="nav-item${active === key ? " on" : ""}"><span class="icon">${icon}</span>${label}</a>`
  ).join("");
  return links;
}

function layout(env: Env, s: Settings, base: string, role: PanelRole, active: string, title: string, body: string): string {
  const logoutBase = base;
  const rolLabel = base === "/admin" ? "Administración" : "Recepción";
  const links = sideNav(base, role, active);
  const isRecept = base === "/recepcion";
  const mobileBar = isRecept ? `
<nav class="mobile-bar" aria-label="Acciones rápidas">
  <a href="/recepcion/" class="mob-item${active === "agenda" ? " on" : ""}" aria-label="Agenda" title="Ver agenda del día"><span>📅</span><span>Agenda</span></a>
  <a href="/recepcion/nueva" class="mob-item${active === "nueva" ? " on" : " nueva-cta"}" aria-label="Nueva cita" title="Crear nueva cita"><span>➕</span><span>Nueva</span></a>
  <a href="/recepcion/citas" class="mob-item${active === "citas" ? " on" : ""}" aria-label="Buscar citas" title="Buscar y filtrar citas"><span>🔍</span><span>Buscar</span></a>
  <a href="/recepcion/servicios" class="mob-item${active === "servicios" ? " on" : ""}" aria-label="Servicios" title="Gestionar servicios"><span>✂️</span><span>Servicios</span></a>
  <a href="/recepcion/peluqueros" class="mob-item${active === "peluqueros" ? " on" : ""}" aria-label="Personal" title="Gestionar personal"><span>👤</span><span>Personal</span></a>
</nav>` : "";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${base === "/recepcion" ? '<link rel="manifest" href="/manifest.json"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><meta name="theme-color" content="#111827">' : '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><meta name="theme-color" content="#111827">'}
<title>${esc(title)} · ${esc(s.salonName)}</title><style>${css}</style>
<script>
(function(){
  try {
    const saved = localStorage.getItem('salon-theme');
    const preference = saved || (window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    if (preference === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch(e) {}
})();
</script></head>
<body><div class="shell">
<div class="side${isRecept ? " side-recept" : ""}">
  <div class="brand">
    <div class="brand-name">${esc(s.salonName)}</div>
    <div class="brand-sub">${rolLabel}</div>
  </div>
  <nav class="nav-group">${links}</nav>
  <div class="side-footer">
    <div class="theme-toggle" style="display:flex;align-items:center;gap:4px;padding:6px;border-top:1px solid var(--border-color);margin-bottom:8px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text-secondary);width:100%;margin-bottom:4px">Tema:</span>
      <button class="theme-btn" data-theme="light" title="Tema claro" style="flex:1;padding:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);cursor:pointer;border-radius:4px;font-size:11px">☀️ Claro</button>
      <button class="theme-btn" data-theme="dark" title="Tema oscuro" style="flex:1;padding:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);cursor:pointer;border-radius:4px;font-size:11px">🌙 Oscuro</button>
    </div>
    <form method="post" action="${logoutBase}/logout">
      <button class="logout-btn" type="submit">🚪 Cerrar sesión</button>
    </form>
    <script>
      (function() {
        const updateThemeBtns = () => {
          const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
          document.querySelectorAll('.theme-btn').forEach(btn => {
            const theme = btn.getAttribute('data-theme');
            btn.style.opacity = (theme === 'dark' && isDark) || (theme === 'light' && !isDark) ? '1' : '0.6';
          });
        };
        document.querySelectorAll('.theme-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const theme = btn.getAttribute('data-theme');
            try { localStorage.setItem('salon-theme', theme); } catch(e) {}
            if (theme === 'dark') {
              document.documentElement.setAttribute('data-theme', 'dark');
            } else {
              document.documentElement.removeAttribute('data-theme');
            }
            updateThemeBtns();
          });
        });
        updateThemeBtns();
      })();
    </script>
  </div>
</div>
<main class="main">${body}</main>
</div>${mobileBar}</body></html>`;
}

function loginPage(env: Env, base: string, error = ""): string {
  const name = env.SALON_NAME ?? "Peluquería";
  const label = base === "/admin" ? "Administración" : "Recepción";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${base === "/recepcion" ? '<link rel="manifest" href="/manifest.json"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><meta name="theme-color" content="#111827">' : '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><meta name="theme-color" content="#111827">'}
<title>Acceso · ${esc(name)}</title><style>${css}</style></head>
<body><div class="login-wrap"><div class="login-box">
<h1>${esc(name)}</h1>
<p class="sub">${esc(label)}</p>
${error ? `<div class="alert err">${esc(error)}</div>` : ""}
<form method="post" action="${base}/login">
  <div style="margin-bottom:14px"><label for="pwd">Contraseña</label><input type="password" id="pwd" name="password" autocomplete="current-password" required></div>
  <button class="btn" type="submit">Entrar</button>
</form>
</div></div></body></html>`;
}


function errors(errs: string[]): string {
  return errs.length ? `<div class="alert err"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
}

function errorPage(env: Env, s: Settings, base: string, role: PanelRole, title: string, errs: string[], back: string): string {
  return layout(env, s, base, role, "", title,
    `<h1>${esc(title)}</h1>${errors(errs)}<div class="actions"><a class="btn sec" href="${back}">Volver</a></div>`);
}

// ------------------------------------------------------------------ QR público
async function qrPage(env: Env): Promise<Response> {
  const s = await loadSettings(env);
  const num = (env.WHATSAPP_NUMBER ?? "").replace(/\D/g, "");
  const link = `https://wa.me/${num}?text=${encodeURIComponent("Hola")}`;
  const svg = renderSVG(link, { ecc: "M", border: 4, pixelSize: 8 });
  const body = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reserva tu cita · ${esc(s.salonName)}</title><style>${css}</style></head>
<body><div class="qr-wrap"><div class="qr-card">
<h1>Reserva tu cita por WhatsApp</h1>
<p>Escanea el código y te atendemos al momento.</p>
${svg}
<p><strong>${esc(s.salonName)}</strong><br>${esc(s.address)} · ${esc(s.phone)}</p>
<p class="foot">Elige servicio, día y hora desde tu móvil. También puedes escribirnos directamente.</p>
</div></div></body></html>`;
  return html(body);
}

// ------------------------------------------------------------------ agenda
async function agendaPage(
  env: Env, s: Settings, base: string, role: PanelRole, url: URL, now: Date,
): Promise<Response> {
  const view = url.searchParams.get("view") === "week" ? "week" : "day";
  if (view === "week") {
    return weeklyAgendaPage(env, s, base, role, url, now);
  }
  const raw = url.searchParams.get("date");
  const day = raw && isValidDay(raw) ? parseDay(raw) : startOfDay(now);
  const withCancelled = base === "/admin" && url.searchParams.get("cancelled") === "1";
  const stylistFilter = url.searchParams.get("stylist")?.trim() || "";
  const listAll = await db.appointmentsForDay(env.DB, dayStr(day), withCancelled);
  const list = stylistFilter ? listAll.filter((a) => a.stylist === stylistFilter) : listAll;
  // Citas de días posteriores: una reserva hecha por WhatsApp para otro día no debe quedar invisible.
  const todayStart = startOfDay(now);
  const upcomingFrom = dayStr(day) >= dayStr(todayStart)
    ? dayStr(new Date(day.getTime() + 86400000))
    : dayStr(todayStart);
  const upcoming = await db.upcomingConfirmed(env.DB, upcomingFrom, 5);
  const sourceLabel = (a: Appt) => a.source === "whatsapp" ? "WhatsApp" : a.source === "admin" ? "Panel" : "Recepción";
  const upcomingBlock = upcoming.length ? `
<section class="upcoming">
  <div class="upcoming-head"><h2>Próximas citas</h2><a class="btn sec sm" href="${base}/citas">Buscar citas</a></div>
  <p class="sub">Siguientes reservas confirmadas después de este día. Pulsa una para abrir su fecha.</p>
  <div class="upcoming-list">${upcoming.map((a) => `<a class="upcoming-item" href="${base}/?date=${a.starts_at.slice(0, 10)}${stylistFilter ? `&stylist=${encodeURIComponent(stylistFilter)}` : ""}">
    <span class="upcoming-when">${esc(shortDay(parseDay(a.starts_at.slice(0, 10)), now))} · ${esc(a.starts_at.slice(11, 16))}</span>
    <span class="upcoming-meta"><span>${esc(a.stylist)}</span><span>${esc(a.service_name)}</span><span>${esc(a.name)}</span><span class="pill src-${esc(a.source)}">${sourceLabel(a)}</span></span>
  </a>`).join("")}</div>
</section>` : "";

  // Parámetros que no son de la agenda (por ejemplo una búsqueda) se conservan al cambiar fecha o peluquero.
  const CORE_PARAMS = new Set(["date", "stylist", "cancelled", "ok"]);
  const extras = [...url.searchParams.entries()].filter(([k]) => !CORE_PARAMS.has(k));
  const extraInputs = extras.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const q = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams({ date: dayStr(day) });
    if (stylistFilter) p.set("stylist", stylistFilter);
    if (withCancelled) p.set("cancelled", "1");
    for (const [k, v] of extras) p.set(k, v);
    for (const [k, v] of Object.entries(extra)) { p.delete(k); if (v !== null) p.set(k, v); }
    return `${base}/?${p}`;
  };
  const prev = q({ date: dayStr(new Date(day.getTime() - 86400000)) });
  const next = q({ date: dayStr(new Date(day.getTime() + 86400000)) });
  const today = q({ date: dayStr(startOfDay(now)) });
  // El nombre visible es también el identificador del peluquero en este sistema (no hay ID aparte).
  const allHref = q({ stylist: null });
  const stHref = (name: string) => q({ stylist: name });
  const stLink = (name: string) => `<a class="stylist-link" href="${stHref(name)}" title="Ver solo las citas de ${esc(name)}">${esc(name)}</a>`;
  // Peluqueros que aparecen en la agenda del día + el filtro activo (aunque ese día no tenga citas).
  const dayStylists: string[] = [];
  for (const a of listAll) if (!dayStylists.includes(a.stylist)) dayStylists.push(a.stylist);
  if (stylistFilter && !dayStylists.includes(stylistFilter)) dayStylists.push(stylistFilter);
  const stylistBar = (dayStylists.length || stylistFilter) ? `
<div class="stylist-bar" id="stylist-bar" role="group" aria-label="Filtrar por peluquero">
  <span class="stylist-bar-label">Peluquero</span>
  <a class="chip${stylistFilter ? "" : " on"}" href="${allHref}"${stylistFilter ? "" : ' aria-current="true"'}>Todos los peluqueros</a>
  ${dayStylists.map((st) => `<a class="chip${st === stylistFilter ? " on" : ""}" href="${stHref(st)}"${st === stylistFilter ? ' aria-current="true"' : ""}>${esc(st)}</a>`).join("\n  ")}
</div>` : "";
  const filterNote = stylistFilter ? `
<div class="filter-note" id="filter-note">
  <span>Mostrando solo las citas de <strong>${esc(stylistFilter)}</strong>.</span>
  <a class="btn sec sm" href="${allHref}">Ver todos los peluqueros</a>
</div>` : "";

  const confirmed = list.filter((a) => a.status === "confirmed");
  const cancelledNAll = listAll.filter((a) => a.status === "cancelled").length;
  const doneNAll = listAll.filter((a) => a.status === "done").length;
  const perStylistAll = new Map<string, number>();
  for (const a of listAll.filter((a) => a.status === "confirmed")) perStylistAll.set(a.stylist, (perStylistAll.get(a.stylist) ?? 0) + 1);

  const items = list.map((a) => {
    const start = parseDT(a.starts_at);
    const time = `${hhmm(start)}–${hhmm(parseDT(a.ends_at))}`;
    const cancelled = a.status === "cancelled";
    const done = a.status === "done";
    const phone = displayPhone(a.phone);
    const source = a.source === "whatsapp" ? "WhatsApp" : a.source === "admin" ? "Panel" : "Recepción";
    const acts: string[] = [`<a class="btn-action edit" href="${base}/cita/${a.id}">Editar</a>`];
    if (a.status === "confirmed") {
      acts.push(`<form class="inline" method="post" action="${base}/cita/${a.id}/realizada"><button class="btn-action done" type="submit">Realizada</button></form>`);
      acts.push(`<a class="btn-action cancel" href="${base}/cita/${a.id}/cancelar">Cancelar</a>`);
    } else if (cancelled && role === "admin") {
      acts.push(`<form class="inline" method="post" action="${base}/cita/${a.id}/restaurar"><button class="btn-action restore" type="submit">Restaurar</button></form>`);
      acts.push(`<a class="btn-action delete" href="${base}/cita/${a.id}/borrar">Borrar</a>`);
    }
    const badge = cancelled ? ' <span class="badge">Cancelada</span>' : (done ? ' <span class="badge ok">Realizada</span>' : "");
    const row = `<tr${cancelled ? ' class="cancelada"' : (done ? ' class="realizada"' : "")}>
<td class="time">${esc(time)}</td>
<td>${stLink(a.stylist)}</td>
<td>${esc(a.service_name)}${badge}</td>
<td>${esc(a.name)}</td>
<td class="mono">${esc(phone)}</td>
<td><span class="pill src-${esc(a.source)}">${source}</span></td>
<td class="note">${esc(a.notes)}</td>
<td><div class="row-actions">${acts.join("")}</div></td>
</tr>`;
    // Tarjetas para móvil: se generan para admin y recepción (en escritorio el CSS las oculta).
    const card = `<article class="appt-card${cancelled ? " cancelada" : (done ? " realizada" : "")}">
<div class="appt-card-when"><span class="appt-card-time">${esc(hhmm(start))}</span>–${esc(hhmm(parseDT(a.ends_at)))} <span class="appt-card-client">${esc(a.name)}</span>${badge}</div>
<div class="appt-card-service">${esc(a.service_name)}</div>
<div class="appt-card-meta">
<span>${stLink(a.stylist)}</span>
${phone ? `<span class="mono">${esc(phone)}</span>` : ""}
<span class="pill src-${esc(a.source)}">${source}</span>
</div>
${a.notes ? `<div class="appt-card-notes">${esc(a.notes)}</div>` : ""}
<div class="appt-card-actions">${acts.join("")}</div>
</article>`;
    return { row, card };
  });
  const rows = items.map((x) => x.row).join("");
  const cards = items.map((x) => x.card).join("");

  const emptyBlock = `<div class="empty${list.length ? " is-hidden" : ""}" id="agenda-empty">
${stylistFilter
    ? `<p><strong>${esc(stylistFilter)} no tiene citas</strong> · ${esc(fmtDay(day, now))}.</p>
<p><a class="btn sec sm" href="${allHref}">Ver todos los peluqueros</a></p>`
    : `<p><strong>No hay citas</strong> para este día.</p>
<p>Puedes crear una con el botón «Nueva cita».</p>`}
${upcoming.length ? `<p class="note">Hay reservas en días posteriores: están en «Próximas citas».</p>` : ""}
</div>`;

  const body = `
${pageContext(base, "agenda")}
<div class="top">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1">
    <div class="view-selector">
      <a class="view-btn active" href="${base}/?${new URLSearchParams({date: dayStr(day), ...(stylistFilter && {stylist: stylistFilter}), ...(withCancelled && {cancelled: "1"})}).toString()}" title="Vista de un día">📅 Día</a>
      <a class="view-btn" href="${base}/?view=week${stylistFilter ? `&stylist=${encodeURIComponent(stylistFilter)}` : ""}" title="Vista semanal">📆 Semana</a>
    </div>
    <div class="date-nav">
      <a class="nav-arrow" href="${prev}" aria-label="Día anterior">‹</a>
      <span class="date-label">${esc(fmtDay(day, now))}</span>
      <a class="nav-arrow" href="${next}" aria-label="Día siguiente">›</a>
    </div>
    <a class="btn sec sm" href="${today}">Hoy</a>
    <form method="get" action="${base}/" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="date" name="date" value="${dayStr(day)}" style="width:auto;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px" aria-label="Elegir fecha">
      ${stylistFilter ? `<input type="hidden" name="stylist" value="${esc(stylistFilter)}">` : ""}
      ${withCancelled ? '<input type="hidden" name="cancelled" value="1">' : ""}
      ${extraInputs}
      <button class="btn sec sm" type="submit">Ir</button>
    </form>
  </div>
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    ${role === "admin" ? (withCancelled
      ? `<a class="btn sec sm" href="${q({ cancelled: null })}">Ocultar canceladas</a>`
      : `<a class="btn sec sm" href="${q({ cancelled: "1" })}">Ver canceladas</a>`) : ""}
    <a class="btn" href="${base}/nueva">➕ Nueva cita</a>
  </div>
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto">
    <select id="auto-refresh" style="width:auto;padding:8px 12px;min-height:36px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px;font-weight:600;background:#fff;color:#1e293b" aria-label="Intervalo de actualización automática">
      <option value="0">Sin actualizar</option>
      <option value="60000">🔄 1 min</option>
      <option value="120000" selected>🔄 2 min</option>
      <option value="300000">🔄 5 min</option>
      <option value="600000">🔄 10 min</option>
    </select>
    <span id="last-refresh" style="font-size:12px;color:#6b7280;min-width:80px" aria-live="polite">Última: --:--</span>
    <span id="refresh-err" style="font-size:12px;color:#dc2626;display:none" role="status"></span>
  </div>
</div>
<script>
(function(){
  try {
    var sel = document.getElementById('auto-refresh');
    var last = document.getElementById('last-refresh');
    var err = document.getElementById('refresh-err');
    var key = 'pelu_auto_refresh';
    var saved = localStorage.getItem(key);
    if (saved && sel) sel.value = saved;
    var BASE = '${base}';
    var IS_ADMIN = ${role === "admin" ? "true" : "false"};
    var STYLIST_FILTER = ${JSON.stringify(stylistFilter)};
    // Los datos vienen de clientes (nombre, notas): nunca se insertan como HTML.
    function esc(v){
      return String(v==null?'':v).replace(/[&<>"']/g, function(c){
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
      });
    }
    function setLast(d){ if(last){ var t = d||new Date(); last.textContent='Última: '+t.toLocaleTimeString(); }}
    setLast();
    var timer=null, fetching=false, lastOk=0;
    function intervalMs(){
      var v = sel ? sel.value : '120000';
      if (v === '0') return 0;
      var ms = parseInt(v,10);
      return (isNaN(ms) || ms <= 0) ? 0 : ms;
    }
    function schedule(){
      if(timer){ clearTimeout(timer); timer=null; }
      var ms = intervalMs();
      if(!ms) return;
      timer = setTimeout(tick, ms);
    }
    function tick(){
      timer = null;
      if(document.hidden){ schedule(); return; }
      doRefresh();
    }
    function actions(a){
      var out = '<a class="btn-action edit" href="'+BASE+'/cita/'+a.id+'">Editar</a>';
      if(a.status === 'confirmed'){
        out += ' <form class="inline" method="post" action="'+BASE+'/cita/'+a.id+'/realizada"><button class="btn-action done" type="submit">Realizada</button></form>';
        out += ' <a class="btn-action cancel" href="'+BASE+'/cita/'+a.id+'/cancelar">Cancelar</a>';
      } else if(a.status === 'cancelled' && IS_ADMIN){
        out += ' <form class="inline" method="post" action="'+BASE+'/cita/'+a.id+'/restaurar"><button class="btn-action restore" type="submit">Restaurar</button></form>';
        out += ' <a class="btn-action delete" href="'+BASE+'/cita/'+a.id+'/borrar">Borrar</a>';
      }
      return out;
    }
    function sourceLabel(a){ return a.source==='whatsapp' ? 'WhatsApp' : (a.source==='admin' ? 'Panel' : 'Recepción'); }
    // El refresco vuelve a pintar filas y tarjetas: los nombres deben seguir siendo enlaces al filtro.
    function currentDay(){
      var el = document.querySelector('.top input[name="date"]');
      return el ? el.value : '';
    }
    function stylistHref(name, day){
      var p = new URLSearchParams(window.location.search);
      p.delete('ok');
      if(day) p.set('date', day);
      p.set('stylist', name);
      return BASE+'/?'+p.toString();
    }
    function stylistLink(name, day){
      return '<a class="stylist-link" href="'+esc(stylistHref(name, day))+'" title="Ver solo las citas de '+esc(name)+'">'+esc(name)+'</a>';
    }
    function render(data){
      var items = data.items || [];
      var day = data.date || currentDay();
      var tbody = document.getElementById('agenda-tbody');
      if(tbody){
        var rows = '';
        for(var i=0;i<items.length;i++){
          var a = items[i];
          var cancelled = a.status === 'cancelled';
          var done = a.status === 'done';
          var badge = cancelled ? ' <span class="badge">Cancelada</span>' : (done ? ' <span class="badge ok">Realizada</span>' : '');
          rows += '<tr'+(cancelled?' class="cancelada"':(done?' class="realizada"':''))+'>'
            + '<td class="time">'+esc(a.time)+'</td>'
            + '<td>'+stylistLink(a.stylist, day)+'</td>'
            + '<td>'+esc(a.service_name)+badge+'</td>'
            + '<td>'+esc(a.name)+'</td>'
            + '<td class="mono">'+esc(a.phone_display)+'</td>'
            + '<td><span class="pill src-'+esc(a.source)+'">'+sourceLabel(a)+'</span></td>'
            + '<td class="note">'+esc(a.notes)+'</td>'
            + '<td><div class="row-actions">'+actions(a)+'</div></td>'
            + '</tr>';
        }
        tbody.innerHTML = rows;
      }
      var listEl = document.getElementById('appt-list');
      if(listEl){
        var cards = '';
        for(var j=0;j<items.length;j++){
          var c = items[j];
          var canc = c.status === 'cancelled';
          var d = c.status === 'done';
          var bdg = canc ? ' <span class="badge">Cancelada</span>' : (d ? ' <span class="badge ok">Realizada</span>' : '');
          cards += '<article class="appt-card'+(canc?' cancelada':(d?' realizada':''))+'">'
            + '<div class="appt-card-when"><span class="appt-card-time">'+esc(String(c.starts_at||'').slice(11,16))+'</span>–'+esc(String(c.ends_at||'').slice(11,16))+' <span class="appt-card-client">'+esc(c.name)+'</span>'+bdg+'</div>'
            + '<div class="appt-card-service">'+esc(c.service_name)+'</div>'
            + '<div class="appt-card-meta"><span>'+stylistLink(c.stylist, day)+'</span>'+(c.phone_display?'<span class="mono">'+esc(c.phone_display)+'</span>':'')+'<span class="pill src-'+esc(c.source)+'">'+sourceLabel(c)+'</span></div>'
            + (c.notes?'<div class="appt-card-notes">'+esc(c.notes)+'</div>':'')
            + '<div class="appt-card-actions">'+actions(c)+'</div>'
            + '</article>';
        }
        listEl.innerHTML = cards;
      }
      // Contenedores fijos: así una cita nueva se pinta aunque el día empezara vacío.
      var empty = document.getElementById('agenda-empty');
      var table = document.getElementById('agenda-table');
      if(empty) empty.classList.toggle('is-hidden', items.length > 0);
      if(table) table.classList.toggle('is-hidden', items.length === 0);
      if(listEl) listEl.classList.toggle('is-hidden', items.length === 0);
      // Contadores
      var stats = document.getElementById('agenda-stats');
      if(stats && data.stats){
        var html = '<div class="stat"><b>'+data.stats.confirmed+'</b><span>Citas</span></div>';
        if(IS_ADMIN) html += '<div class="stat"><b>'+data.stats.cancelled+'</b><span>Canceladas</span></div>';
      if(IS_ADMIN && typeof data.stats.done === 'number') html += '<div class="stat"><b>'+data.stats.done+'</b><span>Realizadas</span></div>';
        for(var k=0;k<(data.stats.byStylist||[]).length;k++){
          var st = data.stats.byStylist[k];
          html += '<a class="stat stat-link'+(STYLIST_FILTER && STYLIST_FILTER === st.name ? ' on' : '')+'" href="'+esc(stylistHref(st.name, day))+'" title="Ver solo las citas de '+esc(st.name)+'"><b>'+st.count+'</b><span>'+esc(st.name)+'</span></a>';
        }
        stats.innerHTML = html;
      }
      // Próximas citas
      var up = document.getElementById('upcoming-wrap');
      if(up && data.upcoming){
        if(!data.upcoming.length){ up.innerHTML = ''; }
        else {
          var list = '';
          for(var u=0;u<data.upcoming.length;u++){
            var x = data.upcoming[u];
            var href = BASE+'/?date='+encodeURIComponent(x.date)+(STYLIST_FILTER?'&stylist='+encodeURIComponent(STYLIST_FILTER):'');
            list += '<a class="upcoming-item" href="'+href+'">'
              + '<span class="upcoming-when">'+esc(x.label)+'</span>'
              + '<span class="upcoming-meta"><span>'+esc(x.stylist)+'</span><span>'+esc(x.service_name)+'</span><span>'+esc(x.name)+'</span><span class="pill src-'+esc(x.source)+'">'+sourceLabel(x)+'</span></span>'
              + '</a>';
          }
          up.innerHTML = '<section class="upcoming"><div class="upcoming-head"><h2>Próximas citas</h2><a class="btn sec sm" href="'+BASE+'/citas">Buscar citas</a></div><p class="sub">Siguientes reservas confirmadas después de este día. Pulsa una para abrir su fecha.</p><div class="upcoming-list">'+list+'</div></section>';
        }
      }
    }
    async function doRefresh(){
      if(fetching) return;
      if(document.hidden){ schedule(); return; }
      fetching = true;
      if(err) err.textContent='';
      try {
        var params = new URLSearchParams(window.location.search);
        var url = BASE+'/agenda-json?'+params.toString();
        var r = await fetch(url, {headers:{'Accept':'application/json'}, cache:'no-store', credentials:'same-origin'});
        if(!r.ok) throw new Error('HTTP '+r.status);
        var data = await r.json();
        render(data);
        lastOk = Date.now();
        setLast(new Date());
      } catch(e){
        if(err) err.textContent = 'No se pudo actualizar la agenda. Se reintentará automáticamente.';
      } finally { fetching=false; schedule(); }
    }
    if(sel){ sel.addEventListener('change', function(){ try { localStorage.setItem(key, sel.value); } catch(e){} schedule(); }); }
    document.addEventListener('visibilitychange', function(){
      if(document.hidden){ if(timer){ clearTimeout(timer); timer=null; } return; }
      var ms = intervalMs();
      if(!ms){ return; }
      // Al volver a la pestaña, si ya toca, se actualiza de inmediato.
      if(!fetching && (Date.now() - lastOk) >= ms){ doRefresh(); return; }
      if(!timer) schedule();
    });
    schedule();
  } catch(e){}
})();
</script>
${flash(url)}
${stylistBar}
${filterNote}
<div class="stats" id="agenda-stats">
  <div class="stat"><b>${confirmed.length}</b><span>Citas</span></div>
  ${role === "admin" ? `<div class="stat"><b>${cancelledNAll}</b><span>Canceladas</span></div>` : ""}
  ${role === "admin" ? `<div class="stat"><b>${doneNAll}</b><span>Realizadas</span></div>` : ""}
  ${[...perStylistAll].map(([st, n]) => `<a class="stat stat-link${st === stylistFilter ? " on" : ""}" href="${stHref(st)}" title="Ver solo las citas de ${esc(st)}"><b>${n}</b><span>${esc(st)}</span></a>`).join("")}
</div>
${emptyBlock}
<table class="agenda-table${list.length ? "" : " is-hidden"}" id="agenda-table">
<thead><tr><th>Hora</th><th>Peluquero</th><th>Servicio</th><th>Cliente</th><th>Teléfono</th><th>Origen</th><th>Notas</th><th></th></tr></thead>
<tbody id="agenda-tbody">${rows}</tbody></table>
<div class="appt-list${list.length ? "" : " is-hidden"}" id="appt-list">${cards}</div>
<div id="upcoming-wrap">${upcomingBlock}</div>`;

  // El refresco automático necesita su script inline y poder pedir /agenda-json al mismo origen.
  return html(layout(env, s, base, role, "agenda", `Agenda ${fmtDay(day, now)}`, body), 200,
    { "content-security-policy": CSP_AGENDA });
}

// ------------------------------------------------------------------ agenda semanal
async function weeklyAgendaPage(
  env: Env, s: Settings, base: string, role: PanelRole, url: URL, now: Date,
): Promise<Response> {
  const raw = url.searchParams.get("date");
  let startDay = raw && isValidDay(raw) ? parseDay(raw) : startOfDay(now);
  
  // Ajustar para que la semana comience lunes (weekday 0 = lunes, 6 = domingo)
  const wd = weekday(startDay);
  if (wd !== 0) {
    startDay = new Date(startDay.getTime() - wd * 86400000);
  }
  
  const stylistFilter = url.searchParams.get("stylist")?.trim() || "";
  const withCancelled = base === "/admin" && url.searchParams.get("cancelled") === "1";
  
  // Parámetros que no son de la agenda
  const CORE_PARAMS = new Set(["date", "stylist", "cancelled", "ok", "view"]);
  const extras = [...url.searchParams.entries()].filter(([k]) => !CORE_PARAMS.has(k));
  
  const q = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams({ view: "week", date: dayStr(startDay) });
    if (stylistFilter) p.set("stylist", stylistFilter);
    if (withCancelled) p.set("cancelled", "1");
    for (const [k, v] of extras) p.set(k, v);
    for (const [k, v] of Object.entries(extra)) { p.delete(k); if (v !== null) p.set(k, v); }
    return `${base}/?${p}`;
  };
  
  const prevWeek = q({ date: dayStr(new Date(startDay.getTime() - 7 * 86400000)) });
  const nextWeek = q({ date: dayStr(new Date(startDay.getTime() + 7 * 86400000)) });
  const today = q({ date: dayStr(startOfDay(now)) });
  const dayView = q({ view: null, date: dayStr(startOfDay(now)) });
  
  // Obtener citas para los 7 días
  const weekAppts: Record<string, Appt[]> = {};
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(startDay.getTime() + i * 86400000);
    const dayKey = dayStr(dayDate);
    const appts = await db.appointmentsForDay(env.DB, dayKey, withCancelled);
    weekAppts[dayKey] = stylistFilter 
      ? appts.filter((a) => a.stylist === stylistFilter)
      : appts;
  }
  
  // Construir tarjetas de día
  const dayCards = Array.from({ length: 7 }).map((_, i) => {
    const dayDate = new Date(startDay.getTime() + i * 86400000);
    const dayKey = dayStr(dayDate);
    const isToday = dayStr(dayDate) === dayStr(startOfDay(now));
    const dayNum = dayDate.getUTCDate();
    const dayName = DAYS[weekday(dayDate)];
    const appts = weekAppts[dayKey] || [];
    
    const apptsList = appts.map((a) => {
      const start = parseDT(a.starts_at);
      const time = hhmm(start);
      const status = a.status;
      return `<div class="day-appt ${status}">
        <span class="day-appt-time">${esc(time)}</span>
        <span class="day-appt-client">${esc(a.name)}</span>
        <span class="day-appt-service">${esc(a.service_name)}</span>
      </div>`;
    }).join("");
    
    const emptyMsg = !appts.length ? `<div class="day-empty">Sin citas</div>` : "";
    
    return `<div class="day-card${isToday ? " today" : ""}">
      <div class="day-card-header">
        ${esc(dayName.charAt(0).toUpperCase() + dayName.slice(1))}
        <span>${dayNum}</span>
      </div>
      <div class="day-appts">
        ${apptsList}
        ${emptyMsg}
      </div>
    </div>`;
  }).join("");
  
  const extraInputs = extras.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const allHref = q({ stylist: null });
  const stHref = (name: string) => q({ stylist: name });
  
  // Peluqueros en la semana + filtro activo
  const allWeekAppts = Object.values(weekAppts).flat();
  const dayStylists: string[] = [];
  for (const a of allWeekAppts) if (!dayStylists.includes(a.stylist)) dayStylists.push(a.stylist);
  if (stylistFilter && !dayStylists.includes(stylistFilter)) dayStylists.push(stylistFilter);
  
  const stylistBar = (dayStylists.length || stylistFilter) ? `
<div class="stylist-bar" id="stylist-bar" role="group" aria-label="Filtrar por peluquero">
  <span class="stylist-bar-label">Peluquero</span>
  <a class="chip${stylistFilter ? "" : " on"}" href="${allHref}"${stylistFilter ? "" : ' aria-current="true"'}>Todos</a>
  ${dayStylists.map((st) => `<a class="chip${st === stylistFilter ? " on" : ""}" href="${stHref(st)}"${st === stylistFilter ? ' aria-current="true"' : ""}>${esc(st)}</a>`).join("\n  ")}
</div>` : "";
  
  const filterNote = stylistFilter ? `
<div class="filter-note" id="filter-note">
  <span>Mostrando solo las citas de <strong>${esc(stylistFilter)}</strong>.</span>
  <a class="btn sec sm" href="${allHref}">Ver todos los peluqueros</a>
</div>` : "";
  
  const stats = allWeekAppts.filter((a) => a.status === "confirmed").length;
  const statsCancelled = allWeekAppts.filter((a) => a.status === "cancelled").length;
  const statsDone = allWeekAppts.filter((a) => a.status === "done").length;
  
  const body = `
<div class="top">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1">
    <div class="view-selector">
      <a class="view-btn" href="${dayView}" title="Vista de un día">📅 Día</a>
      <a class="view-btn active" href="${base}/?view=week${stylistFilter ? `&stylist=${encodeURIComponent(stylistFilter)}` : ""}" title="Vista semanal">📆 Semana</a>
    </div>
    <div class="date-nav">
      <a class="nav-arrow" href="${prevWeek}" aria-label="Semana anterior">‹</a>
      <span class="date-label">${esc(dayStr(startDay).slice(0, 10))} - ${esc(dayStr(new Date(startDay.getTime() + 6 * 86400000)).slice(0, 10))}</span>
      <a class="nav-arrow" href="${nextWeek}" aria-label="Semana siguiente">›</a>
    </div>
    <a class="btn sec sm" href="${today}">Hoy</a>
  </div>
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto">
    ${role === "admin" ? (withCancelled
      ? `<a class="btn sec sm" href="${q({ cancelled: null })}">Ocultar canceladas</a>`
      : `<a class="btn sec sm" href="${q({ cancelled: "1" })}">Ver canceladas</a>`) : ""}
    <a class="btn" href="${base}/nueva">➕ Nueva cita</a>
  </div>
</div>
${flash(url)}
${stylistBar}
${filterNote}
<div class="stats" id="agenda-stats">
  <div class="stat"><b>${stats}</b><span>Citas</span></div>
  ${role === "admin" ? `<div class="stat"><b>${statsCancelled}</b><span>Canceladas</span></div>` : ""}
  ${role === "admin" ? `<div class="stat"><b>${statsDone}</b><span>Realizadas</span></div>` : ""}
</div>
<div class="week-grid">
  ${dayCards}
</div>`;

  return html(layout(env, s, base, role, "agenda", `Agenda semanal`, body), 200,
    { "content-security-policy": CSP_AGENDA });
}

// ------------------------------------------------------------------ formulario de cita
function apptForm(
  env: Env, s: Settings, base: string, role: PanelRole, opts: {
    title: string; appt?: Appt; values?: Record<string, string>; errs?: string[];
    action: string; submit: string; extra?: string;
  },
): string {
  const v = opts.values ?? (opts.appt ? {
    date: opts.appt.starts_at.slice(0, 10),
    time: opts.appt.starts_at.slice(11, 16),
    service_id: opts.appt.service_id,
    stylist: opts.appt.stylist,
    name: opts.appt.name,
    phone: displayPhone(opts.appt.phone),
    notes: opts.appt.notes,
  } : {});
  const selectable = activeServices(s);
  const currentSvcId = v.service_id ?? "";
  const currentSvc = s.services.find((x) => x.id === currentSvcId);
  // Al editar una cita con un servicio ya desactivado, se mantiene como opción seleccionable.
  const extra: Service | null = !selectable.some((x) => x.id === currentSvcId) && currentSvc
    ? { ...currentSvc, active: false } : null;
  const svcOptions = [...selectable, ...(extra ? [extra] : [])].map((x) =>
    `<option value="${esc(x.id)}"${currentSvcId === x.id ? " selected" : ""}>${x.active === false
      ? `${esc(x.name)} (ya no se ofrece)`
      : `${esc(x.name)} · ${x.minutes} min · ${esc(x.price)}`}</option>`).join("");
  const stylists = [...s.stylists];
  if (opts.appt && opts.appt.stylist && !stylists.includes(opts.appt.stylist)) stylists.push(opts.appt.stylist);
  const stylistOptions = `<option value="">Primero que esté libre</option>` + stylists.map((x) =>
    `<option value="${esc(x)}"${v.stylist === x ? " selected" : ""}>${esc(x)}</option>`).join("");

  const body = `
<h1>${esc(opts.title)}</h1>
${errors(opts.errs ?? [])}
<form method="post" action="${opts.action}" novalidate id="appt-form">
  <div class="card">
    <p class="card-title">Servicio, peluquero y fecha</p>
    <div class="field"><label for="f-svc">Servicio *</label><select id="f-svc" name="service_id" required>${svcOptions}</select></div>
    <div class="grid2">
      <div class="field"><label for="f-st">Peluquero</label><select id="f-st" name="stylist">${stylistOptions}</select></div>
      <div class="field"><label for="f-date">Fecha *</label><input type="date" id="f-date" name="date" value="${esc(v.date ?? "")}" required></div>
    </div>
    <input type="hidden" id="f-time" name="time" value="${esc(v.time ?? "")}">
    <div class="field">
      <label>Hora disponible *</label>
      <p class="hint" id="slots-hint" style="margin:0 0 8px">Huecos disponibles según el servicio, el peluquero y la fecha elegidos.</p>
      <div id="slots" class="slot-grid"></div>
      <div id="slots-msg" class="slot-empty" role="status" aria-live="polite">Selecciona servicio y fecha para ver los huecos disponibles.</div>
    </div>
  </div>
  <div class="card">
    <p class="card-title">Datos del cliente</p>
    <div class="grid2">
      <div><label for="f-name">Cliente *</label><input type="text" id="f-name" name="name" value="${esc(v.name ?? "")}" required autocomplete="name"></div>
      <div><label for="f-phone">Teléfono</label><input type="text" id="f-phone" name="phone" value="${esc(v.phone ?? "")}" placeholder="600 111 222" inputmode="tel" autocomplete="tel"></div>
    </div>
    <div class="field"><label for="f-notes">Notas (opcional)</label><input type="text" id="f-notes" name="notes" value="${esc(v.notes ?? "")}" placeholder="Alergia, preferencias…"></div>
  </div>
  <div class="form-actions">
    <button class="btn" type="submit">${esc(opts.submit)}</button>
    <a class="btn sec" href="${base}/">Volver a la agenda</a>
    ${opts.extra ?? ""}
  </div>
</form>
<script>
(function(){
  var form=document.getElementById('appt-form');
  var dateEl=document.getElementById('f-date');
  var svcEl=document.getElementById('f-svc');
  var stEl=document.getElementById('f-st');
  var timeEl=document.getElementById('f-time');
  var slotsEl=document.getElementById('slots');
  var msgEl=document.getElementById('slots-msg');
  var base='${base}';
  var exclude='${opts.appt ? String(opts.appt.id) : ""}';
  var origDate='${opts.appt ? opts.appt.starts_at.slice(0,10) : ""}';
  var seq=0;
  function clearSlots(){ slotsEl.innerHTML=''; }
  function setMsg(t,err,retry){
    msgEl.textContent='';
    msgEl.className=err?'slot-error':'slot-empty';
    if(!t) return;
    msgEl.appendChild(document.createTextNode(t));
    if(retry){
      var b=document.createElement('button');
      b.type='button';
      b.className='btn sec sm';
      b.style.marginLeft='10px';
      b.textContent='Reintentar';
      b.onclick=function(){ load(); };
      msgEl.appendChild(b);
    }
  }
  function addBtn(h,active,note){
    var btn=document.createElement('button');
    btn.type='button';
    btn.className='slot-btn';
    btn.textContent=note||h;
    btn.onclick=function(){
      timeEl.value=h;
      var all=slotsEl.querySelectorAll('.slot-btn');
      for(var i=0;i<all.length;i++) all[i].classList.remove('active');
      btn.classList.add('active');
    };
    slotsEl.appendChild(btn);
    if(active) btn.classList.add('active');
  }
  async function load(){
    var d=dateEl.value, s=svcEl.value;
    if(!d||!s){ clearSlots(); setMsg('Selecciona fecha y servicio para ver los huecos disponibles.'); return; }
    var mine=++seq;
    clearSlots(); setMsg('Cargando huecos...');
    try{
      var url=base+'/slots?date='+encodeURIComponent(d)+'&service_id='+encodeURIComponent(s);
      if(stEl&&stEl.value) url+='&stylist='+encodeURIComponent(stEl.value);
      if(exclude) url+='&exclude='+encodeURIComponent(exclude);
      var r=await fetch(url,{headers:{'Accept':'application/json'},cache:'no-store',credentials:'same-origin'});
      if(mine!==seq) return;
      if(!r.ok){ setMsg('No se han podido cargar los huecos. Inténtalo de nuevo.',true,true); return; }
      var data=await r.json();
      if(mine!==seq) return;
      var slots=(data&&data.slots)||[];
      var current=timeEl.value;
      var keepCurrent=!!exclude && !!current && d===origDate && slots.indexOf(current)===-1;
      // Si la hora elegida ya no está libre, se descarta: evita reenviar un horario ocupado.
      if(!keepCurrent && slots.indexOf(current)===-1) timeEl.value='';
      if(!slots.length&&!keepCurrent){ setMsg('No hay horarios disponibles para esta selección.'); return; }
      setMsg('');
      if(keepCurrent){
        addBtn(current,true,current+' (hora actual)');
        timeEl.value=current;
        setMsg('Se mantiene la hora actual de la cita ('+current+'). Elige otro horario para cambiarla.');
      }
      slots.forEach(function(h){ addBtn(h,h===timeEl.value); });
    }catch(e){
      if(mine===seq) setMsg('No se han podido cargar los huecos. Inténtalo de nuevo.',true,true);
    }
  }
  if(dateEl) dateEl.addEventListener('change',load);
  if(svcEl) svcEl.addEventListener('change',load);
  if(stEl) stEl.addEventListener('change',load);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
</script>`;

  return layout(env, s, base, role, "nueva", opts.title, body);
}

interface ApptForm { [k: string]: string; date: string; time: string; service_id: string; stylist: string; name: string; phone: string; notes: string }

function readApptForm(fd: FormData): ApptForm {
  return {
    date: String(fd.get("date") ?? ""),
    time: String(fd.get("time") ?? ""),
    service_id: String(fd.get("service_id") ?? ""),
    stylist: String(fd.get("stylist") ?? ""),
    name: String(fd.get("name") ?? ""),
    phone: String(fd.get("phone") ?? ""),
    notes: String(fd.get("notes") ?? "").slice(0, 300),
  };
}

interface Valid { errs: string[]; name: string; phone: string; service?: Service; start?: Date }

function validate(v: ApptForm, s: Settings, now: Date, allowInactiveId?: string): Valid {
  const errs: string[] = [];
  const service = s.services.find((x) => x.id === v.service_id);
  const name = cleanName(v.name);
  const phone = normalizePhone(v.phone);
  let start: Date | undefined;

  if (!isValidDay(v.date)) errs.push("La fecha no es válida. Usa el formato AAAA-MM-DD.");
  if (!isValidTime(v.time)) errs.push("La hora no es válida. Usa el formato HH:MM.");
  if (!service) errs.push("El servicio no es válido.");
  else if (!isServiceActive(service) && v.service_id !== allowInactiveId) {
    errs.push("Ese servicio ya no está disponible para nuevas citas. Elige otro.");
  }
  if (!name) errs.push("El nombre no es válido (mínimo 2 letras).");
  if (phone === null) errs.push("El teléfono no es válido.");
  if (v.stylist && !s.stylists.includes(v.stylist)) errs.push("Ese peluquero no existe.");
  if (phone !== null && phone !== "" && !/^\+?\d{6,15}$/.test(phone.replace(/\s/g, ""))) errs.push("El teléfono no es válido.");

  if (isValidDay(v.date) && isValidTime(v.time) && service) {
    start = parseDT(`${v.date}T${v.time}`);
    const today = startOfDay(now);
    const apptDay = startOfDay(start);
    if (apptDay < today) {
      errs.push("No se pueden crear citas en fechas pasadas.");
    } else if (s.closedDates.includes(v.date)) {
      errs.push("El salón está cerrado ese día.");
    } else if (Math.floor((apptDay.getTime() - today.getTime()) / 86400000) > s.maxDaysAhead) {
      errs.push(`No se pueden crear citas con más de ${s.maxDaysAhead} días de antelación.`);
    } else {
      const day = parseDay(v.date);
      const from = start;
      const end = addMin(from, service.minutes);
      // Comprobar alineación con slotMinutes
      const minutesSinceMidnight = from.getUTCHours() * 60 + from.getUTCMinutes();
      if (minutesSinceMidnight % s.slotMinutes !== 0) {
        errs.push(`La hora debe ser múltiplo de ${s.slotMinutes} minutos.`);
      }
      const inHours = (st: string) =>
        stylistSpans(s, st, weekday(day)).some(([a, b]) => atTime(day, a).getTime() <= from.getTime() && end.getTime() <= atTime(day, b).getTime());
      if (v.stylist) {
        if (stylistClosed(s, v.stylist, v.date) || !inHours(v.stylist)) {
          errs.push("Ese peluquero no trabaja a esa hora ese día.");
        }
      } else if (!s.stylists.some((st) => !stylistClosed(s, st, v.date) && inHours(st))) {
        errs.push("Esa hora está fuera del horario de apertura.");
      }
    }
  }
  return { errs, name: name ?? "", phone: phone ?? "", service, start: errs.length ? undefined : start };
}

// ------------------------------------------------------------------ peluqueros
// ------------------------------------------------------------------ servicios (CRUD)
function serviciosPage(env: Env, s: Settings, base: string, role: PanelRole, url: URL): Response {
  const activeN = activeServices(s).length;
  const cards = s.services.map((svc) => {
    const on = isServiceActive(svc);
    const toggle = on
      ? (activeN > 1
        ? `<form method="post" action="${base}/servicios/${esc(svc.id)}/desactivar"><button class="btn-action cancel sm" type="submit">Desactivar</button></form>`
        : `<button class="btn-action" type="button" disabled title="Debe quedar al menos un servicio activo" style="opacity:.5;cursor:not-allowed">Desactivar</button>`)
      : `<form method="post" action="${base}/servicios/${esc(svc.id)}/activar"><button class="btn-action done sm" type="submit">Activar</button></form>`;
    return `<div class="svc-card${on ? "" : " off"}">
  <div style="flex:1 1 0;min-width:0">
    <div class="svc-name">${esc(svc.name)} ${on
      ? '<span class="svc-badge on">Activo</span>'
      : '<span class="svc-badge off">Inactivo</span>'}</div>
    <div class="svc-meta">${svc.minutes} min · ${esc(svc.price)}</div>
  </div>
  <div class="svc-actions">
    <a class="btn-action edit" href="${base}/servicios/${esc(svc.id)}">Editar</a>
    ${toggle}
    <a class="btn-action delete" href="${base}/servicios/${esc(svc.id)}/borrar">Eliminar</a>
  </div>
</div>`;
  }).join("");
  const body = `
${pageContext(base, "servicios")}
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:4px">
  <h1>Servicios</h1>
  <a class="btn" href="${base}/servicios/nuevo">➕ Añadir servicio</a>
</div>
<p class="sub">Los servicios activos aparecen en el bot de WhatsApp y en los formularios de cita. Desactiva uno para dejar de ofrecerlo sin romper las citas que ya existen.</p>
${flash(url)}
${activeN === 0 ? '<div class="alert err">No hay ningún servicio activo: el bot no podrá aceptar reservas hasta que actives uno.</div>' : ""}
${s.services.length
  ? `<div class="svc-list">${cards}</div>`
  : `<div class="empty"><p><strong>No hay servicios todavía.</strong></p><p>Usa el botón «Añadir servicio» para crear el primero.</p></div>`}`;
  return html(layout(env, s, base, role, "servicios", "Servicios", body));
}

function servicioFormPage(
  env: Env, s: Settings, base: string, role: PanelRole, opts: {
    title: string; action: string; submit: string;
    values?: Partial<{ id: string; name: string; minutes: string; price: string; active: string }>;
    errs?: string[]; isEdit?: boolean;
  }
): Response {
  const v = opts.values ?? {};
  const activeChecked = v.active !== "0";
  const priceVal = v.price ?? "";
  const body = `
<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
  <a class="btn sec sm" href="${base}/servicios">← Volver</a>
  <h1>${esc(opts.title)}</h1>
</div>
<p class="sub">Los cambios se guardan en la base de datos y se reflejan en WhatsApp al instante.</p>
${opts.errs?.length ? `<div class="alert err"><ul>${opts.errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
<div style="max-width:600px">
<form method="post" action="${esc(opts.action)}">
  <div class="card">
    ${opts.isEdit ? `<input type="hidden" name="svc_id" value="${esc(v.id ?? "")}">` : ""}
    <div class="field">
      <label for="s-name">Nombre del servicio *</label>
      <input type="text" id="s-name" name="svc_name" value="${esc(v.name ?? "")}" placeholder="ej. Corte de pelo mujer" required>
    </div>
    <div class="grid2">
      <div class="field">
        <label for="s-min">Duración (minutos) *</label>
        <input type="number" id="s-min" name="svc_minutes" value="${esc(v.minutes ?? "")}" min="5" max="480" required>
      </div>
      <div class="field">
        <label for="s-price">Precio</label>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="color:#6b7280;font-weight:600">€</span>
          <input type="text" id="s-price" name="svc_price" value="${esc(priceVal.replace(/€/g, '').trim())}" placeholder="ej. 18 o 18,50" inputmode="decimal">
        </div>
        <span class="hint">Introduce el importe sin el símbolo €.</span>
      </div>
    </div>
    <div class="field check-field">
      <label for="s-active"><input type="checkbox" id="s-active" name="svc_active" value="1"${activeChecked ? " checked" : ""}> Servicio activo</label>
      <span class="hint">Si lo desactivas, deja de ofrecerse en WhatsApp y en las citas nuevas; las citas existentes se conservan.</span>
    </div>
  </div>
  <div class="form-actions">
    <button class="btn" type="submit">${esc(opts.submit)}</button>
    <a class="btn sec" href="${base}/servicios">Cancelar</a>
  </div>
</form>
</div>`;
  return html(layout(env, s, base, role, "servicios", opts.title, body));
}

const MONTHS_ES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const DAYS_ES = ["lunes","martes","miércoles","jueves","viernes","sábado","domingo"];

function fmtDateES(iso: string): string {
  // iso = "YYYY-MM-DD"
  try {
    const d = parseDay(iso);
    const dow = DAYS_ES[weekday(d)];
    return `${dow.charAt(0).toUpperCase() + dow.slice(1)}, ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
  } catch {
    return iso;
  }
}

function datesInRange(from: string, to: string): string[] {
  const result: string[] = [];
  const start = parseDay(from).getTime();
  const end = parseDay(to).getTime();
  let cur = start;
  while (cur <= end && result.length < 366) {
    result.push(dayStr(new Date(cur)));
    cur += 86400000;
  }
  return result;
}


function slugify(name: string): string {
  return name.trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // quitar tildes
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "servicio";
}

function uniqueId(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

function parseServicio(fd: FormData, s: Settings, isEdit: boolean, currentId = ""): { svc?: Service; errs: string[] } {
  const errs: string[] = [];
  const name = String(fd.get("svc_name") ?? "").trim();
  const minutes = Number(fd.get("svc_minutes") ?? "");
  let price = String(fd.get("svc_price") ?? "").trim();
  if (!name) errs.push("El nombre es obligatorio.");
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) errs.push("La duración debe ser un número entero entre 5 y 480 minutos.");
  if (s.services.some((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== currentId)) {
    errs.push(`Ya existe un servicio llamado «${name}». Elige un nombre diferente.`);
  }
  // Normalizar precio: eliminar € duplicados y espacios
  price = price.replace(/€/g, '').replace(/\s+/g, ' ').trim();
  if (price && !/^\d+([.,]\d{1,2})?$/.test(price.replace(',', '.'))) {
    errs.push("El precio no es válido. Usa un número, por ejemplo 18 o 18,50.");
  } else if (price) {
    // Mantener formato con coma si ya tenía coma, sino conservar como se introduzca pero sin €
    if (price.includes(',')) {
      price = price.replace('.', ',');
    }
    // Formato final como antes: añadir € al mostrar/guardar en formato simple
    // Conservamos el valor tal como se guarda (puede ser "18 €" o "18,50 €" según lo que haya)
    // Si no lleva €, lo añadimos con espacio para mantener compatibilidad visual
    if (!/€/.test(price)) {
      price = price + " €";
    }
  }
  if (errs.length) return { errs };
  // Auto-generate ID on create; preserve current ID on edit
  const id = isEdit
    ? currentId
    : uniqueId(slugify(name), s.services.map((x) => x.id));
  const active = fd.get("svc_active") !== null;
  return { svc: { id, name, minutes, price, active }, errs: [] };
}


async function stylistsPage(env: Env, s: Settings, role: PanelRole, url: URL): Promise<Response> {
  const base = role === "admin" ? "/admin" : "/recepcion";
  const DAY_SHORT = ["Lu","Ma","Mi","Ju","Vi","Sá","Do"];

  function scheduleSummary(name: string): string {
    const hrs = s.stylistHours[name] ?? {};
    const hasAny = Object.keys(hrs).length > 0;
    if (!hasAny) return '<span class="hint">Sigue el horario general del salón</span>';
    const dots = DAY_SHORT.map((d, i) => {
      const spans = hrs[i] ?? [];
      const color = spans.length ? "#2563eb" : "#e5e7eb";
      const label = spans.length ? spans.map(([a,b]) => `${a}–${b}`).join(" y ") : "Libre";
      return `<span title="${d}: ${label}" style="display:inline-block;width:28px;height:28px;border-radius:50%;background:${color};color:${spans.length ? "#fff":"#9ca3af"};font-size:10px;font-weight:700;line-height:28px;text-align:center">${d}</span>`;
    }).join("");
    const closedN = (s.stylistClosedDates ?? {})[name]?.length ?? 0;
    return `<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:6px">${dots}${closedN ? `<span class="hint" style="margin-left:4px">${closedN} ausencia${closedN !== 1 ? "s" : ""}</span>` : ""}</div>`;
  }

  const body = `
${pageContext(base, "peluqueros")}
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:4px">
  <h1>Peluqueros</h1>
  <a class="btn" href="${base}/peluqueros/nuevo">➕ Añadir peluquero</a>
</div>
<p class="sub">Gestiona el personal y sus horarios. Los cambios afectan a la disponibilidad en WhatsApp.</p>
${flash(url)}
${s.stylists.length
  ? `<div class="stylist-list">
${s.stylists.map((st) => `<div class="stylist-card">
  <h3>👤 ${esc(st)}</h3>
  ${scheduleSummary(st)}
  <div class="stylist-card-actions" style="margin-top:12px">
    <a class="btn sec sm" href="${base}/peluqueros/${encodeURIComponent(st)}/horario">✏️ Horario</a>
    <a class="btn sec sm" href="${base}/peluqueros/${encodeURIComponent(st)}/ausencias">🗓️ Ausencias</a>
  </div>
</div>`).join("")}
</div>`
  : `<div class="empty"><p>No hay peluqueros. Añade el primero.</p></div>`}`;
  return html(layout(env, s, base, role, "peluqueros", "Peluqueros", body));
}


// CSS propio de la ficha de alta de peluquero (se inyecta solo en esa página).
const stylistNewCss = `
.sf-wrap{max-width:680px}
.sf-back{margin-bottom:10px}
.sf-intro{color:#6b7280;font-size:13.5px;margin:2px 0 18px}
.sf-card-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.sf-card-head h2{margin:0;font-size:15px;font-weight:700;color:#111827}
.sf-icon{width:34px;height:34px;border-radius:10px;background:#eff6ff;color:#1d4ed8;display:inline-flex;align-items:center;justify-content:center;font-size:17px;flex:0 0 auto}
.sf-req{color:#dc2626;font-weight:700}
.sf-field-err{display:flex;gap:6px;align-items:flex-start;margin:6px 0 0;color:#b91c1c;font-size:13px;font-weight:600}
.sf-field-err span{font-weight:400}
.sf-input-err{border-color:#dc2626!important;box-shadow:0 0 0 3px rgba(220,38,38,.10)}
.sf-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.sf-step{background:#f9fafb;border:1px solid #eef2f7;border-radius:10px;padding:12px 14px}
.sf-step b{display:block;font-size:13.5px;color:#111827;margin-bottom:2px}
.sf-step span{font-size:12.5px;color:#6b7280;line-height:1.45}
.sf-actions{margin-top:20px}
@media(max-width:820px){
  .sf-intro{margin-bottom:14px}
  .sf-step{padding:11px 12px}
}
`;

async function stylistNewPage(
  env: Env, s: Settings, role: PanelRole, base: string, rawName = "", errs: string[] = [],
): Promise<Response> {
  const hasErr = errs.length > 0;
  const errText = errs.join(" ");
  const errorBlock = hasErr
    ? `<div class="alert err" role="alert"><strong>No se pudo crear el peluquero.</strong><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";
  const body = `
<style>${stylistNewCss}</style>
<div class="sf-wrap">
  <div class="sf-back"><a class="btn sec sm" href="${base}/peluqueros">← Peluqueros</a></div>
  <h1>Añadir peluquero</h1>
  <p class="sf-intro">Crea la ficha del profesional. Solo necesitas su nombre: después podrás ajustar su horario semanal y sus ausencias.</p>
  ${errorBlock}
  <form method="post" action="${base}/peluqueros/nuevo">
    <div class="card">
      <div class="sf-card-head"><span class="sf-icon" aria-hidden="true">👤</span><h2>Datos del peluquero</h2></div>
      <div class="field" style="margin-bottom:4px">
        <label for="st-name">Nombre del peluquero <span class="sf-req" aria-hidden="true">*</span></label>
        <input id="st-name" type="text" name="name" value="${esc(rawName)}" placeholder="Ej.: Marta"
          required autocomplete="name"${hasErr ? ' autofocus aria-invalid="true"' : ""}
          class="${hasErr ? "sf-input-err" : ""}" aria-describedby="st-name-hint">
        ${hasErr ? `<p class="sf-field-err" role="alert"><span aria-hidden="true">⚠</span> <span>${esc(errText)}</span></p>` : ""}
        <span class="hint" id="st-name-hint">Se mostrará tal cual en la agenda y en los mensajes de WhatsApp. No se permiten nombres repetidos.</span>
      </div>
    </div>
    <div class="card">
      <div class="sf-card-head"><span class="sf-icon" aria-hidden="true">🗓️</span><h2>Qué puedes configurar después</h2></div>
      <ul class="sf-steps">
        <li class="sf-step"><b>1. Horario</b><span>Define sus días y tramos de trabajo, o deja el horario general del salón.</span></li>
        <li class="sf-step"><b>2. Ausencias</b><span>Añade días libres o periodos de vacaciones cuando los necesite.</span></li>
        <li class="sf-step"><b>3. Agenda</b><span>Sus huecos aparecerán en el panel y en WhatsApp según su disponibilidad.</span></li>
      </ul>
    </div>
    <div class="form-actions sf-actions">
      <button class="btn lg" type="submit" style="background:#7c3aed">Guardar peluquero</button>
      <a class="btn sec lg" href="${base}/peluqueros">Cancelar</a>
    </div>
  </form>
</div>`;
  return formResponse(layout(env, s, base, role, "peluqueros", "Añadir peluquero", body), hasErr ? 422 : 200);
}

// CSS adicional para ausencias (se inyecta inline en la página)
const ausenciasCss = `
.aus-section{margin-bottom:20px}
.aus-section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;margin-bottom:8px}
.aus-list{display:flex;flex-direction:column;gap:6px}
.aus-item{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:11px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.aus-item.past{background:#f9fafb;color:#9ca3af}
.aus-date{font-size:14px;font-weight:600;color:#111827}
.aus-item.past .aus-date{color:#9ca3af}
.aus-del-btn{background:none;border:1px solid #fecaca;color:#dc2626;border-radius:7px;padding:5px 10px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;min-height:34px}
.aus-del-btn:hover{background:#fef2f2}
.aus-add-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.aus-add-card h3{font-size:14px;font-weight:700;color:#111827;margin:0 0 10px}
.aus-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.aus-row .field{flex:1 1 130px;margin:0}
.aus-row .btn{flex:0 0 auto;min-height:44px}
@media(max-width:820px){
  .aus-row{flex-direction:column;align-items:stretch}
  .aus-row .btn{width:100%;min-height:50px}
  .aus-del-btn{min-height:40px;padding:8px 12px}
}
`;

function ausenciasPage(
  env: Env, s: Settings, base: string, role: PanelRole,
  name: string, now: Date, msg?: string, errMsg?: string
): Response {
  const closed = [...((s.stylistClosedDates ?? {})[name] ?? [])].sort();
  const todayStr = dayStr(now);

  // Split into upcoming and past
  const upcoming = closed.filter((d) => d >= todayStr);
  const past = closed.filter((d) => d < todayStr);

  function renderList(dates: string[], isPast: boolean): string {
    if (!dates.length) return `<p class="hint" style="padding:8px 0">No hay fechas ${isPast ? "anteriores" : "registradas"}.</p>`;
    return `<div class="aus-list">${dates.map((d) => `
<div class="aus-item${isPast ? " past" : ""}">
  <span class="aus-date">${fmtDateES(d)}</span>
  <form method="post" action="${base}/peluqueros/${encodeURIComponent(name)}/ausencias/borrar">
    <input type="hidden" name="fecha" value="${esc(d)}">
    <button class="aus-del-btn" type="submit" title="Eliminar esta ausencia">✕ Quitar</button>
  </form>
</div>`).join("")}</div>`;
  }

  const body = `
<style>${ausenciasCss}</style>
<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
  <a class="btn sec sm" href="${base}/peluqueros/${encodeURIComponent(name)}/horario">← Horario</a>
  <a class="btn sec sm" href="${base}/peluqueros">Peluqueros</a>
  <h1 style="flex:1">Ausencias · ${esc(name)}</h1>
</div>
<p class="sub">Días en los que ${esc(name)} no estará disponible. Se bloquean automáticamente en WhatsApp y en el panel.</p>

${msg ? `<div class="alert ok">${esc(msg)}</div>` : ""}
${errMsg ? `<div class="alert err">${esc(errMsg)}</div>` : ""}

<div class="aus-add-card">
  <h3>➕ Añadir un día libre</h3>
  <form method="post" action="${base}/peluqueros/${encodeURIComponent(name)}/ausencias/dia">
    <div class="aus-row">
      <div class="field"><label for="au-date">Fecha</label><input type="date" id="au-date" name="fecha" required min="${todayStr}"></div>
      <button class="btn" type="submit">Añadir día libre</button>
    </div>
  </form>
</div>

<div class="aus-add-card">
  <h3>🏖️ Añadir periodo de vacaciones</h3>
  <form method="post" action="${base}/peluqueros/${encodeURIComponent(name)}/ausencias/periodo">
    <div class="aus-row">
      <div class="field"><label for="au-desde">Desde</label><input type="date" id="au-desde" name="desde" required min="${todayStr}"></div>
      <div class="field"><label for="au-hasta">Hasta</label><input type="date" id="au-hasta" name="hasta" required min="${todayStr}"></div>
      <button class="btn" type="submit">Añadir vacaciones</button>
    </div>
    <p class="hint" style="margin-top:6px">Se registrarán todos los días del periodo, incluyendo inicio y fin.</p>
  </form>
</div>

<div class="aus-section">
  <div class="aus-section-title">Próximas ausencias (${upcoming.length})</div>
  ${renderList(upcoming, false)}
</div>

${past.length ? `<div class="aus-section">
  <div class="aus-section-title" style="color:#9ca3af">Ausencias anteriores (${past.length})</div>
  ${renderList(past, true)}
</div>` : ""}`;

  return html(layout(env, s, base, role, "peluqueros", `Ausencias · ${name}`, body));
}

async function handleAusenciaAdd(
  req: Request, env: Env, s: Settings, base: string, role: PanelRole, name: string, now: Date
): Promise<Response> {
  const fd = await req.formData();
  const fecha = String(fd.get("fecha") ?? "").trim();
  if (!fecha || !isValidDay(fecha)) {
    return ausenciasPage(env, s, base, role, name, now, undefined, "Fecha no válida. Usa el selector de fecha.");
  }
  const current = new Set((s.stylistClosedDates ?? {})[name] ?? []);
  if (current.has(fecha)) {
    return ausenciasPage(env, s, base, role, name, now, undefined, `${fmtDateES(fecha)} ya estaba registrada como ausencia.`);
  }
  current.add(fecha);
  const next: Settings = { ...s, stylistClosedDates: { ...(s.stylistClosedDates ?? {}), [name]: [...current].sort() } };
  await saveSettings(env.DB, next);
  await db.audit(env.DB, now, role, "ausencia_añadir", null, `${name} · ${fecha}`);
  return redirect(`${base}/peluqueros/${encodeURIComponent(name)}/ausencias?ok=1&msg=${encodeURIComponent("Día libre añadido: " + fmtDateES(fecha))}`);
}

async function handleAusenciaPeriodo(
  req: Request, env: Env, s: Settings, base: string, role: PanelRole, name: string, now: Date
): Promise<Response> {
  const fd = await req.formData();
  const desde = String(fd.get("desde") ?? "").trim();
  const hasta = String(fd.get("hasta") ?? "").trim();
  if (!isValidDay(desde) || !isValidDay(hasta)) {
    return ausenciasPage(env, s, base, role, name, now, undefined, "Fechas no válidas. Usa el selector de fecha.");
  }
  if (desde > hasta) {
    return ausenciasPage(env, s, base, role, name, now, undefined, "La fecha de inicio no puede ser posterior a la de fin.");
  }
  const newDates = datesInRange(desde, hasta);
  const current = new Set((s.stylistClosedDates ?? {})[name] ?? []);
  const added = newDates.filter((d) => !current.has(d));
  for (const d of newDates) current.add(d);
  if (added.length === 0) {
    return ausenciasPage(env, s, base, role, name, now, undefined, "Todas las fechas del periodo ya estaban registradas.");
  }
  const next: Settings = { ...s, stylistClosedDates: { ...(s.stylistClosedDates ?? {}), [name]: [...current].sort() } };
  await saveSettings(env.DB, next);
  await db.audit(env.DB, now, role, "ausencia_periodo", null, `${name} · ${desde} → ${hasta} (${added.length} días)`);
  return redirect(`${base}/peluqueros/${encodeURIComponent(name)}/ausencias?ok=1&msg=${encodeURIComponent(added.length + " días añadidos del " + fmtDateES(desde) + " al " + fmtDateES(hasta))}`);
}

async function handleAusenciaBorrar(
  req: Request, env: Env, s: Settings, base: string, role: PanelRole, name: string, now: Date
): Promise<Response> {
  const fd = await req.formData();
  const fecha = String(fd.get("fecha") ?? "").trim();
  if (!fecha || !isValidDay(fecha)) {
    return redirect(`${base}/peluqueros/${encodeURIComponent(name)}/ausencias`);
  }
  const current = new Set((s.stylistClosedDates ?? {})[name] ?? []);
  if (!current.has(fecha)) {
    return redirect(`${base}/peluqueros/${encodeURIComponent(name)}/ausencias`);
  }
  current.delete(fecha);
  const next: Settings = { ...s, stylistClosedDates: { ...(s.stylistClosedDates ?? {}), [name]: [...current].sort() } };
  await saveSettings(env.DB, next);
  await db.audit(env.DB, now, role, "ausencia_borrar", null, `${name} · ${fecha}`);
  return redirect(`${base}/peluqueros/${encodeURIComponent(name)}/ausencias?ok=1&msg=${encodeURIComponent("Ausencia eliminada: " + fmtDateES(fecha))}`);
}


async function stylistSchedulePage(env: Env, s: Settings, role: PanelRole, name: string, errs: string[] = []): Promise<Response> {
  const base = role === "admin" ? "/admin" : "/recepcion";
  const hrs = s.stylistHours[name] ?? {};
  const closedDates = (s.stylistClosedDates ?? {})[name] ?? [];
  const closedCount = closedDates.length;
  const DAY_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  const DAY_FULL = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

  const dayCards = DAYS.map((_, i) => {
    const spans = hrs[i] ?? [];
    const s1 = spans[0] ?? ["", ""];
    const s2 = spans[1] ?? ["", ""];
    const hasHours = spans.length > 0;
    const workBadge = hasHours
      ? `<span style="display:inline-block;background:#d1fae5;color:#065f46;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;letter-spacing:.3px">TRABAJA</span>`
      : `<span style="display:inline-block;background:#fee2e2;color:#991b1b;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;letter-spacing:.3px">LIBRE</span>`;

    return `<div class="sched-day-card${hasHours ? "" : " libre"}">
  <div class="sched-day-head">
    <div style="display:flex;align-items:center;gap:10px">
      <span class="sched-day-name">${DAY_FULL[i]}</span>
      ${workBadge}
    </div>
  </div>
  <div class="sched-day-body">
    <div class="sched-span">
      <span class="sched-span-label">Turno 1</span>
      <div class="sched-time-row">
        <input type="time" name="s1_start_${i}" value="${s1[0]}" class="sched-time" placeholder="--:--">
        <span class="sched-sep">–</span>
        <input type="time" name="s1_end_${i}" value="${s1[1]}" class="sched-time" placeholder="--:--">
      </div>
    </div>
    <div class="sched-span">
      <span class="sched-span-label">Turno 2 <span class="hint" style="font-weight:400">(opcional)</span></span>
      <div class="sched-time-row">
        <input type="time" name="s2_start_${i}" value="${s2[0]}" class="sched-time" placeholder="--:--">
        <span class="sched-sep">–</span>
        <input type="time" name="s2_end_${i}" value="${s2[1]}" class="sched-time" placeholder="--:--">
      </div>
    </div>
  </div>
</div>`;
  }).join("");

  const schedCss = `
.sched-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:20px}
.sched-day-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.sched-day-card.libre{background:#fafafa;border-color:#f3f4f6}
.sched-day-head{margin-bottom:12px}
.sched-day-name{font-size:16px;font-weight:700;color:#111827}
.sched-day-body{display:flex;flex-direction:column;gap:10px}
.sched-span{display:flex;flex-direction:column;gap:4px}
.sched-span-label{font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
.sched-time-row{display:flex;align-items:center;gap:6px}
.sched-time{width:auto;flex:1;min-width:80px;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:8px;font:inherit;font-size:15px;font-variant-numeric:tabular-nums;background:#fff;color:#111827}
.sched-time:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.sched-sep{color:#9ca3af;font-weight:600;font-size:16px;flex-shrink:0}
@media(max-width:820px){
  .sched-grid{grid-template-columns:1fr}
  .sched-time{font-size:16px;min-height:44px}
}`;

  const body = `
<style>${schedCss}</style>
<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
  <a class="btn sec sm" href="${base}/peluqueros">← Volver</a>
  <h1>Horario de ${esc(name)}</h1>
</div>
<p class="sub">Deja los campos vacíos en los días que ${esc(name)} no trabaje. Si todos los turnos están vacíos, se aplica el horario general del salón.</p>
${errs.length ? `<div class="alert err"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
<form method="post" action="${base}/peluqueros/${encodeURIComponent(name)}/horario">
  <div class="sched-grid">${dayCards}</div>
  <div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div>
      <p class="card-title" style="margin-bottom:4px">Vacaciones y días libres</p>
      <p class="hint">${closedCount} ausencia${closedCount !== 1 ? "s" : ""} registrada${closedCount !== 1 ? "s" : ""}. Gestiónalas en la sección dedicada.</p>
    </div>
    <a class="btn sec" href="${base}/peluqueros/${encodeURIComponent(name)}/ausencias">🗓️ Gestionar ausencias</a>
  </div>
  <div class="form-actions">
    <button class="btn" type="submit">💾 Guardar horario</button>
    <a class="btn sec" href="${base}/peluqueros">Cancelar</a>
  </div>
</form>`;

  return html(layout(env, s, base, role, "peluqueros", `Horario · ${name}`, body), errs.length ? 422 : 200);
}


async function handleStylistScheduleUpdate(req: Request, env: Env, s: Settings, role: PanelRole, name: string): Promise<Response> {
  const base = role === "admin" ? "/admin" : "/recepcion";
  const fd = await req.formData();
  const hours: Record<number, [string, string][]> = {};
  const errs: string[] = [];

  for (let i = 0; i < 7; i++) {
    const spans: [string, string][] = [];
    const s1s = String(fd.get(`s1_start_${i}`) ?? "").trim();
    const s1e = String(fd.get(`s1_end_${i}`) ?? "").trim();
    if (s1s || s1e) {
      if (!s1s || !s1e) { errs.push(`${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"][i]}: rellena tanto el inicio como el fin del turno 1.`); }
      else if (s1s >= s1e) { errs.push(`${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"][i]}: el turno 1 debe terminar después de empezar.`); }
      else { spans.push([s1s, s1e]); }
    }
    const s2s = String(fd.get(`s2_start_${i}`) ?? "").trim();
    const s2e = String(fd.get(`s2_end_${i}`) ?? "").trim();
    if (s2s || s2e) {
      if (!s2s || !s2e) { errs.push(`${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"][i]}: rellena tanto el inicio como el fin del turno 2.`); }
      else if (s2s >= s2e) { errs.push(`${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"][i]}: el turno 2 debe terminar después de empezar.`); }
      else if (spans.length && s2s < spans[0][1]) { errs.push(`${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"][i]}: el turno 2 no puede solaparse con el turno 1.`); }
      else { spans.push([s2s, s2e]); }
    }
    if (spans.length) hours[i] = spans;
  }

  if (errs.length) return await stylistSchedulePage(env, s, role, name, errs);

  // Preserve existing closed dates — managed separately via /ausencias routes
  const next: Settings = {
    ...s,
    stylistHours: { ...s.stylistHours, [name]: hours },
    stylistClosedDates: s.stylistClosedDates ?? {},
  };
  await saveSettings(env.DB, next);
  await db.audit(env.DB, nowLocal(env.SALON_TZ), role, "editar_horario_peluquero", null,
    `${name} · ${Object.keys(hours).length} días configurados`);
  return redirect(`${base}/peluqueros?ok=horario_guardado`);
}


async function handleStylistNew(req: Request, env: Env, s: Settings, base: string, role: PanelRole): Promise<Response> {
  const fd = await req.formData();
  const name = String(fd.get("name") ?? "").replace(/\s+/g, " ").trim();
  const errs: string[] = [];
  if (!name) errs.push("El nombre no puede estar vacío.");
  if (s.stylists.map((x) => x.toLowerCase()).includes(name.toLowerCase())) errs.push("Ya existe un peluquero con ese nombre.");
  if (errs.length) return await stylistNewPage(env, s, role, base, name, errs);
  const next = { ...s, stylists: [...s.stylists, name] };
  await saveSettings(env.DB, next);
  await db.audit(env.DB, nowLocal(env.SALON_TZ), role, "crear_peluquero", null, name);
  return redirect(`${base}/peluqueros?ok=peluquero_creado`);
}

// ------------------------------------------------------------------ ajustes
function hoursText(s: Settings): string[] {
  return DAYS.map((_, i) => (s.hours[i] ?? []).map(([a, b]) => `${a}-${b}`).join(" y "));
}

function parseSettings(fd: FormData, cur: Settings): { s?: Settings; errs: string[] } {
  const errs: string[] = [];

  const services: Service[] = [];
  const svcIds = fd.getAll("svc_id[]");
  const svcNames = fd.getAll("svc_name[]");
  const svcMinutes = fd.getAll("svc_minutes[]");
  const svcPrices = fd.getAll("svc_price[]");
  if (svcIds.length > 0) {
    const n = svcIds.length;
    if (svcNames.length !== n || svcMinutes.length !== n || svcPrices.length !== n) {
      errs.push("Formulario de servicios incompleto. Recarga la página e inténtalo de nuevo.");
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const id = String(svcIds[i] ?? "").trim();
        const name = String(svcNames[i] ?? "").trim();
        const minutes = Number(svcMinutes[i] ?? "");
        const price = String(svcPrices[i] ?? "").trim();
        if (!id || !name || !Number.isInteger(minutes) || minutes <= 0) {
          errs.push(`Servicio ${i + 1}: campos obligatorios (id, nombre, minutos) y duración entera positiva.`);
          continue;
        }
        if (seen.has(id.toLowerCase())) {
          errs.push(`Servicio ${i + 1}: identificador duplicado «${id}».`);
          continue;
        }
        seen.add(id.toLowerCase());
        const prev = cur.services.find((x) => x.id === id);
        services.push({ id, name, minutes, price, active: prev ? isServiceActive(prev) : true });
      }
    }
  } else {
    const svcRaw = String(fd.get("services") ?? "").split(/\r?\n/);
    for (let i = 0; i < svcRaw.length; i++) {
      const line = svcRaw[i].trim();
      if (!line) continue;
      const parts = line.split("|").map((x) => x.trim());
      const minutes = Number(parts[2]);
      if (parts.length !== 4 || !parts[0] || !parts[1] || !Number.isInteger(minutes) || minutes <= 0) {
        errs.push(`Servicio, línea ${i + 1}: usa «id | nombre | minutos | precio».`);
        continue;
      }
      const prev = cur.services.find((x) => x.id === parts[0]);
      services.push({ id: parts[0], name: parts[1], minutes, price: parts[3] || "", active: prev ? isServiceActive(prev) : true });
    }
  }
  // Quitar una línea aquí NO borra el servicio: se desactiva, para no romper citas ni informes.
  const kept = new Set(services.map((x) => x.id));
  for (const prev of cur.services) {
    if (!kept.has(prev.id)) services.push({ ...prev, active: false });
  }
  if (!errs.length && !services.length) errs.push("Debe haber al menos un servicio.");

  const stylists = String(fd.get("stylists") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!stylists.length) errs.push("Indica al menos un peluquero (separados por comas).");

  const hours: Record<number, [string, string][]> = {};
  for (let i = 0; i < 7; i++) {
    const raw = String(fd.get(`hours${i}`) ?? "").trim();
    hours[i] = [];
    if (!raw) continue;
    for (const chunk of raw.split(" y ")) {
      const m = chunk.trim().match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
      if (!m || !isValidTime(m[1]) || !isValidTime(m[2]) || m[1] >= m[2]) {
        errs.push(`El horario de ${DAYS[i]} «${chunk.trim()}» no es un tramo válido (usa HH:MM-HH:MM y empieza antes de terminar).`);
        continue;
      }
      (hours[i] as [string, string][]).push([m[1], m[2]]);
    }
  }

  const closedDates: string[] = [];
  for (const line of String(fd.get("closedDates") ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!isValidDay(t)) errs.push(`Fecha de cierre no válida: «${t}» (usa AAAA-MM-DD).`);
    else closedDates.push(t);
  }

  const stylistHours: Record<string, Record<number, [string, string][]>> = {};
  const stylistClosedDates: Record<string, string[]> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value !== "string") continue;
    if (key.startsWith("sh|")) {
      const [, enc, day] = key.split("|");
      const st = decodeURIComponent(enc);
      const i = Number(day);
      const raw = value.trim();
      if (!raw || !Number.isInteger(i) || i < 0 || i > 6) continue;
      const spans: [string, string][] = [];
      for (const chunk of raw.split(" y ")) {
        const m = chunk.trim().match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
        if (!m || !isValidTime(m[1]) || !isValidTime(m[2]) || m[1] >= m[2]) {
          errs.push(`El horario de ${st} (${DAYS[i]}) «${chunk.trim()}» no es un tramo válido (usa HH:MM-HH:MM).`);
          continue;
        }
        spans.push([m[1], m[2]]);
      }
      if (spans.length) (stylistHours[st] ??= {})[i] = spans;
    } else if (key.startsWith("sc|")) {
      const st = decodeURIComponent(key.slice(3));
      const dates: string[] = [];
      for (const line of value.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (!isValidDay(t)) errs.push(`Fecha de vacaciones de ${st} no válida: «${t}» (usa AAAA-MM-DD).`);
        else dates.push(t);
      }
      if (dates.length) stylistClosedDates[st] = dates;
    }
  }

  const num = (name: string, min: number, max: number): number => {
    const n = Number(fd.get(name));
    if (!Number.isInteger(n) || n < min || n > max) {
      errs.push(`«${name}» debe ser un número entero entre ${min} y ${max}.`);
      return min;
    }
    return n;
  };
  const slotMinutes = num("slotMinutes", 5, 120);
  const maxDaysAhead = num("maxDaysAhead", 1, 90);
  const minNoticeMinutes = num("minNoticeMinutes", 0, 10080);
  const maxActive = num("maxActive", 1, 20);

  const salonName = String(fd.get("salonName") ?? "").trim();
  const address = String(fd.get("address") ?? "").trim();
  const phone = String(fd.get("phone") ?? "").trim();
  if (!salonName) errs.push("El nombre del salón no puede estar vacío.");

  const ttlRaw = String(fd.get("sessionTtlMinutes") ?? "").trim();
  const sessionTtlMinutes = ttlRaw === "" ? cur.sessionTtlMinutes : Number(ttlRaw);
  if (!Number.isInteger(sessionTtlMinutes) || sessionTtlMinutes < 10) errs.push("«sessionTtlMinutes» debe ser un número entero válido.");

  if (errs.length) return { errs };
  return {
    s: {
      salonName, address, phone, services, stylists, hours, stylistHours, stylistClosedDates, closedDates,
      slotMinutes, maxDaysAhead, minNoticeMinutes, maxActive, sessionTtlMinutes,
    },
    errs,
  };
}

function settingsForm(s: Settings, raw: Record<string, string>, errs: string[]): string {
  const val = (k: string, d: string) => esc(raw[k] ?? d);
  const closedText = raw.closedDates ?? s.closedDates.join("\n");
  const hours = DAYS.map((d, i) => `<span>${d.charAt(0).toUpperCase() + d.slice(1)}</span>
<input type="text" name="hours${i}" value="${val(`hours${i}`, hoursText(s)[i])}" placeholder="10:00-20:00 o vacío si cierras">`).join("\n");
  const servicesText = raw.services ?? s.services
    .map((x) => `${x.id} | ${x.name} | ${x.minutes} | ${x.price}`).join("\n");
  const stylistBlocks = s.stylists.map((st) => {
    const key = encodeURIComponent(st);
    const hrs = s.stylistHours[st] ?? {};
    const cells = DAYS.map((d, i) => {
      const dflt = (hrs[i] ?? []).map(([a, b]) => `${a}-${b}`).join(" y ");
      return `<span>${d.charAt(0).toUpperCase() + d.slice(1)}</span>
<input type="text" name="sh|${key}|${i}" value="${val(`sh|${key}|${i}`, dflt)}" placeholder="vacío = sigue el horario general">`;
    }).join("\n");
    const closedDflt = (s.stylistClosedDates[st] ?? []).join("\n");
    return `<div class="card">
    <h2 style="margin-top:0">Horario de ${esc(st)}</h2>
    <p class="note">Si rellenas algún día aquí, los que dejes vacíos serán su día libre. Si lo dejas todo vacío, ${esc(st)} sigue el horario general del salón.</p>
    <div class="hours">${cells}</div>
    <label for="a-c-${key}">Vacaciones de ${esc(st)} (uno por línea, AAAA-MM-DD)</label>
    <textarea id="a-c-${key}" name="sc|${key}" rows="2" spellcheck="false">${esc(raw[`sc|${key}`] ?? closedDflt)}</textarea>
  </div>`;
  }).join("\n");

  return `
<h1>Ajustes</h1>
<p class="sub">Datos del salón, servicios, peluqueros y horarios. Los cambios afectan al bot de WhatsApp al instante.</p>
${errors(errs)}
<form method="post" action="/admin/ajustes" class="stack">
  <div class="card">
    <h2 style="margin-top:0">Datos del salón</h2>
    <div class="grid3">
      <div><label for="a-name">Nombre</label><input type="text" id="a-name" name="salonName" value="${val("salonName", s.salonName)}"></div>
      <div><label for="a-addr">Dirección</label><input type="text" id="a-addr" name="address" value="${val("address", s.address)}"></div>
      <div><label for="a-phone">Teléfono</label><input type="text" id="a-phone" name="phone" value="${val("phone", s.phone)}"></div>
    </div>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Servicios</h2>
    <p class="note">Para añadir, editar, activar o desactivar servicios usa la página <a href="/admin/servicios"><strong>Servicios</strong></a>, pensada para el móvil. Aquí solo queda la edición avanzada en texto.</p>
    <label for="a-services">Formato avanzado: id | nombre | minutos | precio (una línea por servicio)</label>
    <textarea id="a-services" name="services" rows="${Math.max(3, s.services.length + 1)}" spellcheck="false">${esc(servicesText)}</textarea>
    <span class="hint">Si quitas una línea, el servicio se <strong>desactiva</strong> (no se borra) para conservar sus citas e informes. Para eliminarlo definitivamente, usa la página Servicios.</span>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Peluqueros y horario</h2>
    <label for="a-st">Peluqueros (separados por comas)</label>
    <input type="text" id="a-st" name="stylists" value="${val("stylists", s.stylists.join(", "))}">
    <div class="hours" style="margin-top:16px">${hours}</div>
    <label for="a-closed">Días cerrados (uno por línea, AAAA-MM-DD)</label>
    <textarea id="a-closed" name="closedDates" rows="3" spellcheck="false">${esc(closedText)}</textarea>
  </div>
  ${stylistBlocks}
  <div class="card">
    <h2 style="margin-top:0">Reglas de reserva</h2>
    <div class="grid2">
      <div><label for="a-slot">Minutos por hueco</label><input type="number" id="a-slot" name="slotMinutes" min="5" max="120" value="${val("slotMinutes", String(s.slotMinutes))}"></div>
      <div><label for="a-ahead">Días máximos por delante</label><input type="number" id="a-ahead" name="maxDaysAhead" min="1" max="90" value="${val("maxDaysAhead", String(s.maxDaysAhead))}"></div>
      <div><label for="a-notice">Antelación mínima (minutos)</label><input type="number" id="a-notice" name="minNoticeMinutes" min="0" max="10080" value="${val("minNoticeMinutes", String(s.minNoticeMinutes))}"></div>
      <div><label for="a-max">Citas máximas por cliente</label><input type="number" id="a-max" name="maxActive" min="1" max="20" value="${val("maxActive", String(s.maxActive))}"></div>
    </div>
  </div>
  <div class="actions"><button class="btn" type="submit">Guardar ajustes</button>
  <a class="btn sec" href="/admin/">Volver a la agenda</a></div>
</form>`;
}

// ------------------------------------------------------------------ historial
function historialPage(env: Env, s: Settings, role: PanelRole, rows: Awaited<ReturnType<typeof db.listAudit>>): string {
  const who = (r: string) => r === "whatsapp" ? "Cliente (WhatsApp)" : r === "staff" ? "Recepción" : "Admin";
  const body = `
<h1>Historial</h1>
<p class="sub">Quién ha hecho qué, de los últimos ${rows.length} cambios.</p>
${rows.length ? `<table>
<thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Cita</th><th>Detalle</th></tr></thead>
<tbody>${rows.map((r) => `<tr>
<td class="mono">${esc(r.at.replace("T", " "))}</td>
<td><span class="pill ${r.role === "whatsapp" ? "src-whatsapp" : r.role === "admin" ? "src-admin" : "src-staff"}">${esc(who(r.role))}</span></td>
<td>${esc(r.action)}</td>
<td class="mono">${r.appt_id ?? "—"}</td>
<td class="note">${esc(r.detail)}</td>
</tr>`).join("")}</tbody></table>`
: `<div class="empty"><p><strong>Todavía no hay movimientos.</strong></p></div>`}`;

  return layout(env, s, "/admin", role, "historial", "Historial", body);
}

// ------------------------------------------------------------------ informes
function reportRange(url: URL, now: Date): { from: string; to: string } {
  const today = startOfDay(now);
  let from = url.searchParams.get("from") ?? "";
  let to = url.searchParams.get("to") ?? "";
  if (!isValidDay(from)) from = dayStr(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
  if (!isValidDay(to)) to = dayStr(today);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function informesBody(s: Settings, from: string, to: string, list: Appt[]): string {
  const confirmed = list.filter((a) => a.status === "confirmed" || a.status === "done");
  const cancelled = list.filter((a) => a.status === "cancelled").length;
  const income = confirmed.reduce((t, a) => t + priceOf(s, a), 0);
  const hours = (confirmed.reduce((t, a) => t + durationMin(a), 0) / 60).toFixed(1).replace(".", ",");

  const tally = (key: (a: Appt) => string) => {
    const m = new Map<string, { n: number; income: number }>();
    for (const a of confirmed) {
      const c = m.get(key(a)) ?? { n: 0, income: 0 };
      c.n++; c.income += priceOf(s, a); m.set(key(a), c);
    }
    return [...m].sort((x, y) => y[1].income - x[1].income || y[1].n - x[1].n);
  };
  const table = (label: string, rows: [string, { n: number; income: number }][]) => rows.length
    ? `<table><thead><tr><th>${label}</th><th>Citas</th><th>Ingresos</th></tr></thead><tbody>${rows.map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td class="mono">${v.n}</td><td class="mono">${esc(euro(v.income))}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty"><p class="note">Sin citas en este periodo.</p></div>`;

  return `
<div class="top"><h1>Informes</h1></div>
<p class="sub">Resumen de citas e ingresos entre dos fechas. Los ingresos se calculan con el precio actual de cada servicio.</p>
<form method="get" action="/admin/informes" class="top" style="margin-bottom:6px">
  <label for="i-from">Desde</label><input type="date" id="i-from" name="from" value="${esc(from)}" style="width:auto">
  <label for="i-to">Hasta</label><input type="date" id="i-to" name="to" value="${esc(to)}" style="width:auto">
  <button class="btn" type="submit">Ver informe</button>
  <a class="btn sec" href="/admin/informes.csv?from=${esc(from)}&to=${esc(to)}">Descargar CSV</a>
</form>
<div class="stats">
  <div class="stat"><b>${confirmed.length}</b><span>Citas</span></div>
  <div class="stat"><b>${cancelled}</b><span>Canceladas</span></div>
  <div class="stat"><b>${esc(euro(income))}</b><span>Ingresos</span></div>
  <div class="stat"><b>${esc(hours)} h</b><span>Reservado</span></div>
</div>
<h2>Por peluquero</h2>
${table("Peluquero", tally((a) => a.stylist))}
<h2>Por servicio</h2>
${table("Servicio", tally((a) => a.service_name))}`;
}

// ------------------------------------------------------------------ enrutador
function ipOf(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
}

function tooManyPage(): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demasiadas peticiones</title><style>${css}</style></head>
<body><div class="login-wrap"><div class="login">
<h1>Demasiadas peticiones</h1>
<p class="sub">Has hecho demasiadas peticiones en poco tiempo. Espera un minuto y vuelve a probar.</p>
</div></div></body></html>`;
}

async function rateGate(req: Request, env: Env, session: PanelRole | null, now: Date): Promise<boolean> {
  const sid = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)sid=([^;]+)/)?.[1] ?? "";
  const key = session ? `s:${sid}` : `i:${ipOf(req)}`;
  const limit = session ? RATE_SESSION_LIMIT : RATE_IP_LIMIT;
  return db.rateLimited(env.DB, key, now, limit, RATE_WINDOW_MS);
}

async function doLogin(req: Request, env: Env, base: string): Promise<Response> {
  if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
  const now = nowLocal(env.SALON_TZ);
  const ip = ipOf(req);
  if (await db.tooManyAttempts(env.DB, ip, now)) {
    return html(loginPage(env, base, "Demasiados intentos. Espera 15 minutos y vuelve a probar."), 429);
  }
  const fd = await req.formData();
  const password = String(fd.get("password") ?? "");
  const expected = base === "/admin" ? env.ADMIN_PASSWORD ?? "" : env.STAFF_PASSWORD ?? "";
  const ok = expected !== "" && password !== "" && (await safeEqual(expected, password, expected));
  if (!ok) {
    await db.recordFailure(env.DB, ip, now);
    return html(loginPage(env, base, "Contraseña incorrecta."), 401);
  }
  await db.clearAttempts(env.DB, ip);
  const role: PanelRole = base === "/admin" ? "admin" : "staff";
  return redirect(base + "/", { "set-cookie": await sessionCookie(env, role, req) });
}

async function createAppt(
  req: Request, env: Env, s: Settings, base: string, role: PanelRole,
): Promise<Response> {
  const fd = await req.formData();
  const v = readApptForm(fd);
  const now = nowLocal(env.SALON_TZ);
  const { errs, name, phone, service, start } = validate(v, s, now);
  if (errs.length || !service || !start) {
    return formResponse(apptForm(env, s, base, role, {
      title: "Nueva cita", values: v, errs: errs.length ? errs : ["Datos no válidos."],
      action: `${base}/nueva`, submit: "Crear cita",
    }), 422);
  }
  const appt = await db.createAppointment(env.DB, {
    phone, name, service, start,
    stylists: workingStylists(s, parseDay(v.date), start, service.minutes),
    stylist: v.stylist || undefined, source: role, notes: v.notes, now,
  });
  if (!appt) {
    return formResponse(apptForm(env, s, base, role, {
      title: "Nueva cita", values: v,
      errs: ["Todos los peluqueros están ocupados en esa hora. Elige otro tramo."],
      action: `${base}/nueva`, submit: "Crear cita",
    }), 422);
  }
  await db.audit(env.DB, now, role, "crear", appt.id,
    `${appt.name} · ${appt.service_name} · ${appt.starts_at} · ${appt.stylist}`);
  await notifyCreation(env, {
    id: appt.id, phone: appt.phone, service_id: appt.service_id, service_name: appt.service_name,
    stylist: appt.stylist, starts_at: appt.starts_at,
  });
  return redirect(`${base}/?date=${v.date}&ok=creada`);
}

async function editAppt(
  req: Request, env: Env, s: Settings, base: string, role: PanelRole, id: number,
): Promise<Response> {
  const current = await db.getAppt(env.DB, id);
  if (!current) return new Response("Cita no encontrada", { status: 404 });
  const fd = await req.formData();
  const v = readApptForm(fd);
  const now = nowLocal(env.SALON_TZ);
  const { errs, name, phone, service, start } = validate(v, s, now, current.service_id);
  if (errs.length || !service || !start) {
    return formResponse(apptForm(env, s, base, role, {
      title: `Editar cita #${id}`, values: v, errs: errs.length ? errs : ["Datos no válidos."],
      action: `${base}/cita/${id}`, submit: "Guardar cambios",
    }), 422);
  }
  const result = await db.updateAppointment(env.DB, id, {
    name, phone, service, stylist: v.stylist || current.stylist, start, notes: v.notes,
  }, now);
  if (result === "ok") {
    await db.audit(env.DB, now, role, "editar", id, `${name} · ${service.name} · ${v.date}T${v.time}`);
    const updated: NoticeAppt = {
      id, phone, service_id: service.id, service_name: service.name,
      stylist: v.stylist || current.stylist, starts_at: iso(start),
    };
    if (changedForNotice(current, updated)) await notifyUpdate(env, updated);
    return redirect(`${base}/?date=${v.date}&ok=guardada`);
  }
  const msg = result === "clash" ? "Esa hora se solapa con otra cita del mismo peluquero."
    : result === "cancelled" ? "La cita está cancelada: primero restáurala."
    : "La cita ya no existe.";
  return formResponse(apptForm(env, s, base, role, {
    title: `Editar cita #${id}`, values: v, errs: [msg],
    action: `${base}/cita/${id}`, submit: "Guardar cambios",
  }), result === "missing" ? 404 : 409);
}

export async function handlePanel(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/") return redirect("/admin/");
  const base = p === "/admin" || p.startsWith("/admin/") ? "/admin"
    : p === "/recepcion" || p.startsWith("/recepcion/") ? "/recepcion" : null;
  if (!base && p !== "/qr") return null;

  const segs = base ? p.slice(base.length).split("/").filter(Boolean) : [];
  const sub = segs[0] ?? "";
  const now = nowLocal(env.SALON_TZ);

  const session = await readSession(env, req);
  if (await rateGate(req, env, session, now)) {
    return html(tooManyPage(), 429, { "retry-after": "60" });
  }

  // CSRF protection for mutating POST requests (except login/logout which have their own checks)
  if (req.method === "POST" && base) {
    const mutatingPaths = [
      "/nueva",
      "/cita/",
      "/ajustes",
      "/peluqueros/",
      "/servicios/",
    ];
    const isMutating = mutatingPaths.some((mp) => p.startsWith(base + mp));
    if (isMutating && badOrigin(req)) {
      return new Response("Origen no permitido", { status: 403 });
    }
  }

  if (p === "/qr" && req.method === "GET") return qrPage(env);
  if (!base) return null;

  if (sub === "login") {
    if (req.method !== "POST") return html(loginPage(env, base));
    return doLogin(req, env, base);
  }
  if (sub === "logout" && req.method === "POST") {
    return redirect(base + "/login", { "set-cookie": clearCookie });
  }

  const need: PanelRole = base === "/admin" ? "admin" : "staff";
  const allowed = session !== null && (need === "admin" ? session === "admin" : true);

  if (!allowed) {
    if (req.method === "GET") return html(loginPage(env, base));
    return new Response("No autorizado", { status: 401 });
  }
  const role = session!;

  if (!sub && req.method === "GET") return agendaPage(env, await loadSettings(env), base, role, url, now);

  if (sub === "nueva") {
    const s = await loadSettings(env);
    if (req.method === "GET") {
      return formResponse(apptForm(env, s, base, role, {
        title: "Nueva cita", action: `${base}/nueva`, submit: "Crear cita",
        values: { date: url.searchParams.get("date") ?? dayStr(startOfDay(now)), time: "", service_id: activeServices(s)[0]?.id ?? "", stylist: "", name: "", phone: "", notes: "" },
      }));
    }
    if (req.method === "POST") return createAppt(req, env, s, base, role);
  }

  if (sub === "slots" && req.method === "GET") {
    const s = await loadSettings(env);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
    const date = url.searchParams.get("date") ?? "";
    const serviceId = url.searchParams.get("service_id") ?? "";
    const stylist = url.searchParams.get("stylist") ?? "";
    const exclude = url.searchParams.get("exclude");
    const excludeId = exclude && /^\d+$/.test(exclude) ? Number(exclude) : undefined;
    if (!isValidDay(date)) return json({ slots: [] }, 400);
    const svc = s.services.find((x) => x.id === serviceId);
    if (!svc) return json({ slots: [] }, 400);
    if (!isServiceActive(svc)) {
      // Un servicio desactivado solo puede consultarse al editar una cita que ya lo usaba.
      const current = excludeId === undefined ? null : await db.getAppt(env.DB, excludeId);
      if (!current || current.service_id !== svc.id) return json({ slots: [] }, 400);
    }
    if (stylist && !s.stylists.includes(stylist)) return json({ slots: [] }, 400);
    const day = parseDay(date);
    const daysAhead = Math.floor((startOfDay(day).getTime() - startOfDay(now).getTime()) / 86400000);
    if (daysAhead < 0 || daysAhead > s.maxDaysAhead) return json({ slots: [] });
    const slots = await freeSlots(env.DB, s, day, svc.minutes, now, excludeId, stylist || undefined);
    return json({ slots: slots.map((d) => hhmm(d)) });
  }

  if (sub === "agenda-json" && req.method === "GET") {
    const s = await loadSettings(env);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
    const raw = url.searchParams.get("date");
    const day = raw && isValidDay(raw) ? parseDay(raw) : startOfDay(now);
    const withCancelled = base === "/admin" && url.searchParams.get("cancelled") === "1";
    const stylistFilter = url.searchParams.get("stylist")?.trim() || "";
    const listAll = await db.appointmentsForDay(env.DB, dayStr(day), withCancelled);
    const list = stylistFilter ? listAll.filter((a) => a.stylist === stylistFilter) : listAll;
    const confirmed = list.filter((a) => a.status === "confirmed");
    const items = list.map((a) => {
      const start = parseDT(a.starts_at);
      const end = parseDT(a.ends_at);
      return {
        id: a.id,
        starts_at: a.starts_at,
        ends_at: a.ends_at,
        time: `${hhmm(start)}–${hhmm(end)}`,
        stylist: a.stylist,
        service_name: a.service_name,
        name: a.name,
        phone: a.phone,
        // Ya formateado en servidor: el refresco del navegador pinta lo mismo que el HTML inicial.
        phone_display: displayPhone(a.phone),
        source: a.source,
        notes: a.notes,
        status: a.status,
      };
    });
    // Contadores y «Próximas citas» con la misma lógica que el HTML inicial, para que el
    // refresco parcial no deje la pantalla a medias.
    const byStylist = new Map<string, number>();
    for (const a of listAll.filter((x) => x.status === "confirmed")) byStylist.set(a.stylist, (byStylist.get(a.stylist) ?? 0) + 1);
    const todayStart = startOfDay(now);
    const upcomingFrom = dayStr(day) >= dayStr(todayStart)
      ? dayStr(new Date(day.getTime() + 86400000))
      : dayStr(todayStart);
    const upcoming = await db.upcomingConfirmed(env.DB, upcomingFrom, 5);
    return json({
      date: dayStr(day),
      items,
      confirmed: confirmed.length,
      total: list.length,
      stats: {
        confirmed: confirmed.length,
        cancelled: listAll.filter((a) => a.status === "cancelled").length,
        done: listAll.filter((a) => a.status === "done").length,
        byStylist: [...byStylist].map(([name, count]) => ({ name, count })),
      },
      upcoming: upcoming.map((a) => ({
        id: a.id,
        date: a.starts_at.slice(0, 10),
        label: `${shortDay(parseDay(a.starts_at.slice(0, 10)), now)} · ${a.starts_at.slice(11, 16)}`,
        stylist: a.stylist,
        service_name: a.service_name,
        name: a.name,
        source: a.source,
      })),
      updatedAt: now.toISOString(),
    });
  }

  if (sub === "citas" && req.method === "GET") {
    const s = await loadSettings(env);
    const q = (url.searchParams.get("q") ?? "").trim();
    const found = q ? await db.searchAppointments(env.DB, { q, limit: 100 }) : [];
    const rows = found.map((a) => {
      const start = a.starts_at.replace("T", " ");
      const phone = displayPhone(a.phone);
      const cancelled = a.status === "cancelled";
      const done = a.status === "done";
      const badge = cancelled ? ' <span class="badge">Cancelada</span>' : (done ? ' <span class="badge ok">Realizada</span>' : "");
      return `<tr>
<td class="time">${esc(start)}</td>
<td>${esc(a.stylist)}</td>
<td>${esc(a.service_name)}</td>
<td>${esc(a.name)}${badge}</td>
<td class="mono">${esc(phone)}</td>
<td><div class="row-actions"><a class="btn sec" href="${base}/cita/${a.id}">Editar</a></div></td>
</tr>`;
    }).join("");
    const cards = found.map((a) => {
      const start = a.starts_at.replace("T", " ");
      const phone = displayPhone(a.phone);
      const cancelled = a.status === "cancelled";
      const done = a.status === "done";
      const badge = cancelled ? ' <span class="badge">Cancelada</span>' : (done ? ' <span class="badge ok">Realizada</span>' : "");
      return `<article class="search-item">
<div class="search-item-head"><span class="search-item-time">${esc(start)}</span><span class="search-item-client">${esc(a.name)}</span>${badge}</div>
<div class="search-item-meta">
<span>${esc(a.stylist)}</span>
<span>${esc(a.service_name)}</span>
${phone ? `<span class="mono">${esc(phone)}</span>` : ""}
</div>
<div class="search-item-actions"><a class="btn sec" href="${base}/cita/${a.id}">Editar cita</a></div>
</article>`;
    }).join("");
    const body = `
${pageContext(base, "citas")}
<h1>Buscar citas</h1>
<p class="sub">Busca por nombre o teléfono para encontrar citas rápidamente.</p>
<section class="search-panel">
  <form method="get" action="${base}/citas" class="search-row">
    <div style="flex:1 1 260px;min-width:0">
      <label for="q-search">Nombre o teléfono</label>
      <input id="q-search" type="search" name="q" value="${esc(q)}" placeholder="Ej.: Lucía o 600 111 222" autocomplete="off">
      <span class="hint">Se busca en nombre y teléfono tal como están guardados.</span>
    </div>
    <button class="btn" type="submit">Buscar</button>
  </form>
</section>
${!q ? `<div class="empty"><p>Escribe un nombre o un teléfono para buscar y pulsa «Buscar».</p></div>`
  : found.length ? `<table class="search-table"><thead><tr><th>Fecha y hora</th><th>Peluquero</th><th>Servicio</th><th>Cliente</th><th>Teléfono</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<div class="search-list">${cards}</div>`
  : `<div class="empty"><p><strong>No hay citas</strong> que coincidan con «${esc(q)}».</p><p class="note"><a class="btn sec" href="${base}/citas">Modificar búsqueda</a></p></div>`}`;
    return html(layout(env, s, base, role, "citas", "Buscar citas", body));
  }

  // ---- Servicios (admin y staff autenticado) ----
  if (sub === "servicios") {
    const s = await loadSettings(env);
    // List
    if (!segs[1]) return serviciosPage(env, s, base, role, url);

    // New
    if (segs[1] === "nuevo") {
      if (req.method === "GET") {
        return servicioFormPage(env, s, base, role, {
          title: "Añadir servicio", action: `${base}/servicios/nuevo`, submit: "Añadir servicio",
        });
      }
      if (req.method === "POST") {
        if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
        const fd = await req.formData();
        const { svc, errs } = parseServicio(fd, s, false);
        if (!svc || errs.length) {
          return servicioFormPage(env, s, base, role, {
            title: "Añadir servicio", action: `${base}/servicios/nuevo`, submit: "Añadir servicio",
            values: {
              name: String(fd.get("svc_name") ?? ""), minutes: String(fd.get("svc_minutes") ?? ""),
              price: String(fd.get("svc_price") ?? ""), active: fd.get("svc_active") !== null ? "1" : "0",
            },
            errs,
          });
        }
        const next: Settings = { ...s, services: [...s.services, svc] };
        await saveSettings(env.DB, next);
        await db.audit(env.DB, now, role, "crear_servicio", null, `${svc.name} · ${svc.minutes} min · ${svc.price}`);
        return redirect(`${base}/servicios?ok=servicio_creado`);
      }
    }

    const svcId = segs[1];
    const existingSvc = s.services.find((x) => x.id === svcId);

    // Activar / desactivar: retira el servicio sin borrar su historial.
    const toggle = segs[2];
    if ((toggle === "desactivar" || toggle === "activar") && existingSvc && req.method === "POST") {
      if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
      const wantActive = toggle === "activar";
      if (wantActive === isServiceActive(existingSvc)) {
        return redirect(`${base}/servicios?ok=${wantActive ? "servicio_activado" : "servicio_desactivado"}`);
      }
      if (!wantActive && activeServices(s).length <= 1) {
        return html(errorPage(env, s, base, role, "No se puede desactivar", [
          "Debe quedar al menos un servicio activo. Crea o activa otro servicio antes de desactivar este.",
        ], `${base}/servicios`), 422);
      }
      const next: Settings = {
        ...s,
        services: s.services.map((x) => x.id === svcId ? { ...x, active: wantActive } : x),
      };
      await saveSettings(env.DB, next);
      await db.audit(env.DB, now, role, wantActive ? "activar_servicio" : "desactivar_servicio", null, existingSvc.name);
      return redirect(`${base}/servicios?ok=${wantActive ? "servicio_activado" : "servicio_desactivado"}`);
    }

    // Delete (solo si no hay citas que lo usen: nunca se rompe el historial)
    if (segs[2] === "borrar" && existingSvc) {
      const uses = await db.countAppointmentsForService(env.DB, svcId);
      const blockers = uses > 0
        ? [`Este servicio tiene ${uses} cita${uses === 1 ? "" : "s"} (incluidas las canceladas) y no se puede eliminar sin romper su historial. Desactívalo para dejar de ofrecerlo conservando las citas.`]
        : s.services.length <= 1
          ? ["Debe quedar al menos un servicio. Crea otro antes de eliminar este."]
          : [];
      if (req.method === "GET") {
        if (blockers.length) {
          return html(errorPage(env, s, base, role, "No se puede eliminar", blockers, `${base}/servicios`), 409);
        }
        const body = `
<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
  <a class="btn sec sm" href="${base}/servicios">← Volver</a>
  <h1>¿Eliminar «${esc(existingSvc.name)}»?</h1>
</div>
<div class="alert err">Este servicio no tiene citas asociadas. Si solo quieres dejar de ofrecerlo, es más seguro <strong>desactivarlo</strong>.</div>
<div class="card">
  <div class="svc-name">${esc(existingSvc.name)}</div>
  <div class="svc-meta">${existingSvc.minutes} min · ${esc(existingSvc.price)} · ID: ${esc(existingSvc.id)}</div>
</div>
<form method="post" action="${base}/servicios/${esc(svcId)}/borrar" class="form-actions">
  <button class="btn danger" type="submit">Sí, eliminar servicio</button>
  <a class="btn sec" href="${base}/servicios">Cancelar</a>
</form>`;
        return html(layout(env, s, base, role, "servicios", "Eliminar servicio", body));
      }
      if (req.method === "POST") {
        if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
        if (blockers.length) {
          return html(errorPage(env, s, base, role, "No se puede eliminar", blockers, `${base}/servicios`), 409);
        }
        const next: Settings = { ...s, services: s.services.filter((x) => x.id !== svcId) };
        await saveSettings(env.DB, next);
        await db.audit(env.DB, now, role, "borrar_servicio", null, existingSvc.name);
        return redirect(`${base}/servicios?ok=servicio_borrado`);
      }
    }

    // Edit
    if (existingSvc) {
      if (req.method === "GET") {
        return servicioFormPage(env, s, base, role, {
          title: `Editar: ${existingSvc.name}`, action: `${base}/servicios/${esc(svcId)}`, submit: "Guardar cambios",
          values: {
            id: existingSvc.id, name: existingSvc.name, minutes: String(existingSvc.minutes),
            price: existingSvc.price, active: isServiceActive(existingSvc) ? "1" : "0",
          },
          isEdit: true,
        });
      }
      if (req.method === "POST") {
        if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
        const fd = await req.formData();
        const { svc, errs } = parseServicio(fd, s, true, existingSvc.id);
        const problems = [...errs];
        if (svc && svc.active === false && isServiceActive(existingSvc) && activeServices(s).length <= 1) {
          problems.push("Debe quedar al menos un servicio activo. Crea o activa otro antes de desactivar este.");
        }
        if (!svc || problems.length) {
          return servicioFormPage(env, s, base, role, {
            title: `Editar: ${existingSvc.name}`, action: `${base}/servicios/${esc(svcId)}`, submit: "Guardar cambios",
            values: {
              id: existingSvc.id, name: String(fd.get("svc_name") ?? ""),
              minutes: String(fd.get("svc_minutes") ?? ""), price: String(fd.get("svc_price") ?? ""),
              active: fd.get("svc_active") !== null ? "1" : "0",
            },
            errs: problems, isEdit: true,
          });
        }
        const next: Settings = { ...s, services: s.services.map((x) => x.id === svcId ? svc : x) };
        await saveSettings(env.DB, next);
        await db.audit(env.DB, now, role, "editar_servicio", null, `${svc.name} · ${svc.minutes} min`);
        return redirect(`${base}/servicios?ok=servicio_editado`);
      }
    }
    return new Response("No encontrado", { status: 404 });
  }

  // Peluqueros
  if (sub === "peluqueros") {
    if (req.method === "GET" && !segs[1]) return await stylistsPage(env, await loadSettings(env), role, url);
    if (segs[1] === "nuevo") {
      if (req.method === "GET") return await stylistNewPage(env, await loadSettings(env), role, base);
      if (req.method === "POST") {
        const s = await loadSettings(env);
        return handleStylistNew(req, env, s, base, role);
      }
    }
    if (segs[1] && segs[2] === "ausencias") {
      // ---- Ausencias / vacaciones ----
      const name = decodeURIComponent(segs[1]);
      const s = await loadSettings(env);
      if (!s.stylists.includes(name)) return new Response("Peluquero no encontrado", { status: 404 });
      const action = segs[3] ?? "";
      if (req.method === "GET" && !action) {
        const okMsg = url.searchParams.get("ok") ? decodeURIComponent(url.searchParams.get("msg") ?? "") : undefined;
        return ausenciasPage(env, s, base, role, name, now, okMsg);
      }
      if (req.method === "POST" && action === "dia") {
        if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
        return handleAusenciaAdd(req, env, s, base, role, name, now);
      }
      if (req.method === "POST" && action === "periodo") {
        if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
        return handleAusenciaPeriodo(req, env, s, base, role, name, now);
      }
      if (req.method === "POST" && action === "borrar") {
        if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
        return handleAusenciaBorrar(req, env, s, base, role, name, now);
      }
    }
    if (segs[2] === "horario") {
      const name = decodeURIComponent(segs[1]);
      const s = await loadSettings(env);
      if (!s.stylists.includes(name)) return new Response("Peluquero no encontrado", { status: 404 });
      if (req.method === "GET") return await stylistSchedulePage(env, s, role, name);
      if (req.method === "POST") return handleStylistScheduleUpdate(req, env, s, role, name);
    }
  }

  if (sub === "cita" && /^\d+$/.test(segs[1] ?? "")) {
    const id = Number(segs[1]);
    const action = segs[2] ?? "";
    const s = await loadSettings(env);
    const appt = await db.getAppt(env.DB, id);

    if (!action) {
      if (req.method === "POST") return editAppt(req, env, s, base, role, id);
      if (req.method === "GET") {
        if (!appt) return new Response("Cita no encontrada", { status: 404 });
        const extra = appt.status === "cancelled" && role === "admin"
          ? `<a class="btn sec" href="${base}/cita/${id}/restaurar">Restaurar</a>` : "";
        return formResponse(apptForm(env, s, base, role, {
          title: `Editar cita #${id}`, appt, action: `${base}/cita/${id}`, submit: "Guardar cambios", extra,
        }));
      }
    }

    if (action === "realizada") {
      if (req.method === "POST") {
        if (badOrigin(req)) return new Response("Origen no permitido", { status: 403 });
        if (!appt) return new Response("Cita no encontrada", { status: 404 });
        if (appt.status !== "confirmed") {
          return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&ok=realizada`);
        }
        const ok = await db.setStatus(env.DB, id, "done", now);
        if (ok) await db.audit(env.DB, now, role, "realizada", id, `${appt.name} · ${appt.starts_at}`);
        return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&ok=realizada`);
      }
      if (req.method === "GET") {
        if (!appt) return new Response("Cita no encontrada", { status: 404 });
        if (appt.status !== "confirmed") {
          return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}`);
        }
        const start = parseDT(appt.starts_at);
        const body = `
<h1>¿Marcar como realizada?</h1>
<p class="sub">Se marcará la cita como realizada. No se modifica la fecha, hora, servicio ni peluquero.</p>
<div class="card">
  <p><strong>${esc(appt.name)}</strong> · ${esc(appt.service_name)}</p>
  <p>${esc(fmtDay(start))} a las <span class="time">${hhmm(start)}</span> con ${esc(appt.stylist)}</p>
  <p class="note">${esc(displayPhone(appt.phone))}${appt.notes ? ` · ${esc(appt.notes)}` : ""}</p>
</div>
<form method="post" action="${base}/cita/${id}/realizada" class="actions">
  <button class="btn" type="submit">Sí, marcar como realizada</button>
  <a class="btn sec" href="${base}/">No, volver</a>
</form>`;
        return html(layout(env, s, base, role, "agenda", "Marcar como realizada", body));
      }
    }

    if (action === "cancelar") {
      if (req.method === "GET") {
        if (!appt) return new Response("Cita no encontrada", { status: 404 });
        const start = parseDT(appt.starts_at);
        const body = `
<h1>¿Cancelar esta cita?</h1>
<p class="sub">Esta acción se puede deshacer desde el panel de administración.</p>
<div class="card">
  <p><strong>${esc(appt.name)}</strong> · ${esc(appt.service_name)}</p>
  <p>${esc(fmtDay(start))} a las <span class="time">${hhmm(start)}</span> con ${esc(appt.stylist)}</p>
  <p class="note">${esc(displayPhone(appt.phone))}${appt.notes ? ` · ${esc(appt.notes)}` : ""}</p>
</div>
<form method="post" action="${base}/cita/${id}/cancelar" class="actions">
  <button class="btn danger" type="submit">Sí, cancelar la cita</button>
  <a class="btn sec" href="${base}/">No, volver</a>
</form>`;
        return html(layout(env, s, base, role, "agenda", "Cancelar cita", body));
      }
      if (req.method === "POST") {
        if (!appt) return new Response("Cita no encontrada", { status: 404 });
        const ok = await db.setStatus(env.DB, id, "cancelled", now);
        if (ok) {
          await db.audit(env.DB, now, role, "cancelar", id, `${appt.name} · ${appt.starts_at}`);
          await notifyCancellation(env, appt);
        }
        return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&ok=cancelada`);
      }
    }

    if (action === "restaurar" && role === "admin") {
      if (!appt) return new Response("Cita no encontrada", { status: 404 });

      // GET: solo confirmación, sin tocar datos. Mismo patrón que cancelar/borrar/realizada.
      if (req.method === "GET") {
        if (appt.status !== "cancelled") {
          return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&cancelled=1`);
        }
        const start = parseDT(appt.starts_at);
        const body = `
<h1>¿Restaurar esta cita?</h1>
<p class="sub">Volverá a la agenda como confirmada. Se comprobará que el hueco sigue libre.</p>
<div class="card">
  <p><strong>${esc(appt.name)}</strong> · ${esc(appt.service_name)}</p>
  <p>${esc(fmtDay(start))} a las <span class="time">${hhmm(start)}</span> con ${esc(appt.stylist)}</p>
  <p class="note">${esc(displayPhone(appt.phone))}${appt.notes ? ` · ${esc(appt.notes)}` : ""}</p>
</div>
<form method="post" action="${base}/cita/${id}/restaurar" class="actions">
  <button class="btn" type="submit">Sí, restaurar la cita</button>
  <a class="btn sec" href="${base}/?date=${appt.starts_at.slice(0, 10)}&cancelled=1">No, volver</a>
</form>`;
        return html(layout(env, s, base, role, "agenda", "Restaurar cita", body));
      }

      if (req.method === "POST") {
        // Solo se restaura lo que sigue cancelado; evita estados incoherentes con páginas obsoletas.
        if (appt.status !== "cancelled") {
          return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&cancelled=1`);
        }
        const ok = await db.setStatus(env.DB, id, "confirmed", now);
        if (!ok) {
          return html(errorPage(env, s, base, role, "No se puede restaurar",
            ["El hueco está ocupado por otra cita u otra cosa ha cambiado. Edítala o crea una nueva."],
            `${base}/?date=${appt.starts_at.slice(0, 10)}&cancelled=1`), 409);
        }
        await db.audit(env.DB, now, role, "restaurar", id, `${appt.name} · ${appt.starts_at}`);
        return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&ok=restaurada`);
      }
    }

    if (action === "borrar" && role === "admin") {
      if (!appt) return new Response("Cita no encontrada", { status: 404 });
      if (req.method === "GET") {
        const body = `
<h1>¿Borrar esta cita definitivamente?</h1>
<p class="err"><strong>Esto no se puede deshacer.</strong> Se eliminará el registro y quedará en el historial la acción.</p>
<div class="card">
  <p><strong>${esc(appt.name)}</strong> · ${esc(appt.service_name)}</p>
  <p>${esc(appt.starts_at.replace("T", " "))} con ${esc(appt.stylist)}</p>
</div>
<form method="post" action="${base}/cita/${id}/borrar" class="actions">
  <button class="btn danger" type="submit">Sí, borrar para siempre</button>
  <a class="btn sec" href="${base}/">No, volver</a>
</form>`;
        return html(layout(env, s, base, role, "agenda", "Borrar cita", body));
      }
      if (req.method === "POST") {
        await db.deleteAppointment(env.DB, id);
        await db.audit(env.DB, now, role, "borrar", id, `${appt.name} · ${appt.starts_at}`);
        return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&ok=borrada`);
      }
    }

    return new Response("No encontrado", { status: 404 });
  }

  if (sub === "informes.csv" && role === "admin" && req.method === "GET") {
    const s = await loadSettings(env);
    const { from, to } = reportRange(url, now);
    const list = await db.appointmentsInRange(env.DB, from, to);
    const header = ["Fecha", "Hora", "Peluquero", "Servicio", "Cliente", "Teléfono", "Estado", "Precio (€)", "Origen", "Notas"];
    const rows = list.map((a) => [
      a.starts_at.slice(0, 10), a.starts_at.slice(11, 16), a.stylist, a.service_name, a.name,
      displayPhone(a.phone), a.status === "confirmed" ? "Confirmada" : a.status === "done" ? "Realizada" : "Cancelada", String(priceOf(s, a)),
      a.source === "whatsapp" ? "WhatsApp" : a.source === "admin" ? "Panel" : "Recepción", a.notes,
    ]);
    return csvResponse([header, ...rows], `informe_${from}_${to}.csv`);
  }

  if (sub === "informes" && role === "admin" && req.method === "GET") {
    const s = await loadSettings(env);
    const { from, to } = reportRange(url, now);
    const list = await db.appointmentsInRange(env.DB, from, to);
    return html(layout(env, s, "/admin", role, "informes", "Informes", informesBody(s, from, to, list)));
  }

  if (sub === "ajustes" && role === "admin") {
    const s = await loadSettings(env);
    if (req.method === "GET") {
      return html(layout(env, s, "/admin", role, "ajustes", "Ajustes", settingsForm(s, {}, [])));
    }
    if (req.method === "POST") {
      const fd = await req.formData();
      const raw: Record<string, string> = {};
      for (const [k, v] of fd.entries()) if (typeof v === "string") raw[k] = v;
      const { s: next, errs } = parseSettings(fd, s);
      if (!next) {
        return html(layout(env, s, "/admin", role, "ajustes", "Ajustes", settingsForm(s, raw, errs)), 422);
      }
      await saveSettings(env.DB, next);
      await db.audit(env.DB, now, role, "ajustes", null,
        `${next.salonName} · ${next.services.length} servicios · ${next.stylists.join(", ")}`);
      return redirect("/admin/ajustes?ok=ajustes");
    }
  }

  if (sub === "historial" && role === "admin" && req.method === "GET") {
    const s = await loadSettings(env);
    return html(historialPage(env, s, role, await db.listAudit(env.DB, 200)));
  }

  return new Response("No encontrado", { status: 404 });
}
