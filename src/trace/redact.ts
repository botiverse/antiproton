/**
 * Credential shapes out of free text: token shapes, `key=value` secrets, url userinfo and queries, long opaque blobs.
 * Shared by what writes text someone else reads later: the friction scan's excerpts of what an agent wrote
 * (cf/src/friction.ts `redact`) and a failed tool call's error on its trace row (src/trace/seams.ts `failureAttrs`).
 * By shape, not by value: neither writer holds the secrets themselves, so a credential that matches no shape here is
 * not caught, and a shape added here is caught by both.
 */
const TOKEN_SHAPES = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:agent|machine|computer|daemon)_[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|rmc\.[A-Za-z0-9._-]{10,})/g;
const KEY_VALUE = /(bearer|token|secret|password|passwd|api[_-]?key|authorization|cookie|x-harness-token)(["'\s:=]+)[^\s"',;]{6,}/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi;
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?"'#]+)\?[^\s"'#]*/gi;
const BLOB = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

export function redactCredentialShapes(s: unknown): string {
  return String(s ?? "")
    .replace(/__AP_[A-Za-z0-9_]+/g, "<placeholder>")
    .replace(TOKEN_SHAPES, "<secret>")
    .replace(KEY_VALUE, (_m, k: string, sep: string) => `${k}${sep}<redacted>`)
    .replace(URL_CREDENTIALS, "$1<cred>@")
    .replace(URL_QUERY, "$1?<query>")
    .replace(BLOB, "<blob>");
}
