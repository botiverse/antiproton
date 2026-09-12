/**
 * The two pages a person sees before the console: sign-in, and why a sign-in
 * was refused.
 *
 * Both are pure renderers; the routes (`GET /login`, `GET /login/refused`)
 * and the OAuth exchange behind them live in index.ts. Nothing here reads a
 * request, so nothing here can be talked into rendering a caller-supplied
 * identity: the pages carry the brand, one button, and words.
 *
 * The button goes to `/login/github`, which starts the OAuth flow against
 * GitHub. Any GitHub account can sign in and gets an agent of its own, and
 * everything a person owns is keyed on that account rather than on an email,
 * so the page says both up front rather than after the round trip. The QA entrance (`/login/key`) is deliberately absent from the
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

// GitHub's mark, drawn small for the button: the "mark-github" glyph from
// @primer/octicons 19.36.0 (MIT; see NOTICE), path data verbatim.
// Monochrome so it takes the button's ink in every theme.
const GITHUB_MARK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor"><path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg>`;

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
 * in gives away (username, name and avatar), because a person deciding
 * whether to press a button deserves to know both before the redirect, not
 * on GitHub's consent screen.
 */
export function loginPage(): string {
  return shell("sign in",
    `<h1>Sign in to the console</h1>
  <p>This console drives a real agent against the operator's model account, so it needs to know who you are.</p>
  <a class="btn" href="/login/github" rel="nofollow">${GITHUB_MARK}Sign in with GitHub</a>
  <p class="fine">Any GitHub account can sign in; your first sign-in creates an agent of your own. GitHub shares your username, name and avatar with antiproton; everything you create here is keyed on that account.
  New to this? <a href="https://report.antiproton.ai/" target="_blank" rel="noopener">Read what antiproton is</a> first.</p>`);
}

/**
 * Why a sign-in was refused, keyed by the `reason` the callback redirects
 * with. Each entry says what happened and what to do about it, in that order;
 * none of them names the mechanism, because the person cannot act on it.
 */
export const REFUSALS: Record<string, { title: string; body: string; next: string }> = {
  "not-invited": {
    title: "That account is not on the list",
    body: "This console lets in the GitHub accounts its operator has invited, and yours is not one of them yet.",
    next: "Ask the operator to add your GitHub username, then sign in again.",
  },
  state: {
    title: "The sign-in did not come back the way it left",
    body: "This happens when the page sat open too long, or the browser dropped the cookie that remembers where you were going.",
    next: "Start the sign-in again from here.",
  },
  exchange: {
    title: "GitHub did not accept the sign-in",
    body: "The one-time code GitHub sent back could not be traded for an identity. Codes expire within minutes and work once.",
    next: "Start the sign-in again from here.",
  },
  unconfigured: {
    title: "Sign-in is not set up on this deployment",
    body: "The operator has not configured sign-in with GitHub here, so nobody can sign in yet.",
    next: "Tell the operator. There is nothing to do on your side.",
  },
};

const GENERIC = {
  title: "Sign-in did not complete",
  body: "GitHub sent you back without a usable identity.",
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
  <a class="btn" href="/login">Back to sign in</a>
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
  <p class="why">For testing this deployment with a browser. A person signs in with <a href="/login">GitHub</a> instead.</p>
  <form method="post" action="/login/key" autocomplete="off">
    <label class="field"><span>key</span><input type="password" name="key" autocomplete="off" spellcheck="false" autofocus required></label>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
    <button type="submit" class="btn">sign in</button>
  </form>
  <p class="fine">The key is never shown and never sent anywhere but here.</p>`);
}
