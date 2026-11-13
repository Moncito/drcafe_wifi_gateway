// Print button: open the print dialog, then record "printed" for this batch.
const form = document.getElementById("printed");
document.getElementById("print").addEventListener("click", () => {
  window.print();
  fetch(form.action, { method: "POST", credentials: "same-origin", headers: { "x-requested-with": "fetch" } }).catch(() => {});
});
