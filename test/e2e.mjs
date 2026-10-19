// Prueba de extremo a extremo contra el Worker en local (npm run dev en otra terminal).
// Lee los mismos secretos que .dev.vars. Ejecuta con:  npm run e2e
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8787";
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split("\n").filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));

let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { cond ? passed++ : failed++; console.log(`${cond ? "  ✓" : "  ✗ FALLA"} ${name}${!cond && extra ? "\n      " + extra : ""}`); };
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- fechas (hora de Madrid)
const madrid = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid" }).format(d);   // AAAA-MM-DD
};
const weekdayOf = (iso) => (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;
let target = 1;                                    // primer día laborable (no domingo) a partir de mañana
while (weekdayOf(madrid(target)) === 6) target++;
const DAY = madrid(target);
target++;
while (weekdayOf(madrid(target)) === 6) target++;
const DAY2 = madrid(target);

// ---------------------------------------------------------------- WhatsApp firmado como Meta
let n = 0;
async function wa(phone, { text, id, title }, profile = "Lucía Gómez") {
  const msg = { from: phone, id: `wamid.${Date.now()}.${n++}` };
  if (id) Object.assign(msg, { type: "interactive", interactive: { type: id.startsWith("svc:") || id.startsWith("time:") || id.startsWith("day:") || id.startsWith("appt:") ? "list_reply" : "button_reply", [id.startsWith("svc:") || id.startsWith("time:") || id.startsWith("day:") || id.startsWith("appt:") ? "list_reply" : "button_reply"]: { id, title: title ?? id } } });
  else Object.assign(msg, { type: "text", text: { body: text } });
  const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: phone, profile: { name: profile } }], messages: [msg] } }] }] });
  const sig = "sha256=" + createHmac("sha256", vars.APP_SECRET).update(body).digest("hex");
  const r = await fetch(`${BASE}/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body });
  await new Promise((res) => setTimeout(res, 350));      // el bot responde en segundo plano
  return { status: r.status, msgId: msg.id, body, sig };
}

// ---------------------------------------------------------------- paneles
class Session {
  cookie = "";
  async req(path, { method = "GET", form, headers = {} } = {}) {
    const r = await fetch(BASE + path, {
      method, redirect: "manual",
      headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = r.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0].startsWith("sid=") && set.split(";")[0] !== "sid=" ? set.split(";")[0] : "";
    return { status: r.status, loc: r.headers.get("location"), text: await r.text(), headers: r.headers };
  }
}
const idFromLoc = (t) => Number((t.match(/\/cita\/(\d+)"/) ?? [])[1]);

(async () => {
  section("Básicos");
  ok((await (await fetch(`${BASE}/health`)).json()).ok, "GET /health");
  const v1 = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${vars.VERIFY_TOKEN}&hub.challenge=777`);
  ok(v1.status === 200 && (await v1.text()) === "777", "Meta puede verificar el webhook");
  ok((await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=777`)).status === 403, "Token de verificación incorrecto => 403");
  ok((await fetch(`${BASE}/webhook`, { method: "POST", body: "{}" })).status === 403, "POST sin firma => 403");
  ok((await fetch(`${BASE}/webhook`, { method: "POST", headers: { "X-Hub-Signature-256": "sha256=00" }, body: "{}" })).status === 403, "POST con firma falsa => 403");
  const qr = await (await fetch(`${BASE}/qr`)).text();
  ok(qr.includes("<svg") && qr.includes("Reserva tu cita por WhatsApp"), "/qr muestra el cartel con el código QR");

  section("Cliente por WhatsApp (botones y listas)");
  const phone = "34611222333";
  const steps = [
    { text: "hola" }, { id: "menu:book", title: "Reservar cita" }, { id: "svc:tinte", title: "Tinte" },
    { id: `day:${DAY}` }, { id: "period:pm" }, { id: `time:${DAY}T17:00`, title: "17:00" },
    { id: "name:yes" }, { id: "confirm:yes" },
  ];
  for (const s of steps) { const r = await wa(phone, s); if (r.status !== 200) ok(false, `webhook ${JSON.stringify(s)}`, `status ${r.status}`); }

  section("Más clientes por WhatsApp (texto libre, misma hora, cancelar)");
  const pB = "34622000002", pC = "34633000003", pD = "34644000004";
  for (const st of [{ text: "hola" }, { text: "quiero reservar" }, { text: "corte mujer" }, { id: `day:${DAY2}` }, { text: "por la tarde" },
                    { text: "a las 5" }, { text: "sí" }, { text: "sí" }]) await wa(pB, st, "Beatriz Soto");
  for (const st of [{ id: "menu:book" }, { id: "svc:corte_hombre" }, { id: `day:${DAY2}` }, { id: "period:pm" },
                    { id: `time:${DAY2}T17:00` }, { id: "name:yes" }, { id: "confirm:yes" }]) await wa(pC, st, "Carlos Vega");
  for (const st of [{ id: "menu:book" }, { id: "svc:corte_hombre" }, { id: `day:${DAY2}` }, { id: "period:pm" },
                    { id: `time:${DAY2}T17:00` }, { id: "name:yes" }, { id: "confirm:yes" }]) await wa(pD, st, "Diana Ortiz");
  const both = new Session();
  await both.req("/admin/login", { method: "POST", form: { password: vars.ADMIN_PASSWORD } });
  let ag2 = (await both.req(`/admin?date=${DAY2}`)).text;
  ok(ag2.includes("Beatriz Soto") && ag2.includes("Corte mujer"), "Cliente que escribe con texto libre ('corte mujer', 'por la tarde', 'a las 5') reserva bien");
  ok(ag2.includes("Carlos Vega"), "Segundo cliente a la misma hora (otro peluquero) reserva bien");
  ok(!ag2.includes("Diana Ortiz"), "Tercer cliente a esa hora NO consigue cita (hueco ya ocupado)");
  ok((ag2.match(/17:00–/g) ?? []).length === 2, "Exactamente 2 citas a las 17:00 (una por peluquero)");
  const bId = [...ag2.matchAll(/\/admin\/cita\/(\d+)"/g)].map((m) => +m[1])[0];
  for (const st of [{ id: "menu:manage" }, { id: `appt:${bId}` }, { id: "cancel:yes" }]) await wa(pB, st, "Beatriz Soto");
  ag2 = (await both.req(`/admin?date=${DAY2}`)).text;
  ok(!ag2.includes("Beatriz Soto"), "Cliente cancela su cita desde 'Mis citas' y el hueco queda libre");
  await wa(pC, { id: "menu:manage" }, "Carlos Vega"); await wa(pC, { id: `appt:${bId}` }, "Carlos Vega"); await wa(pC, { id: "cancel:yes" }, "Carlos Vega");
  ok((await both.req(`/admin?date=${DAY2}`)).text.includes("Carlos Vega"), "Un cliente NO puede cancelar la cita de otra persona");

  const admin = new Session(), staff = new Session();
  section("Login");
  ok((await admin.req("/admin")).text.includes("Contraseña"), "/admin sin sesión pide contraseña");
  ok((await admin.req("/admin/login", { method: "POST", form: { password: "mal" } })).status === 401, "Contraseña de admin incorrecta => 401");
  let r = await admin.req("/admin/login", { method: "POST", form: { password: vars.ADMIN_PASSWORD } });
  ok(r.status === 303 && admin.cookie.startsWith("sid=admin."), "Admin entra con su contraseña");
  r = await staff.req("/recepcion/login", { method: "POST", form: { password: vars.STAFF_PASSWORD } });
  ok(r.status === 303 && staff.cookie.startsWith("sid=staff."), "Recepción entra con su contraseña");
  ok((await staff.req("/admin")).text.includes("Contraseña"), "Recepción NO puede abrir /admin");
  ok((await staff.req("/admin/ajustes")).text.includes("Contraseña"), "Recepción NO puede abrir /admin/ajustes");
  ok((await staff.req("/admin/historial")).text.includes("Contraseña"), "Recepción NO puede ver el historial");
  const forged = new Session(); forged.cookie = "sid=admin." + (Date.now() + 1e7) + ".firmafalsa";
  ok((await forged.req("/admin")).text.includes("Contraseña"), "Cookie de admin falsificada => rechazada");
  const cross = await new Session().req("/admin/login", { method: "POST", form: { password: vars.ADMIN_PASSWORD }, headers: { Origin: "https://otra-web.example" } });
  ok(cross.status === 403, "Formulario enviado desde otra web => 403");

  section("La cita del cliente aparece en los paneles");
  let ag = await staff.req(`/recepcion?date=${DAY}`);
  ok(ag.text.includes("Lucía Gómez") && ag.text.includes("Tinte") && ag.text.includes("17:00–18:30"), "Recepción ve la cita (17:00–18:30, Tinte)", ag.text.slice(0, 200));
  ag = await admin.req(`/admin?date=${DAY}`);
  ok(ag.text.includes("Lucía Gómez") && ag.text.includes("WhatsApp"), "Admin ve la cita con origen WhatsApp");
  const apptId = idFromLoc(ag.text);
  ok(apptId > 0, "La cita tiene enlace de edición");

  section("Recepción: añadir y editar");
  r = await staff.req("/recepcion/nueva", { method: "POST", form: { date: DAY, time: "12:00", service_id: "corte_hombre", stylist: "", name: "Pedro Ruiz", phone: "600 111 222", notes: "Llamó por teléfono" } });
  ok(r.status === 303 && r.loc.includes("ok=creada"), "Recepción crea una cita a mano");
  ag = await staff.req(`/recepcion?date=${DAY}`);
  ok(ag.text.includes("Pedro Ruiz") && ag.text.includes("+34600111222") && ag.text.includes("Llamó por teléfono"), "Aparece con teléfono normalizado (+34600111222) y notas");
  const pedroId = [...ag.text.matchAll(/\/recepcion\/cita\/(\d+)"/g)].map((m) => +m[1]).find((i) => i !== apptId);
  r = await staff.req("/recepcion/nueva", { method: "POST", form: { date: DAY, time: "12:00", service_id: "corte_hombre", stylist: "", name: "Ana B", phone: "", notes: "" } });
  ok(r.status === 303, "Segunda cita a la misma hora con el otro peluquero => OK");
  r = await staff.req("/recepcion/nueva", { method: "POST", form: { date: DAY, time: "12:15", service_id: "corte_hombre", stylist: "", name: "Tercera", phone: "", notes: "" } });
  ok(r.status === 422 && r.text.includes("ocupados"), "Tercera cita solapada => rechazada (todos ocupados)");
  r = await staff.req("/recepcion/nueva", { method: "POST", form: { date: "31-12-2026", time: "25:00", service_id: "nada", stylist: "", name: "X", phone: "abc", notes: "" } });
  ok(r.status === 422 && r.text.includes("fecha no es válida") && r.text.includes("nombre") && r.text.includes("teléfono"), "Datos inválidos => errores claros");
  r = await staff.req(`/recepcion/cita/${pedroId}`, { method: "POST", form: { date: DAY, time: "13:00", service_id: "corte_hombre", stylist: "Luis", name: "Pedro Ruiz Gil", phone: "34600111222", notes: "Cambió a las 13" } });
  ok(r.status === 303 && r.loc.includes("ok=guardada"), "Recepción mueve la cita de hora y la edita");
  ag = await staff.req(`/recepcion?date=${DAY}`);
  ok(ag.text.includes("Pedro Ruiz Gil") && ag.text.includes("13:00–13:30"), "Los cambios se ven en la agenda");
  r = await staff.req(`/recepcion/cita/${apptId}`, { method: "POST", form: { date: DAY, time: "17:30", service_id: "tinte", stylist: "Ana", name: "Lucía Gómez", phone: phone, notes: "" } });
  ok(r.status === 303, "Recepción edita la cita de WhatsApp (17:30)");
  r = await staff.req("/recepcion/nueva", { method: "POST", form: { date: DAY, time: "19:30", service_id: "corte_hombre", stylist: "Ana", name: "Choque", phone: "", notes: "" } });
  ok(r.status === 303, "Cita de Ana a las 19:30 creada (para provocar un choque)");
  r = await staff.req(`/recepcion/cita/${apptId}`, { method: "POST", form: { date: DAY, time: "18:30", service_id: "tinte", stylist: "Ana", name: "Lucía Gómez", phone: phone, notes: "" } });
  ok(r.status === 409 && r.text.includes("solapa"), "Mover una cita encima de otra del mismo peluquero => rechazado");

  section("Recepción: cancelar (pero no borrar ni ajustes)");
  ok((await staff.req(`/recepcion/cita/${pedroId}/cancelar`)).text.includes("¿Cancelar esta cita?"), "Pide confirmación antes de cancelar");
  r = await staff.req(`/recepcion/cita/${pedroId}/cancelar`, { method: "POST", form: {} });
  ok(r.status === 303 && r.loc.includes("ok=cancelada"), "Recepción cancela la cita");
  ok(!(await staff.req(`/recepcion?date=${DAY}`)).text.includes("Pedro Ruiz Gil"), "La cita cancelada desaparece de la agenda de recepción");
  ok((await staff.req(`/recepcion/cita/${pedroId}/borrar`)).status === 404, "Recepción NO puede borrar citas");
  ok((await staff.req(`/recepcion/cita/${pedroId}/restaurar`, { method: "POST", form: {} })).status === 404, "Recepción NO puede restaurar citas");

  section("Administración");
  ok((await admin.req(`/admin?date=${DAY}&cancelled=1`)).text.includes("Pedro Ruiz Gil"), "Admin puede ver las canceladas");
  r = await admin.req(`/admin/cita/${pedroId}/restaurar`, { method: "POST", form: {} });
  ok(r.status === 303 && r.loc.includes("ok=restaurada"), "Admin restaura la cita");
  await admin.req(`/admin/cita/${pedroId}/cancelar`, { method: "POST", form: {} });
  ok((await admin.req(`/admin/cita/${pedroId}/borrar`)).text.includes("Esto no se puede deshacer"), "Borrar pide confirmación");
  r = await admin.req(`/admin/cita/${pedroId}/borrar`, { method: "POST", form: {} });
  ok(r.status === 303 && r.loc.includes("ok=borrada"), "Admin borra definitivamente");
  ok((await admin.req(`/admin/cita/${pedroId}`)).status === 404, "La cita borrada ya no existe");
  let list = await admin.req("/admin/citas?q=luc");
  ok(list.text.includes("Lucía Gómez") && !list.text.includes("Pedro"), "Buscador de citas por nombre");
  list = await admin.req("/admin/citas?q=" + encodeURIComponent("' OR 1=1 --"));
  ok(list.status === 200 && list.text.includes("No hay citas"), "El buscador resiste inyección SQL");

  section("Ajustes editables (admin) y efecto en el bot");
  let st = await admin.req("/admin/ajustes");
  ok(st.text.includes("Corte mujer") && st.text.includes("Ana, Luis"), "Ajustes muestra la configuración actual");
  const newSettings = { salonName: "Salón Nuevo", address: "Calle Nueva 5", phone: "611 000 111",
    services: "corte | Corte rápido | 20 | 10 €\ntinte | Tinte | 90 | 35 €", stylists: "Marta",
    hours0: "10:00-14:00", hours1: "10:00-14:00", hours2: "", hours3: "10:00-14:00", hours4: "10:00-14:00", hours5: "", hours6: "",
    closedDates: "2026-12-25", slotMinutes: "15", maxDaysAhead: "10", minNoticeMinutes: "30", maxActive: "2" };
  r = await admin.req("/admin/ajustes", { method: "POST", form: { ...newSettings, services: "mal formato" } });
  ok(r.status === 422 && r.text.includes("Servicio, línea 1"), "Ajustes inválidos => errores claros");
  r = await admin.req("/admin/ajustes", { method: "POST", form: { ...newSettings, hours0: "14:00-10:00" } });
  ok(r.status === 422 && r.text.includes("tramo válido"), "Horario al revés => error");
  r = await admin.req("/admin/ajustes", { method: "POST", form: newSettings });
  ok(r.status === 303 && r.loc.includes("ok=ajustes"), "Admin guarda los ajustes");
  await wa("34699000111", { text: "hola" }); await wa("34699000111", { id: "menu:book" });
  const savedAjustes = (await admin.req("/admin/ajustes")).text;
  ok(savedAjustes.includes("Salón Nuevo") && !savedAjustes.includes("&quot;Salón Nuevo&quot;"), "Los ajustes quedan guardados sin comillas sobrantes");
  ok((await admin.req("/qr")).text.includes("<strong>Salón Nuevo</strong>"), "El cartel QR muestra el nombre limpio");

  section("Historial y seguridad");
  const hist = (await admin.req("/admin/historial")).text;
  ok(["crear", "editar", "cancelar", "restaurar", "borrar", "ajustes"].every((a) => hist.includes(a)), "El historial recoge crear/editar/cancelar/restaurar/borrar/ajustes");
  ok(hist.includes("Cliente (WhatsApp)") && hist.includes("Recepción") && hist.includes("Admin"), "El historial dice quién hizo cada cosa");
  ok(!hist.includes("<script"), "Sin scripts en el panel");
  const csp = (await admin.req("/admin")).headers.get("content-security-policy") ?? "";
  ok(csp.includes("default-src 'none'"), "Cabecera CSP restrictiva");
  const lock = new Session(); let last = 0;
  for (let i = 0; i < 6; i++) last = (await lock.req("/recepcion/login", { method: "POST", form: { password: "x" + i } })).status;
  ok(last === 429, "Tras 5 contraseñas erróneas se bloquea el acceso 15 min (429)");
  ok((await admin.req("/recepcion/logout", { method: "POST", form: {} })).status === 303, "Cerrar sesión funciona");

  section("Rate-limit (429 tras superar el límite)");
  const hammer = new Session();
  await hammer.req("/recepcion/login", { method: "POST", form: { password: vars.STAFF_PASSWORD } });
  let blocked = false;
  for (let i = 0; i < 130 && !blocked; i++) blocked = (await hammer.req("/recepcion")).status === 429;
  ok(blocked, "Rate-limit por sesión: 429 tras superar 120 peticiones/minuto");
  let ipBlocked = false;
  for (let i = 0; i < 80 && !ipBlocked; i++) ipBlocked = (await fetch(`${BASE}/qr`)).status === 429;
  ok(ipBlocked, "Rate-limit por IP: 429 en rutas públicas tras superar el límite");

  console.log(`\n${failed ? "✗" : "✓"} ${passed} pruebas correctas, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})();
