import { doc } from "../layout.ts";
import { html, type Safe } from "../html.ts";

function shell(form: Safe): Safe {
  return html`
<div class="login">
  <section class="login-brand">
    <img src="/static/img/logo.png" alt="Don Robert Café" class="login-logo">
    <div class="login-pitch">
      <span class="eyebrow eyebrow-light">Wi‑Fi admin</span>
      <h2>Today's slips, devices online and settings, in one place.</h2>
      <p>Works on the café network only, even when the internet is down.</p>
    </div>
  </section>
  <section class="login-form-wrap">${form}</section>
</div>`;
}

export function loginPage(opts: { error?: string; username?: string }): Safe {
  return doc("Log in", shell(html`
    <form method="post" action="/login" class="login-form">
      <div class="stack-6">
        <h1 class="title">Log in</h1>
        <p class="muted">Baristas and the owner each have their own account.</p>
      </div>
      ${opts.error ? html`<div class="flash flash-err" role="alert">${opts.error}</div>` : ""}
      <div class="field">
        <label for="u">Username</label>
        <input id="u" name="username" type="text" autocomplete="username" required autofocus value="${opts.username ?? ""}">
      </div>
      <div class="field">
        <label for="p">Password</label>
        <input id="p" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit" class="btn btn-primary btn-lg">Log in</button>
      <p class="muted small center">Forgot your password? Ask the owner to reset it.</p>
    </form>`));
}

export function setupPage(opts: { error?: string }): Safe {
  return doc("First-time setup", shell(html`
    <form method="post" action="/setup" class="login-form">
      <div class="stack-6">
        <h1 class="title">Welcome</h1>
        <p class="muted">No accounts yet. Create the owner account. It can add baristas later.</p>
      </div>
      ${opts.error ? html`<div class="flash flash-err" role="alert">${opts.error}</div>` : ""}
      <div class="field"><label for="n">Name</label><input id="n" name="displayName" required value="Owner"></div>
      <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required value="owner"></div>
      <div class="field"><label for="p">Password (8+ characters)</label><input id="p" name="password" type="password" autocomplete="new-password" required minlength="8"></div>
      <button type="submit" class="btn btn-primary btn-lg">Create owner account</button>
    </form>`));
}
