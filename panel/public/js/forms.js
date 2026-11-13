// Small progressive enhancements. Everything works without JS too.
document.addEventListener("submit", (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  const msg = f.dataset.confirm;
  if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
  if (f.dataset.submitted) { e.preventDefault(); return; } // no double submit
  f.dataset.submitted = "1";
  const busy = f.dataset.busy;
  for (const b of f.querySelectorAll("button[type=submit]")) {
    b.disabled = true;
    if (busy) b.textContent = busy;
  }
});

// Live total on the daily batch form
const counts = document.querySelectorAll("[data-count]");
const total = document.querySelector("[data-total]");
if (counts.length && total) {
  const upd = () => {
    const n = [...counts].reduce((s, i) => s + (parseInt(i.value, 10) || 0), 0);
    total.textContent = `${n} slips · ${Math.ceil(n / 48)} A4 page${Math.ceil(n / 48) === 1 ? "" : "s"}`;
  };
  counts.forEach((i) => i.addEventListener("input", upd));
}
