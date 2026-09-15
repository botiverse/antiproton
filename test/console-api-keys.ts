/**
 * A person's API keys page (cf/src/ui.ts apiKeysPanel): the key is on the page once, when it is made, and
 * never in the list; revoking asks first and says it cannot be undone; names are escaped.
 */
import { apiKeysPanel } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const t = 1_800_000_000_000;
const live = { hash: "a".repeat(64), label: "ci", createdAt: t, revokedAt: null };
const revoked = { hash: "b".repeat(64), label: "old laptop", createdAt: t - 1000, revokedAt: t - 10 };
const base = { baseUrl: "https://antiproton.ai/v1", max: 10, issued: null, error: null };
const KEY = "ap-" + "k".repeat(43);

check("the key is on the page when it is made, once, and not in the list that follows", () => {
  const made = apiKeysPanel({ ...base, keys: [live], issued: { key: KEY, label: "ci" } });
  must(made.split(KEY).length - 1 === 1, `the new key appears ${made.split(KEY).length - 1} times`);
  must(/only time/i.test(made) && made.includes("https://antiproton.ai/v1"), "no copy-it-now note or base URL beside the new key");
  const later = apiKeysPanel({ ...base, keys: [live] });
  must(!later.includes(KEY) && !/ap-[A-Za-z0-9_-]{16,}/.test(later), "a key value is on the list page");
});

check("a live key can be revoked after a confirmation that says it cannot be undone; a revoked one cannot", () => {
  const page = apiKeysPanel({ ...base, keys: [live, revoked] });
  const forms = page.match(/<form[^>]*hx-post="\/ui\/api-keys\/revoke"[^>]*>[\s\S]*?<\/form>/g) ?? [];
  must(forms.length === 1, `revoke forms: ${forms.length}`);
  must(forms[0]!.includes(live.hash) && !forms[0]!.includes(revoked.hash), "the revoke form is not the live key's");
  must(/hx-confirm="[^"]*cannot be undone/.test(forms[0]!), "revoking does not ask first, or does not say it is final");
  must(/revoked/.test(page), "the revoked key is not shown as revoked");
});

check("names are escaped, in the list and in the confirmation", () => {
  const page = apiKeysPanel({ ...base, keys: [{ ...live, label: `<img src=x onerror=alert(1)> "q"` }] });
  must(!page.includes("<img src=x"), "a key name reached the page as markup");
  must(!/hx-confirm="[^"]*"q"/.test(page), "a quote in a name closed the confirmation attribute");
});

check("at the limit the create button is off and says why; an error is shown", () => {
  const full = apiKeysPanel({ ...base, max: 1, keys: [live], error: "revoke one first" });
  must(/<button type="submit"[^>]*disabled/.test(full), "create is still offered at the limit");
  must(full.includes("revoke one first"), "the error is not shown");
  const empty = apiKeysPanel({ ...base, keys: [] });
  must(!/<button type="submit"[^>]*disabled/.test(empty) && /no keys yet/.test(empty), "an empty page is not ready to create");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
