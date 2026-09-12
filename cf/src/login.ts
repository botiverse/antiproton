/**
 * The two pages a person sees before the console: sign-in, and why a sign-in
 * was refused.
 *
 * Both are pure renderers; the routes (`GET /login`, `GET /login/refused`)
 * and the OAuth exchange behind them live in index.ts. Nothing here reads a
 * request, so nothing here can be talked into rendering a caller-supplied
 * identity: the pages carry the brand, one button, and words.
 *
 * The button goes to `/login/raft`, which starts the OpenID flow against Raft.
 * The console signs in humans only (a Raft *agent* account is refused after
 * the exchange, see `REFUSALS`), and it keys everything a person owns on their
 * verified email, so the page says both up front rather than after the
 * round trip. The QA entrance (`/login/key`) is deliberately absent from the
 * sign-in page: it is a secret, not a choice. Its own form is rendered here
 * too (`keyPage`), so the one person who does reach it sees the same product.
 */
import { FAVICON_DATA_URI, LOCKUP_SVG } from "./brand.ts";
import { RUI_TOKENS } from "./rui-tokens.ts";
import { FONT_CSS, GEIST_MONO_SRC } from "./static.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Restores the theme the viewer chose in the console, so the door matches the room. */
export const THEME_BOOT = `<script>(function(){var t='brutal';try{t=localStorage.getItem('ap-theme')||'brutal'}catch(e){}var h=document.documentElement;if(t==='elegant'){h.setAttribute('data-theme','elegant');h.classList.add('light')}else if(t==='elegant-dark'){h.setAttribute('data-theme','elegant');h.classList.add('dark')}else{h.setAttribute('data-theme','brutal')}})()</script>`;

// Small on purpose: the console's own aliases for the tokens this page needs,
// the same names ui.ts aliases, so a token change lands on both.
const CSS = `
:root{--bg:var(--layer-canvas);--panel:var(--layer-panel);--line:var(--line-muted);--ink:var(--foreground);
--strong:var(--foreground-strong);--dim:var(--foreground-hint);color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--mono-font);display:grid;place-items:center;padding:24px}
.door{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:28px 28px 22px;box-shadow:var(--theme-shadow-md)}
.door .lockup{width:210px;margin:0 0 22px;color:var(--strong)}
.door .lockup svg{width:100%;height:auto;display:block}
.door .lockup .bar{fill:var(--primary-400);stroke:var(--primary-400)}
.door h1{font-size:15px;font-weight:600;color:var(--strong);margin:0 0 8px;letter-spacing:.01em}
.door p{margin:0 0 14px;color:var(--ink)}
.door p.why{color:var(--dim);font-size:12.5px}
.door .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin:20px 0 14px;
background:var(--primary-400);color:var(--primary-950);border:1px solid var(--line-strong);border-radius:6px;
padding:11px 14px;font:inherit;font-size:13.5px;font-weight:600;line-height:1.2;text-decoration:none;cursor:pointer;
box-shadow:var(--theme-shadow-xs);transition:background .15s ease-out,box-shadow .15s ease-out}
.door .btn:hover{background:var(--primary-500)}
.door .btn svg{width:16px;height:16px;flex:none}
.door .fine{margin:0;color:var(--dim);font-size:11.5px;line-height:1.5}
.door .fine a,.door p a{color:var(--ink);text-decoration:underline;text-underline-offset:2px}
.door .fine a:hover,.door p a:hover{color:var(--strong)}
.door .field{display:block;margin:18px 0 0}
.door .field span{display:block;font-size:11.5px;color:var(--dim);margin-bottom:5px}
.door .field input{width:100%;font:inherit;font-size:13.5px;padding:9px 10px;color:var(--strong);background:var(--layer-canvas-muted);
border:1px solid var(--line);border-radius:6px;outline:0}
.door .field input:focus{box-shadow:0 0 0 1px var(--primary-400);border-color:var(--primary-400)}
.door .err{margin:10px 0 0;color:var(--danger-strong);font-size:12.5px}
.door form .btn{margin:16px 0 14px}
[data-theme="brutal"] .door .field input{border:2px solid var(--line-strong);border-radius:0;background:var(--layer-panel);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] .door .field input:focus{box-shadow:var(--theme-shadow-md)}
.door .reason{display:inline-block;margin:0 0 14px;padding:2px 7px;border:1px solid var(--line);border-radius:4px;color:var(--dim);font-size:11.5px;word-break:break-all}
:focus-visible{outline:2px solid var(--primary-400);outline-offset:2px}
[data-theme="brutal"] .door{border:2px solid var(--line-strong);border-radius:0;box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] .door .btn{border:2px solid var(--line-strong);border-radius:0;box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] .door .btn:hover{box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] .door .reason{border:2px solid var(--line-strong);border-radius:0}
@media(max-width:480px){body{padding:14px;align-items:start}.door{padding:22px 18px 18px}}
`;

