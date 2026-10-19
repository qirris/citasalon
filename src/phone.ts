export function normalizePhone(raw: string): string | null {
  const d = (raw ?? "").replace(/[\s\-().]/g, "");
  if (!d) return "";
  if (/^\+\d{6,15}$/.test(d)) return d;
  if (!/^\d{6,15}$/.test(d)) return null;
  if (d.length === 9 && /^[67]/.test(d)) return "+34" + d;
  if (d.length === 11 && d.startsWith("34")) return "+" + d;
  if (d.length === 12 && d.startsWith("0034")) return "+" + d.slice(2);
  return "+" + d;
}

export function displayPhone(p: string): string {
  if (!p) return "";
  if (p.startsWith("+")) return p;
  if (p.length === 11 && p.startsWith("34")) return "+" + p;
  return p;
}
