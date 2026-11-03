// Minimal auto-escaping HTML templates (stand-in for Jinja's autoescape).

export class Safe {
  constructor(public s: string) {}
  toString() { return this.s; }
}

export const raw = (s: string) => new Safe(s);

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): Safe {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Safe(out);
}

/** Query string from an object, skipping empty values (like url_for(**args)). */
export function qs(args: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
}