// Raft's mark, drawn small for the button: four squares, the platform's tile.
// Monochrome so it takes the button's ink in every theme.
const RAFT_MARK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1.2"/><rect x="9" y="1" width="6" height="6" rx="1.2"/><rect x="1" y="9" width="6" height="6" rx="1.2"/><rect x="9" y="9" width="6" height="6" rx="1.2"/></svg>`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en" data-theme="brutal"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} · antiproton</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
${THEME_BOOT}
<link rel="preload" href="${GEIST_MONO_SRC}" as="font" type="font/woff2" crossorigin>
<style>${FONT_CSS}${RUI_TOKENS}${CSS}</style></head><body>
<main class="door">
  <div class="lockup">${LOCKUP_SVG}</div>
  ${body}
</main></body></html>`;
}

/**
 * GET /login. One button. The words say what the console is and what signing
 * in gives away (name and email), because a person deciding whether to press
 * a button deserves to know both before the redirect, not on Raft's consent
 * screen.
 */
export function loginPage(): string {
  return shell("sign in",
    `<h1>Sign in to the console</h1>
  <p>This console drives a real agent against the operator's model account, so it needs to know who you are.</p>
  <a class="btn" href="/login/raft" rel="nofollow">${RAFT_MARK}Login with Raft</a>
  <p class="fine">Human accounts only. Raft shares your name and email with antiproton; everything you create here is keyed on that email.
  New to this? <a href="https://report.antiproton.ai/" target="_blank" rel="noopener">Read what antiproton is</a> first.</p>`);
}

/**
 * Why a sign-in was refused, keyed by the `reason` the callback redirects
 * with. Each entry says what happened and what to do about it, in that order;
 * none of them names the mechanism, because the person cannot act on it.
 */
export const REFUSALS: Record<string, { title: string; body: string; next: string }> = {
  "not-human": {
    title: "That is an agent account",
    body: "The console signs in people only. An agent reaches its work through the runtime, not through this page.",
    next: "Sign in with your own Raft account instead.",
  },
  "no-email": {
    title: "Your account did not share an email",
    body: "The console keys everything you own on a verified email, so it cannot sign you in without one.",
    next: "Add and verify an email on your Raft profile, then try again.",
  },
  "wrong-server": {
    title: "Wrong Raft server",
    body: "You signed in with an account on a Raft server this console is not registered with.",
    next: "Try again and pick the server antiproton lives on.",
  },
  state: {
    title: "The sign-in did not come back the way it left",
    body: "This happens when the page sat open too long, or the browser dropped the cookie that remembers where you were going.",
    next: "Start the sign-in again from here.",
  },
  exchange: {
    title: "Raft did not accept the sign-in",
    body: "The one-time code Raft sent back could not be traded for an identity. Codes expire within minutes and work once.",
    next: "Start the sign-in again from here.",
  },
  unconfigured: {
    title: "Sign-in is not set up on this deployment",
    body: "The operator has not configured Login with Raft here, so nobody can sign in yet.",
    next: "Tell the operator. There is nothing to do on your side.",
  },
};

const GENERIC = {
  title: "Sign-in did not complete",
  body: "Raft sent you back without a usable identity.",
  next: "Try again; if it keeps happening, tell the operator what the reason below says.",
};

/** GET /login/refused?reason=…  An unknown reason renders the generic page with the reason shown, escaped. */
export function refusedPage(reason: string): string {
  const known = Object.prototype.hasOwnProperty.call(REFUSALS, reason) ? REFUSALS[reason] : null;
  const r = known ?? GENERIC;
  const tag = known ? "" : `<span class="reason">${esc(reason || "no reason given")}</span>\n  `;
  return shell(r.title,
    `<h1>${esc(r.title)}</h1>
  <p>${esc(r.body)}</p>
  ${tag}<p class="why">${esc(r.next)}</p>
  <a class="btn" href="/login">${RAFT_MARK}Back to sign in</a>
  <p class="fine">Nothing was created. You are not signed in.</p>`);
}

/**
 * GET /login/key, and the 401 re-render when the key did not match. The QA
 * entrance: one password field, nothing else, and no link leads here. It
 * wears the door's clothes so that whoever QA is that day sees one product,
 * not a page from before. `error` is a sentence of ours, never the key.
 */
export function keyPage(error?: string): string {
  return shell("sign in with a key",
    `<h1>Sign in with a key</h1>
  <p class="why">For testing this deployment with a browser. A person signs in with <a href="/login">Login with Raft</a> instead.</p>
  <form method="post" action="/login/key" autocomplete="off">
    <label class="field"><span>key</span><input type="password" name="key" autocomplete="off" spellcheck="false" autofocus required></label>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
    <button type="submit" class="btn">sign in</button>
  </form>
  <p class="fine">The key is never shown and never sent anywhere but here.</p>`);
}
