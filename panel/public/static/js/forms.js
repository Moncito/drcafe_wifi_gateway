// Small progressive enhancements. Everything works without JS too:
// without it, messages show as banners and confirms fall back to the browser's.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k) e.append(k);
    return e;
  };

  // ---- toasts ----------------------------------------------------------------
  const stack = el("div", { class: "toasts", "aria-live": "polite" });
  document.body.append(stack);
  const ICON = { ok: "M8 12.5l2.7 2.7L16 9.8", info: "M12 8v5M12 16.5v.01", err: "M12 7.5v6M12 16.5v.01" };
  /** kind: ok | info | err. Errors stay until closed; the rest close after 5 s. */
  function toast(kind, title, text, link) {
    const close = () => { t.classList.add("is-leaving"); setTimeout(() => t.remove(), 200); };
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<circle cx="12" cy="12" r="9"/><path d="${ICON[kind] || ICON.info}"/>`;
    const t = el("div", { class: `toast toast-${kind}`, role: kind === "err" ? "alert" : "status" },
      icon,
      el("div", { class: "toast-body" },
        el("strong", { text: title }),
        text ? el("span", { text }) : null,
        link ? el("a", { href: link.href, text: link.label }) : null),
      el("button", { type: "button", class: "toast-x", "aria-label": "Close", text: "×", onclick: close }));
    stack.append(t);
    if (kind !== "err") setTimeout(close, 5000);
  }
  window.drcToast = toast;

  // Server messages (?ok= / ?err=) become toasts; the banner stays only without JS.
  for (const f of $$(".flash")) {
    const err = f.classList.contains("flash-err");
    toast(err ? "err" : "ok", err ? "That didn't work" : "Done", f.textContent.trim());
    f.remove();
  }
  if (/[?&](ok|err)=/.test(location.search)) {
    const u = new URL(location.href);
    u.searchParams.delete("ok");
    u.searchParams.delete("err");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }

  // ---- confirm dialog ----------------------------------------------------------
  // <form data-confirm="body" data-confirm-title data-confirm-ok data-danger
  //       data-confirm-type="VOID" data-confirm-facts="slips|range|[[k,v],...]">
  let dlg = null;
  function factsFor(form) {
    const spec = form.dataset.confirmFacts || "";
    if (spec === "slips") {
      const n = $$("[data-count]", form).map((i) => parseInt(i.value, 10) || 0);
      const total = n.reduce((a, b) => a + b, 0);
      return [["Slips", `${n[0] ?? 0} solo + ${n[1] ?? 0} group = ${total}`], ["Paper", `${Math.ceil(total / 48)} A4 page${Math.ceil(total / 48) === 1 ? "" : "s"}`]];
    }
    if (spec === "range") {
      const type = form.elements.type?.value || "S";
      const from = parseInt(form.elements.from?.value, 10), to = parseInt(form.elements.to?.value, 10);
      if (!(from >= 1 && to >= from)) return [];
      const pad = (v) => String(v).padStart(3, "0");
      return [["Slips", `${type}-${pad(from)} – ${type}-${pad(to)} (${to - from + 1})`]];
    }
    if (spec.startsWith("[")) { try { return JSON.parse(spec); } catch { return []; } }
    return [];
  }
  function ask(form) {
    return new Promise((resolve) => {
      if (!window.HTMLDialogElement) { resolve(window.confirm(form.dataset.confirm)); return; }
      dlg?.remove();
      const danger = form.hasAttribute("data-danger");
      const word = form.dataset.confirmType || "";
      const okBtn = el("button", { type: "button", class: `btn ${danger ? "btn-danger" : "btn-primary"}`, text: form.dataset.confirmOk || "Confirm" });
      const input = word ? el("input", { type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", id: "dlg-type", class: "dlg-type" }) : null;
      const facts = factsFor(form);
      dlg = el("dialog", { class: `dlg${danger ? " dlg-danger" : ""}`, "aria-labelledby": "dlg-title" },
        el("div", { class: "dlg-head" },
          el("span", { class: "dlg-icon", "aria-hidden": "true", text: danger ? "!" : "?" }),
          el("div", { class: "stack-6" },
            el("h2", { id: "dlg-title", class: "dlg-title", text: form.dataset.confirmTitle || "Are you sure?" }),
            el("p", { class: "dlg-text", text: form.dataset.confirm }))),
        facts.length ? el("div", { class: "dlg-facts" }, ...facts.map(([k, v]) => el("div", {}, el("span", { text: k }), el("strong", { text: v })))) : null,
        input ? el("div", { class: "dlg-field" }, el("label", { for: "dlg-type", text: `Type ${word} to confirm` }), input) : null,
        el("div", { class: "dlg-actions" },
          el("button", { type: "button", class: "btn btn-light", text: "Cancel", onclick: () => dlg.close("cancel") }),
          okBtn));
      if (input) {
        okBtn.disabled = true;
        input.addEventListener("input", () => { okBtn.disabled = input.value.trim().toUpperCase() !== word; });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !okBtn.disabled) { e.preventDefault(); okBtn.click(); } });
      }
      okBtn.addEventListener("click", () => dlg.close("ok"));
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("cancel"); }); // click outside
      dlg.addEventListener("close", () => { resolve(dlg.returnValue === "ok"); dlg.remove(); dlg = null; });
      document.body.append(dlg);
      dlg.showModal();
      (input || okBtn).focus();
    });
  }

  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    if (f.dataset.submitted) { e.preventDefault(); return; } // no double submit
    if (f.dataset.confirm && !f.dataset.confirmed) {
      e.preventDefault();
      if (!(await ask(f))) return;
      f.dataset.confirmed = "1";
      f.requestSubmit ? f.requestSubmit(e.submitter || undefined) : f.submit();
      return;
    }
    f.dataset.submitted = "1";
    const busy = f.dataset.busy;
    for (const b of $$("button[type=submit]", f)) {
      b.disabled = true;
      if (busy) b.textContent = busy;
    }
  });

  // ---- live total on the daily batch form ------------------------------------------
  const counts = $$("[data-count]");
  const total = $("[data-total]");
  if (counts.length && total) {
    const upd = () => {
      const n = counts.reduce((s, i) => s + (parseInt(i.value, 10) || 0), 0);
      total.textContent = `${n} slips · ${Math.ceil(n / 48)} A4 page${Math.ceil(n / 48) === 1 ? "" : "s"}`;
    };
    counts.forEach((i) => i.addEventListener("input", upd));
  }

  // ---- "batch ready" toast when a waiting batch reaches the router -------------------
  // Pages refresh themselves while a batch is waiting; remember what was waiting.
  try {
    const rows = $$("[data-batch]");
    if (rows.length) {
      const before = JSON.parse(sessionStorage.getItem("drc-waiting") || "[]");
      const waiting = [];
      for (const r of rows) {
        const id = r.dataset.batch;
        if (r.dataset.state === "pending") waiting.push(id);
        else if (r.dataset.state === "on_router" && before.includes(id)) {
          toast("ok", "Batch ready to print", `All ${r.dataset.count} slips are on the router.`, r.dataset.sheet ? { href: r.dataset.sheet, label: "Print now" } : null);
        }
      }
      sessionStorage.setItem("drc-waiting", JSON.stringify(waiting));
    }
  } catch { /* storage blocked: no toast, nothing else changes */ }

  // ---- live countdown: <span data-until="ms"> ---------------------------------------
  const clocks = $$("[data-until]");
  if (clocks.length) {
    const pad = (n) => String(n).padStart(2, "0");
    const tick = () => {
      for (const c of clocks) {
        const s = Math.max(0, Math.floor((Number(c.dataset.until) - Date.now()) / 1000));
        c.textContent = `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m ${pad(s % 60)}s`;
      }
    };
    tick();
    setInterval(tick, 1000);
  }

  // ---- chart tooltips: <div class="chart"> … <button data-tip="…"> … <div class="chart-tip"> --
  for (const chart of $$(".chart")) {
    const tip = $(".chart-tip", chart);
    if (!tip) continue;
    const idle = tip.textContent;
    const bars = $$("[data-tip]", chart);
    const show = (b) => {
      tip.textContent = b.dataset.tip;
      const box = chart.getBoundingClientRect(), r = b.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2 - box.left, 80), box.width - 80);
      tip.style.left = `${x}px`;
      tip.classList.add("is-on");
      bars.forEach((o) => o.classList.toggle("is-dim", o !== b));
    };
    const hide = () => { tip.textContent = idle; tip.classList.remove("is-on"); tip.style.left = ""; bars.forEach((o) => o.classList.remove("is-dim")); };
    for (const b of bars) {
      b.addEventListener("mouseenter", () => show(b));
      b.addEventListener("focus", () => show(b));
      b.addEventListener("click", () => show(b));
      b.addEventListener("mouseleave", hide);
      b.addEventListener("blur", hide);
    }
  }
})();
