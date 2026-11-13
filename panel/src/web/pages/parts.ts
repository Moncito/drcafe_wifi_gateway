import type { CodeStatus, CodeType } from "../../codes.ts";
import type { RouterStatus } from "../../services/routerlink.ts";
import { html, type Safe } from "../html.ts";

export function routerStatus(s: RouterStatus, now: number): Safe {
  if (s.ok && s.lastOkAt) {
    const ago = Math.round((now - s.lastOkAt) / 1000);
    return html`<p class="router-line"><span class="dot dot-ok"></span>Router connected · checked in ${ago < 5 ? "just now" : `${ago}s ago`}</p>`;
  }
  if (!s.lastTryAt) return html`<p class="router-line"><span class="dot dot-warn"></span>Connecting to the router…</p>`;
  return html`<div class="notice notice-err" role="alert"><span class="dot dot-err"></span><span><strong>Router not checking in.</strong> Numbers below may be out of date. ${s.error ?? ""}</span></div>`;
}

export function typePill(t: CodeType): Safe {
  return html`<span class="pill ${t === "G" ? "pill-group" : "pill-solo"}">${t === "G" ? "GROUP" : "SOLO"}</span>`;
}

const STATUS_TEXT: Record<CodeStatus, string> = { unused: "Unused", active: "Active", expired: "Expired", void: "Void" };

export function statusBadge(s: CodeStatus): Safe {
  return html`<span class="status status-${s}"><span class="dot"></span>${STATUS_TEXT[s]}</span>`;
}
