/** Tiny HTML templating: html`...` escapes every value unless it is already Safe. */
export class Safe {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString() { return this.value; }
}

type Val = Safe | string | number | boolean | null | undefined | Val[];

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

function render(v: Val): string {
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...vals: Val[]): Safe {
  let out = strings[0]!;
  for (let i = 0; i < vals.length; i++) out += render(vals[i]!) + strings[i + 1]!;
  return new Safe(out);
}

export const raw = (s: string) => new Safe(s);
