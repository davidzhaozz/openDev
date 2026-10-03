// Scripts injected into the embedded browser's guest page to make logins
// savable. Electron ships no password manager, so the IDE does the two jobs
// Chromium would: notice a login being submitted, and fill one back in.
//
// They follow the same shape as the element picker in BrowserPanel — plain
// source strings handed to webview.executeJavaScript, with the watcher
// returning a Promise the host awaits. No extra preload bundle needed.

/** Helpers shared by both scripts; concatenated into each one. */
const HELPERS = `
  function odVisible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  function odPasswordFields() {
    return Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).filter(odVisible);
  }
  // The username is the nearest text-ish input before the password field,
  // scoped to the same form when there is one. Falls back to looking after
  // it, for the layouts that put the password first.
  // allowCarried opens up hidden / read-only fields. That is right when
  // capturing a two-step login, and wrong when filling one in: writing to a
  // hidden field would clobber a CSRF token.
  function odUserFor(pw, allowCarried) {
    const scope = pw.form || document;
    const inputs = Array.prototype.slice.call(scope.querySelectorAll('input')).filter(odVisible);
    const textish = function (el) {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return t === 'text' || t === 'email' || t === 'tel' || t === 'username';
    };
    const idx = inputs.indexOf(pw);
    for (let i = idx - 1; i >= 0; i--) if (textish(inputs[i])) return inputs[i];
    for (let i = idx + 1; i < inputs.length; i++) if (textish(inputs[i])) return inputs[i];
    // Nothing visible: a two-step flow has already taken the account name,
    // and at best left it in a hidden or read-only field. Only fields that
    // name themselves as an account — or hold something email-shaped —
    // qualify, so a CSRF token is never mistaken for a username.
    if (!allowCarried) return null;
    const accountish = /user|email|login|account|ident/i;
    const carried = Array.prototype.slice.call(scope.querySelectorAll('input'))
      .filter(function (el) {
        if (el === pw || el.type === 'password' || !el.value) return false;
        if (/.+@.+\\..+/.test(el.value)) return true;
        return accountish.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || ''));
      });
    return carried[0] || null;
  }
  // React and friends track the last value they wrote, so a plain
  // \`el.value = x\` is reverted on the next render. Going through the
  // prototype setter makes the framework see a real user edit.
  function odSetValue(el, v) {
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
`;

/** Key under which a capture is parked so it survives the login navigation. */
const STASH = '__odPendingLogin';

/**
 * Resolves with `{ username, password, url }` the moment a login looks like
 * it is being submitted, or with `null` if the host cancels first. Also parks
 * the capture in sessionStorage, because a classic form POST can tear the
 * frame down before the promise makes it back across IPC.
 */
export const WATCH_LOGIN_SCRIPT = `
new Promise((resolveFn) => {
  ${HELPERS}
  // Re-arming on a new page must retire the previous watcher.
  if (window.__odLoginCancel) { try { window.__odLoginCancel(); } catch (e) {} }

  let done = false;
  function cleanup() {
    window.__odLoginCancel = null;
    document.removeEventListener('submit', onSubmit, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function capture() {
    if (done) return;
    const pw = odPasswordFields().filter(function (p) { return p.value; })[0];
    if (!pw) return;
    const user = odUserFor(pw, true);
    const payload = { username: user ? user.value : '', password: pw.value, url: location.href };
    done = true;
    cleanup();
    try { sessionStorage.setItem(${JSON.stringify(STASH)}, JSON.stringify(payload)); } catch (e) {}
    resolveFn(payload);
  }
  function onSubmit() { capture(); }
  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    // Any button-ish thing: a real submit, or the <div role="button"> an
    // SPA login uses instead.
    if (t.closest('button, input[type="submit"], input[type="button"], [role="button"]')) capture();
  }
  function onKey(e) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t && t.tagName === 'INPUT') capture();
  }
  window.__odLoginCancel = function () { if (done) return; done = true; cleanup(); resolveFn(null); };

  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})
`;

/** Reads and clears a capture parked before the login navigation. */
export const DRAIN_LOGIN_SCRIPT = `(function () {
  try {
    const raw = sessionStorage.getItem(${JSON.stringify(STASH)});
    if (!raw) return null;
    sessionStorage.removeItem(${JSON.stringify(STASH)});
    return JSON.parse(raw);
  } catch (e) { return null; }
})()`;

/** Retires the watcher from the host side, e.g. when the panel unmounts. */
export const CANCEL_LOGIN_SCRIPT = `(function () {
  if (window.__odLoginCancel) { window.__odLoginCancel(); return true; }
  return false;
})()`;

/**
 * Fills one credential in. Login forms are frequently rendered after first
 * paint, so it retries for a few seconds instead of giving up on an empty
 * first look. Resolves true once something was filled.
 */
export function autofillScript(username: string, password: string): string {
  return `
new Promise((resolveFn) => {
  ${HELPERS}
  const user = ${JSON.stringify(username)};
  const pass = ${JSON.stringify(password)};
  let tries = 0;
  function attempt() {
    const fields = odPasswordFields();
    // Exactly one password box means "sign in". Two or more is a signup or
    // change-password form, which we leave alone.
    if (fields.length === 1) {
      const pw = fields[0];
      const u = odUserFor(pw, false);
      if (user && u) odSetValue(u, user);
      odSetValue(pw, pass);
      resolveFn(true);
      return;
    }
    if (++tries > 12) { resolveFn(false); return; }
    setTimeout(attempt, 250);
  }
  attempt();
})
`;
}
