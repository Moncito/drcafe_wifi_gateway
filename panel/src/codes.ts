import { randomInt } from "node:crypto";

/** No 0, O, 1, I, L. Must match router/src/_common.rsc. */
export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[SG][A-HJKMNP-Z2-9]{5}$/;

export type CodeType = "S" | "G";
export type CodeStatus = "unused" | "active" | "expired" | "void";

export function randomCode(type: CodeType): string {
  let c: string = type;
  for (let i = 0; i < 5; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

export function serialLabel(type: CodeType, serial: number): string {
  return `${type}-${String(serial).padStart(3, "0")}`;
}

/** "S-042", "s42", "S042", "g 7" -> { type, serial } */
export function parseSerial(input: string): { type: CodeType; serial: number } | null {
  const m = input.trim().toUpperCase().match(/^([SG])\s*-?\s*0*(\d{1,4})$/);
  if (!m) return null;
  return { type: m[1] as CodeType, serial: Number(m[2]) };
}

/** Normalise what a barista types: spaces and dashes removed, upper case. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}

/** Comment written on the router when a code is created; drc-login adds start/end. */
export function routerComment(durSeconds: number): string {
  return `drc;dur=${durSeconds};`;
}

export interface RouterCodeState { dur?: number; start?: number; end?: number; exp?: number }

export function parseRouterComment(comment: string | undefined): RouterCodeState {
  const out: RouterCodeState = {};
  if (!comment || !comment.startsWith("drc;")) return out;
  for (const part of comment.split(";")) {
    const [k, v] = part.split("=");
    if (v === undefined || !/^\d+$/.test(v)) continue;
    if (k === "dur" || k === "start" || k === "end" || k === "exp") out[k] = Number(v);
  }
  return out;
}

export function qrLoginUrl(base: string, code: string): string {
  return `${base}?username=${code}&password=${code}`;
}

export function typeLabel(type: CodeType): string {
  return type === "S" ? "SOLO" : "GROUP";
}
