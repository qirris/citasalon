import * as db from "./db.ts";
import { loadSettings, saveSettings } from "./config.ts";
import { cleanName } from "./bot.ts";
import { badOrigin, clearCookie, readSession, safeEqual, sessionCookie, type PanelRole } from "./auth.ts";
import { displayPhone, normalizePhone } from "./phone.ts";
import { renderSVG } from "uqr";
import {
  DAYS, addMin, atTime, dayStr, fmtDay, hhmm, iso, isValidDay, isValidTime, nowLocal,
  parseDT, parseDay, startOfDay, weekday,
} from "./time.ts";
import type { Appt, Env, Service, Settings } from "./types.ts";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const OK_TEXT: Record<string, string> = {
  creada: "Cita creada.",
  guardada: "Cita guardada.",
  cancelada: "Cita cancelada.",
  restaurada: "Cita restaurada.",
  borrada: "Cita borrada.",
  ajustes: "Ajustes guardados.",
};

const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, ...headers },
  });
}

const redirect = (loc: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 303, headers: { location: loc, ...headers } });

const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef1f6;color:#1e2430;min-height:100vh}
.shell{display:flex;min-height:100vh}
.side{width:230px;flex:0 0 230px;background:#0f172a;color:#cbd5e1;display:flex;flex-direction:column;padding:20px 14px;gap:4px;position:sticky;top:0;height:100vh}
.brand{font-size:19px;font-weight:700;color:#fff;letter-spacing:.3px;padding:6px 10px 16px}
.brand small{display:block;font-size:11px;font-weight:400;color:#64748b;letter-spacing:.5px;text-transform:uppercase}
.side a{color:#cbd5e1;text-decoration:none;padding:9px 12px;border-radius:8px;font-size:14px}
.side a:hover{background:#1e293b;color:#fff}
.side a.on{background:#2563eb;color:#fff}
.side form{margin-top:auto}
.logout{width:100%;background:none;border:1px solid #334155;color:#94a3b8;padding:9px 12px;border-radius:8px;font-size:13px;cursor:pointer;text-align:left}
.logout:hover{border-color:#ef4444;color:#fca5a5}
.main{flex:1;padding:26px 32px 60px;max-width:1100px}
h1{font-size:24px;margin-bottom:4px}
h2{font-size:17px;margin:26px 0 10px}
.sub{color:#64748b;font-size:13.5px;margin-bottom:20px}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}
.top a.nav{color:#2563eb;text-decoration:none;font-size:20px;font-weight:600;padding:2px 8px;border-radius:6px;background:#fff;border:1px solid #dbe2ee}
.top a.nav:hover{background:#e8eefb}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;margin-bottom:18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.stat{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;min-width:130px}
.stat b{display:block;font-size:24px;color:#0f172a}
.stat span{font-size:12.5px;color:#64748b;text-transform:uppercase;letter-spacing:.4px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;font-size:14px;border-bottom:1px solid #eef2f7;vertical-align:top}
th{background:#f8fafc;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#64748b}
tr:last-child td{border-bottom:none}
tr.cancelada td{background:#fef2f2;color:#9f1239}
.time{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.mono{font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
.src-whatsapp{background:#dcfce7;color:#166534}
.src-admin{background:#e0e7ff;color:#3730a3}
.src-staff{background:#fef3c7;color:#92400e}
.badge{background:#fee2e2;color:#b91c1c;font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px}
.note{color:#64748b;font-size:13.5px}
.row-actions{display:flex;gap:8px;flex-wrap:wrap;white-space:nowrap}
.btn{display:inline-block;background:#2563eb;color:#fff;border:none;padding:7px 14px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn:hover{background:#1d4ed8}
.btn.sec{background:#fff;color:#334155;border:1px solid #cbd5e1}
.btn.sec:hover{background:#f1f5f9}
.btn.danger{background:#dc2626}
.btn.danger:hover{background:#b91c1c}
.btn.ghost{background:none;color:#dc2626;border:1px solid #fecaca}
.inline{display:inline}
form.stack label{display:block;font-size:13px;font-weight:600;color:#334155;margin:14px 0 5px}
input[type=text],input[type=password],input[type=date],input[type=time],input[type=number],input[type=search],select,textarea{
  width:100%;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff}
input:focus,select:focus,textarea:focus{outline:2px solid #bfdbfe;border-color:#2563eb}
textarea{resize:vertical}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 18px}
.actions{display:flex;gap:10px;margin-top:22px;align-items:center;flex-wrap:wrap}
.err{background:#fef2f2;border:1px solid #fecaca;color:#9f1239;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14px}
.err ul{margin:6px 0 0 20px}
.flash{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14.5px;font-weight:600}
.empty{background:#fff;border:1px dashed #cbd5e1;border-radius:12px;padding:34px 20px;text-align:center;color:#64748b}
.hours{display:grid;grid-template-columns:110px 1fr;gap:8px 12px;align-items:center}
.hours span{font-size:14px;color:#334155;font-weight:600}
.searchbar{display:flex;gap:10px;margin-bottom:18px}
.searchbar input{max-width:340px}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;padding:20px}
.login{background:#fff;border-radius:14px;padding:34px 32px;width:100%;max-width:390px}
.login h1{font-size:21px;margin-bottom:6px}
.login .sub{margin-bottom:14px}
.login label{display:block;font-size:13px;font-weight:600;color:#334155;margin:14px 0 5px}
.login .btn{width:100%;margin-top:20px;padding:11px}
.qr-wrap{min-height:100vh;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;padding:30px 16px}
.qr-card{background:#fff;color:#1e2430;border-radius:18px;padding:34px 30px;max-width:430px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.4)}
.qr-card h1{font-size:24px;margin-bottom:6px}
.qr-card p{color:#475569;font-size:14.5px}
.qr-card svg{width:260px;height:260px;margin:20px auto;display:block}
.qr-card .foot{font-size:13px;color:#64748b;margin-top:14px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:#64748b;margin-top:10px}
@media(max-width:820px){
  .shell{flex-direction:column}
  .side{width:100%;flex:none;height:auto;position:static;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px}
  .brand{padding:6px 8px}
  .side form{margin-top:0;margin-left:auto}
  .main{padding:18px 14px 50px}
  .grid2,.grid3{grid-template-columns:1fr}
  table{display:block;overflow-x:auto}
}`;

const nav = (base: string, role: PanelRole, active: string): string => {
  const items: [string, string, string][] = [
    ["agenda", base + "/", "Agenda"],
    ["nueva", base + "/nueva", "Nueva cita"],
    ["citas", base + "/citas", "Buscar"],
  ];
  if (role === "admin") items.push(["ajustes", "/admin/ajustes", "Ajustes"], ["historial", "/admin/historial", "Historial"]);
  items.push(["qr", "/qr", "Cartel QR"]);
  return items.map(([k, href, label]) =>
    `<a href="${href}"${k === active ? ' class="on"' : ""}>${label}</a>`).join("\n");
};

function layout(env: Env, s: Settings, base: string, role: PanelRole, active: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(s.salonName)}</title><style>${css}</style></head>
<body><div class="shell">
<aside class="side">
  <div class="brand">${esc(s.salonName)}<small>${role === "admin" ? "Administración" : "Recepción"}</small></div>
  ${nav(base, role, active)}
  <form method="post" action="${base}/logout"><button class="logout" type="submit">Cerrar sesión</button></form>
</aside>
<main class="main">${body}</main>
</div></body></html>`;
}

function loginPage(env: Env, base: string, error = ""): string {
  const who = base === "/admin" ? "Administración" : "Recepción";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceso · ${esc(who)}</title><style>${css}</style></head>
<body><div class="login-wrap"><div class="login">
<h1>${esc(who)}</h1>
<p class="sub">Introduce la contraseña para entrar en el panel.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="${base}/login" class="stack">
  <label for="pw">Contraseña</label>
  <input id="pw" type="password" name="password" autofocus autocomplete="current-password">
  <button class="btn" type="submit">Entrar</button>
</form>
</div></div></body></html>`;
}

const flash = (url: URL): string => {
  const t = OK_TEXT[url.searchParams.get("ok") ?? ""];
  return t ? `<div class="flash">✓ ${esc(t)}</div>` : "";
};

function errors(errs: string[]): string {
  return errs.length ? `<div class="err"><strong>Revisa estos puntos:</strong><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
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
  const raw = url.searchParams.get("date");
  const day = raw && isValidDay(raw) ? parseDay(raw) : startOfDay(now);
  const withCancelled = base === "/admin" && url.searchParams.get("cancelled") === "1";
  const list = await db.appointmentsForDay(env.DB, dayStr(day), withCancelled);

  const q = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams({ date: dayStr(day) });
    for (const [k, v] of Object.entries(extra)) { p.delete(k); if (v !== null) p.set(k, v); }
    return `${base}/?${p}`;
  };
  const prev = q({ date: dayStr(new Date(day.getTime() - 86400000)), cancelled: withCancelled ? "1" : null });
  const next = q({ date: dayStr(new Date(day.getTime() + 86400000)), cancelled: withCancelled ? "1" : null });
  const today = q({ date: dayStr(startOfDay(now)), cancelled: withCancelled ? "1" : null });

  const confirmed = list.filter((a) => a.status === "confirmed");
  const cancelledN = list.length - confirmed.length;
  const perStylist = new Map<string, number>();
  for (const a of confirmed) perStylist.set(a.stylist, (perStylist.get(a.stylist) ?? 0) + 1);

  const rows = list.map((a) => {
    const start = parseDT(a.starts_at);
    const time = `${hhmm(start)}–${hhmm(parseDT(a.ends_at))}`;
    const cls = a.status === "cancelled" ? ' class="cancelada"' : "";
    const acts: string[] = [`<a class="btn sec" href="${base}/cita/${a.id}">Editar</a>`];
    if (a.status === "confirmed") {
      acts.push(`<a class="btn ghost" href="${base}/cita/${a.id}/cancelar">Cancelar</a>`);
    } else if (role === "admin") {
      acts.push(`<form class="inline" method="post" action="${base}/cita/${a.id}/restaurar"><button class="btn sec" type="submit">Restaurar</button></form>`);
      acts.push(`<a class="btn ghost" href="${base}/cita/${a.id}/borrar">Borrar</a>`);
    }
    return `<tr${cls}>
<td class="time">${esc(time)}</td>
<td>${esc(a.stylist)}</td>
<td>${esc(a.service_name)}${a.status === "cancelled" ? ' <span class="badge">Cancelada</span>' : ""}</td>
<td>${esc(a.name)}</td>
<td class="mono">${esc(displayPhone(a.phone))}</td>
<td><span class="pill src-${esc(a.source)}">${a.source === "whatsapp" ? "WhatsApp" : a.source === "admin" ? "Panel" : "Recepción"}</span></td>
<td class="note">${esc(a.notes)}</td>
<td><div class="row-actions">${acts.join("")}</div></td>
</tr>`;
  }).join("");

  const body = `
<div class="top">
  <a class="nav" href="${prev}" title="Día anterior">‹</a>
  <h1>${esc(fmtDay(day, now))}</h1>
  <a class="nav" href="${next}" title="Día siguiente">›</a>
  <a class="btn sec" href="${today}">Hoy</a>
  ${role === "admin" ? (withCancelled
    ? `<a class="btn sec" href="${q({ cancelled: null })}">Ocultar canceladas</a>`
    : `<a class="btn sec" href="${q({ cancelled: "1" })}">Ver canceladas</a>`) : ""}
  <form method="get" action="${base}/" class="inline"><input type="date" name="date" value="${dayStr(day)}" style="width:auto"> <button class="btn sec" type="submit">Ir</button></form>
</div>
<p class="sub">${esc(s.salonName)} · ${esc(s.address)} · ${esc(s.phone)}</p>
${flash(url)}
<div class="stats">
  <div class="stat"><b>${confirmed.length}</b><span>Citas</span></div>
  ${role === "admin" ? `<div class="stat"><b>${cancelledN}</b><span>Canceladas</span></div>` : ""}
  ${[...perStylist].map(([st, n]) => `<div class="stat"><b>${n}</b><span>${esc(st)}</span></div>`).join("")}
</div>
${list.length ? `<table>
<thead><tr><th>Hora</th><th>Peluquero</th><th>Servicio</th><th>Cliente</th><th>Teléfono</th><th>Origen</th><th>Notas</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>`
: `<div class="empty"><p><strong>No hay citas</strong> para este día.</p><p class="note">Puedes crear una desde «Nueva cita».</p></div>`}
<div class="actions"><a class="btn" href="${base}/nueva">+ Nueva cita</a></div>`;

  return html(layout(env, s, base, role, "agenda", `Agenda ${fmtDay(day, now)}`, body));
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
  const svcOptions = s.services.map((x) =>
    `<option value="${esc(x.id)}"${v.service_id === x.id ? " selected" : ""}>${esc(x.name)} · ${x.minutes} min · ${esc(x.price)}</option>`).join("");
  const stylists = [...s.stylists];
  if (opts.appt && opts.appt.stylist && !stylists.includes(opts.appt.stylist)) stylists.push(opts.appt.stylist);
  const stylistOptions = `<option value="">Primero que esté libre</option>` + stylists.map((x) =>
    `<option value="${esc(x)}"${v.stylist === x ? " selected" : ""}>${esc(x)}</option>`).join("");

  const body = `
<h1>${esc(opts.title)}</h1>
<p class="sub">Los campos con * son obligatorios.</p>
${errors(opts.errs ?? [])}
<form method="post" action="${opts.action}" class="stack">
  <div class="grid3">
    <div><label for="f-date">Fecha *</label><input type="date" id="f-date" name="date" value="${esc(v.date ?? "")}" required></div>
    <div><label for="f-time">Hora *</label><input type="time" id="f-time" name="time" value="${esc(v.time ?? "")}" step="900" required></div>
    <div><label for="f-svc">Servicio *</label><select id="f-svc" name="service_id" required>${svcOptions}</select></div>
  </div>
  <div class="grid2">
    <div><label for="f-st">Peluquero</label><select id="f-st" name="stylist">${stylistOptions}</select></div>
    <div><label for="f-phone">Teléfono</label><input type="text" id="f-phone" name="phone" value="${esc(v.phone ?? "")}" placeholder="600 111 222" inputmode="tel"></div>
  </div>
  <div class="grid2">
    <div><label for="f-name">Cliente *</label><input type="text" id="f-name" name="name" value="${esc(v.name ?? "")}" required></div>
    <div><label for="f-notes">Notas</label><input type="text" id="f-notes" name="notes" value="${esc(v.notes ?? "")}" placeholder="Opcional"></div>
  </div>
  <div class="actions">
    <button class="btn" type="submit">${esc(opts.submit)}</button>
    <a class="btn sec" href="${base}/">Volver a la agenda</a>
    ${opts.extra ?? ""}
  </div>
</form>`;

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

function validate(v: ApptForm, s: Settings): Valid {
  const errs: string[] = [];
  const service = s.services.find((x) => x.id === v.service_id);
  const name = cleanName(v.name);
  const phone = normalizePhone(v.phone);
  let start: Date | undefined;

  if (!isValidDay(v.date)) errs.push("La fecha no es válida. Usa el formato AAAA-MM-DD.");
  if (!isValidTime(v.time)) errs.push("La hora no es válida. Usa el formato HH:MM.");
  if (!service) errs.push("El servicio no es válido.");
  if (!name) errs.push("El nombre no es válido (mínimo 2 letras).");
  if (phone === null) errs.push("El teléfono no es válido.");
  if (v.stylist && !s.stylists.includes(v.stylist)) errs.push("Ese peluquero no existe.");
  if (phone !== null && phone !== "" && !/^\+?\d{6,15}$/.test(phone.replace(/\s/g, ""))) errs.push("El teléfono no es válido.");

  if (isValidDay(v.date) && isValidTime(v.time) && service) {
    start = parseDT(`${v.date}T${v.time}`);
    const day = parseDay(v.date);
    if (s.closedDates.includes(v.date)) {
      errs.push("El salón está cerrado ese día.");
    } else {
      const spans = s.hours[weekday(day)] ?? [];
      const from = start;
      const end = addMin(from, service.minutes);
      const fits = spans.some(([a, b]) => atTime(day, a).getTime() <= from.getTime() && end.getTime() <= atTime(day, b).getTime());
      if (!fits) errs.push("Esa hora está fuera del horario de apertura.");
    }
  }
  return { errs, name: name ?? "", phone: phone ?? "", service, start: errs.length ? undefined : start };
}

// ------------------------------------------------------------------ ajustes
function hoursText(s: Settings): string[] {
  return DAYS.map((_, i) => (s.hours[i] ?? []).map(([a, b]) => `${a}-${b}`).join(" y "));
}

function parseSettings(fd: FormData, cur: Settings): { s?: Settings; errs: string[] } {
  const errs: string[] = [];

  const services: Service[] = [];
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
    services.push({ id: parts[0], name: parts[1], minutes, price: parts[3] || "" });
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
      salonName, address, phone, services, stylists, hours, closedDates,
      slotMinutes, maxDaysAhead, minNoticeMinutes, maxActive, sessionTtlMinutes,
    },
    errs,
  };
}

function settingsForm(s: Settings, raw: Record<string, string>, errs: string[]): string {
  const val = (k: string, d: string) => esc(raw[k] ?? d);
  const svcText = raw.services ?? s.services.map((x) => `${x.id} | ${x.name} | ${x.minutes} | ${x.price}`).join("\n");
  const closedText = raw.closedDates ?? s.closedDates.join("\n");
  const hours = DAYS.map((d, i) => `<span>${d.charAt(0).toUpperCase() + d.slice(1)}</span>
<input type="text" name="hours${i}" value="${val(`hours${i}`, hoursText(s)[i])}" placeholder="10:00-20:00 o vacío si cierras">`).join("\n");

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
    <p class="note">Uno por línea: <code>id | nombre | minutos | precio</code></p>
    <textarea name="services" rows="6" spellcheck="false">${esc(svcText)}</textarea>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Peluqueros y horario</h2>
    <label for="a-st">Peluqueros (separados por comas)</label>
    <input type="text" id="a-st" name="stylists" value="${val("stylists", s.stylists.join(", "))}">
    <div class="hours" style="margin-top:16px">${hours}</div>
    <label for="a-closed">Días cerrados (uno por línea, AAAA-MM-DD)</label>
    <textarea id="a-closed" name="closedDates" rows="3" spellcheck="false">${esc(closedText)}</textarea>
  </div>
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

// ------------------------------------------------------------------ enrutador
function ipOf(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
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
  const { errs, name, phone, service, start } = validate(v, s);
  if (errs.length || !service || !start) {
    return html(apptForm(env, s, base, role, {
      title: "Nueva cita", values: v, errs: errs.length ? errs : ["Datos no válidos."],
      action: `${base}/nueva`, submit: "Crear cita",
    }), 422);
  }
  const now = nowLocal(env.SALON_TZ);
  const appt = await db.createAppointment(env.DB, {
    phone, name, service, start, stylists: s.stylists,
    stylist: v.stylist || undefined, source: role, notes: v.notes, now,
  });
  if (!appt) {
    return html(apptForm(env, s, base, role, {
      title: "Nueva cita", values: v,
      errs: ["Todos los peluqueros están ocupados en esa hora. Elige otro tramo."],
      action: `${base}/nueva`, submit: "Crear cita",
    }), 422);
  }
  await db.audit(env.DB, now, role, "crear", appt.id,
    `${appt.name} · ${appt.service_name} · ${appt.starts_at} · ${appt.stylist}`);
  return redirect(`${base}/?date=${v.date}&ok=creada`);
}

async function editAppt(
  req: Request, env: Env, s: Settings, base: string, role: PanelRole, id: number,
): Promise<Response> {
  const current = await db.getAppt(env.DB, id);
  if (!current) return new Response("Cita no encontrada", { status: 404 });
  const fd = await req.formData();
  const v = readApptForm(fd);
  const { errs, name, phone, service, start } = validate(v, s);
  if (errs.length || !service || !start) {
    return html(apptForm(env, s, base, role, {
      title: `Editar cita #${id}`, values: v, errs: errs.length ? errs : ["Datos no válidos."],
      action: `${base}/cita/${id}`, submit: "Guardar cambios",
    }), 422);
  }
  const now = nowLocal(env.SALON_TZ);
  const result = await db.updateAppointment(env.DB, id, {
    name, phone, service, stylist: v.stylist || current.stylist, start, notes: v.notes,
  }, now);
  if (result === "ok") {
    await db.audit(env.DB, now, role, "editar", id, `${name} · ${service.name} · ${v.date}T${v.time}`);
    return redirect(`${base}/?date=${v.date}&ok=guardada`);
  }
  const msg = result === "clash" ? "Esa hora se solapa con otra cita del mismo peluquero."
    : result === "cancelled" ? "La cita está cancelada: primero restáurala."
    : "La cita ya no existe.";
  return html(apptForm(env, s, base, role, {
    title: `Editar cita #${id}`, values: v, errs: [msg],
    action: `${base}/cita/${id}`, submit: "Guardar cambios",
  }), result === "missing" ? 404 : 409);
}

export async function handlePanel(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/qr" && req.method === "GET") return qrPage(env);
  if (p === "/") return redirect("/admin/");
  const base = p === "/admin" || p.startsWith("/admin/") ? "/admin"
    : p === "/recepcion" || p.startsWith("/recepcion/") ? "/recepcion" : null;
  if (!base) return null;

  const segs = p.slice(base.length).split("/").filter(Boolean);
  const sub = segs[0] ?? "";
  const now = nowLocal(env.SALON_TZ);

  if (sub === "login") {
    if (req.method !== "POST") return html(loginPage(env, base));
    return doLogin(req, env, base);
  }
  if (sub === "logout" && req.method === "POST") {
    return redirect(base + "/login", { "set-cookie": clearCookie });
  }

  const session = await readSession(env, req);
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
      return html(apptForm(env, s, base, role, {
        title: "Nueva cita", action: `${base}/nueva`, submit: "Crear cita",
        values: { date: url.searchParams.get("date") ?? dayStr(startOfDay(now)), time: "", service_id: s.services[0]?.id ?? "", stylist: "", name: "", phone: "", notes: "" },
      }));
    }
    if (req.method === "POST") return createAppt(req, env, s, base, role);
  }

  if (sub === "citas" && req.method === "GET") {
    const s = await loadSettings(env);
    const q = (url.searchParams.get("q") ?? "").trim();
    const found = q ? await db.searchAppointments(env.DB, { q, limit: 100 }) : [];
    const rows = found.map((a) => `<tr>
<td class="time">${esc(a.starts_at.replace("T", " "))}</td>
<td>${esc(a.stylist)}</td>
<td>${esc(a.service_name)}</td>
<td>${esc(a.name)}${a.status === "cancelled" ? ' <span class="badge">Cancelada</span>' : ""}</td>
<td class="mono">${esc(displayPhone(a.phone))}</td>
<td><div class="row-actions"><a class="btn sec" href="${base}/cita/${a.id}">Editar</a></div></td>
</tr>`).join("");
    const body = `
<h1>Buscar citas</h1>
<p class="sub">Por nombre o teléfono.</p>
<form class="searchbar" method="get" action="${base}/citas">
  <input type="search" name="q" value="${esc(q)}" placeholder="Lucía, 600…">
  <button class="btn" type="submit">Buscar</button>
</form>
${!q ? `<div class="empty"><p>Escribe un nombre o un teléfono para buscar.</p></div>`
  : found.length ? `<table><thead><tr><th>Fecha y hora</th><th>Peluquero</th><th>Servicio</th><th>Cliente</th><th>Teléfono</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
  : `<div class="empty"><p><strong>No hay citas</strong> que coincidan con «${esc(q)}».</p></div>`}`;
    return html(layout(env, s, base, role, "citas", "Buscar citas", body));
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
        return html(apptForm(env, s, base, role, {
          title: `Editar cita #${id}`, appt, action: `${base}/cita/${id}`, submit: "Guardar cambios", extra,
        }));
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
        if (ok) await db.audit(env.DB, now, role, "cancelar", id, `${appt.name} · ${appt.starts_at}`);
        return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&ok=cancelada`);
      }
    }

    if (action === "restaurar" && req.method === "POST" && role === "admin") {
      if (!appt) return new Response("Cita no encontrada", { status: 404 });
      const ok = await db.setStatus(env.DB, id, "confirmed", now);
      if (!ok) {
        return html(errorPage(env, s, base, role, "No se puede restaurar",
          ["El hueco está ocupado por otra cita u otra cosa ha cambiado. Edítala o crea una nueva."],
          `${base}/?date=${appt.starts_at.slice(0, 10)}&cancelled=1`), 409);
      }
      await db.audit(env.DB, now, role, "restaurar", id, `${appt.name} · ${appt.starts_at}`);
      return redirect(`${base}/?date=${appt.starts_at.slice(0, 10)}&ok=restaurada`);
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
