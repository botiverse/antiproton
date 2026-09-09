/**
 * The console renders the agent's markdown, and the agent's output is not
 * trustworthy — it reads web pages. So the interesting cases here are the
 * hostile ones: nothing the model writes may become a tag or an attribute.
 */
import { md } from "../cf/src/md.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const has = (h: string, n: string) => { if (!h.includes(n)) throw new Error(`missing ${n} in: ${h.slice(0, 200)}`); };
const hasNot = (h: string, n: string) => { if (h.includes(n)) throw new Error(`LEAKED ${n} in: ${h.slice(0, 200)}`); };

check("模型写的 HTML 永远不会变成标签", () => {
  const out = md('见 <img src=x onerror=alert(1)> 和 <script>alert(2)</script>');
  // `onerror=` surviving as *text* is harmless and expected — the angle
  // brackets around it are escaped, so it can never become an attribute. What
  // must not exist is a tag, so that is what is asserted.
  hasNot(out, "<img");
  hasNot(out, "<script");
  has(out, "&lt;img src=x onerror=alert(1)&gt;");
  // Nothing outside the small set of tags this renderer emits itself.
  const tags = [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase());
  const allowed = new Set(["p", "code", "strong", "em", "a", "ul", "ol", "li", "table", "tr",
    "th", "td", "pre", "blockquote", "hr", "div"]);
  const rogue = tags.filter((t) => !allowed.has(t));
  if (rogue.length) throw new Error(`unexpected tags: ${rogue.join(",")}`);
});

check("只允许 http(s) 链接，且不共享 opener", () => {
  const ok = md("[good](https://example.com)");
  has(ok, 'rel="noopener noreferrer"');
  has(ok, 'href="https://example.com"');
  const bad = md("[bad](javascript:alert(1))");
  hasNot(bad, "<a ");
  hasNot(bad, "javascript:alert(1)\"");
});

check("围栏里的内容不会被当作标记再解析", () => {
  const out = md("```\n<b>not bold</b> **not strong**\n```");
  has(out, "<pre>");
  hasNot(out, "<b>");
  hasNot(out, "<strong>");
});

check("表格需要分隔行才算表格", () => {
  const real = md("| a | b |\n| --- | --- |\n| 1 | 2 |");
  has(real, "<table>"); has(real, "<th>a</th>"); has(real, "<td>2</td>");
  // A line that merely contains pipes is prose.
  const prose = md("cost | benefit is the tradeoff");
  hasNot(prose, "<table>");
});

check("标题、强调、行内代码、列表", () => {
  const out = md("## 结论\n\n**是** 且 `16.5s`\n\n- 一\n- 二\n\n1. 甲\n2. 乙");
  has(out, 'class="mdh h2"');
  has(out, "<strong>是</strong>");
  has(out, "<code>16.5s</code>");
  has(out, "<ul>"); has(out, "<ol>"); has(out, "<li>一</li>");
});

check("引用块在转义之后仍然认得出来", () => {
  has(md("> 注意这个"), "<blockquote>");
});

check("围栏占位符不会被正文里的 F 数字撞坏", () => {
  const out = md("F1 是个变量名\n\n```\ncode\n```");
  has(out, "<pre>code</pre>");
  has(out, "F1 是个变量名");
});

console.log(`\n  Markdown rendering\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
