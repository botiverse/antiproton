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

check("正文里的 F 数字不会碰到代码块", () => {
  const out = md("F1 是个变量名\n\n```\ncode\n```");
  has(out, "<pre>code</pre>");
  has(out, "F1 是个变量名");
});

check("正文里写成占位符样子的文字原样显示，不会变成代码块", () => {
  // Fenced blocks are kept apart from the prose rather than marked inside it, so text shaped
  // like an old in-band marker is only text: it must neither print a block a second time nor
  // resolve to the word "undefined".
  const forged = "para\n\u0001F0\u0001\n```\nreal\n```";
  const out = md(forged);
  const pres = out.match(/<pre>/g) ?? [];
  if (pres.length !== 1) throw new Error(`the block was printed ${pres.length} times: ${out.slice(0, 200)}`);
  has(out, "<p>\u0001F0\u0001</p>");
  const oob = md("x \u0001F3\u0001 y F0 F1");
  if (oob !== "<p>x \u0001F3\u0001 y F0 F1</p>") throw new Error(`not literal: ${JSON.stringify(oob)}`);
});

check("U+0001 是普通字符：正文和围栏里都保留，也不会带出标签", () => {
  const prose = md("a\u0001b **c\u0001d** <i>\u0001</i>");
  if (prose !== "<p>a\u0001b <strong>c\u0001d</strong> &lt;i&gt;\u0001&lt;/i&gt;</p>") {
    throw new Error(`prose: ${JSON.stringify(prose)}`);
  }
  const fenced = md("```\n\u0001F0\u0001 <b>\u0001</b>\n```");
  if (fenced !== "<p> <pre>\u0001F0\u0001 &lt;b&gt;\u0001&lt;/b&gt;</pre> </p>") {
    throw new Error(`fence: ${JSON.stringify(fenced)}`);
  }
});

check("没有闭合的围栏仍是正文", () => {
  const out = md("text\n```js\nnever closed\n**still prose**");
  hasNot(out, "<pre>");
  has(out, "<p>```js</p>");
  has(out, "<strong>still prose</strong>");
});

// Rendered by the renderer this one replaced, which marked fenced blocks inside the text and
// substituted them back afterwards. Ordinary markdown must come out byte for byte the same.
const CORPUS: Array<[string, string, string]> = [
  ["headings", "# One\n## Two\n### Three\n#### Four\n##### Five is prose",
    "<div class=\"mdh h1\">One</div>\n<div class=\"mdh h2\">Two</div>\n<div class=\"mdh h3\">Three</div>\n<div class=\"mdh h4\">Four</div>\n<p>##### Five is prose</p>"],
  ["lists", "- a\n- b\n* c\n+ d\n\n1. one\n2) two\n3. three\n- back to ul",
    "<ul>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n<li>d</li>\n</ul>\n<ol>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ol>\n<ul>\n<li>back to ul</li>\n</ul>"],
  ["nestedList", "- top\n  - nested\n    1. deep",
    "<ul>\n<li>top</li>\n<li>nested</li>\n</ul>\n<ol>\n<li>deep</li>\n</ol>"],
  ["table", "| a | b |\n| --- | :-: |\n| **1** | `2` |\n| [x](https://e.com) | *i* |\nafter",
    "<table><tr><th>a</th><th>b</th></tr><tr><td><strong>1</strong></td><td><code>2</code></td></tr><tr><td><a href=\"https://e.com\" target=\"_blank\" rel=\"noopener noreferrer\">x</a></td><td><em>i</em></td></tr></table>\n<p>after</p>"],
  ["tableNoSep", "| a | b |\n| 1 | 2 |",
    "<p>| a | b |</p>\n<p>| 1 | 2 |</p>"],
  ["emphasis", "**bold** and *em* and **bold with *em* inside** and (*paren em*) and a*b*c",
    "<p><strong>bold</strong> and <em>em</em> and **bold with <em>em</em> inside** and (<em>paren em</em>) and a*b*c</p>"],
  ["fenceBackticksStrong", "before\n```ts\nconst s = `x ${y}`;\n**not strong** <b>x</b> & 'q'\n```\nafter",
    "<p>before</p>\n<p> <pre>const s = `x ${y}`;\n**not strong** &lt;b&gt;x&lt;/b&gt; &amp; &#39;q&#39;</pre> </p>\n<p>after</p>"],
  ["fenceAtStart", "```\nfirst\n```\ntext",
    "<p> <pre>first</pre> </p>\n<p>text</p>"],
  ["fenceAtEnd", "text\n```py\nlast\n```",
    "<p>text</p>\n<p> <pre>last</pre> </p>"],
  ["fenceEmpty", "```\n```",
    "<p> <pre></pre> </p>"],
  ["fenceBlankLines", "```\n\ncode\n\n```",
    "<p> <pre>\ncode\n</pre> </p>"],
  ["twoFences", "```a\none\n```\nmid\n```b\ntwo\n```",
    "<p> <pre>one</pre> </p>\n<p>mid</p>\n<p> <pre>two</pre> </p>"],
  ["fenceInList", "- item\n```\ncode\n```\n- item2",
    "<ul>\n<li>item</li>\n</ul>\n<p> <pre>code</pre> </p>\n<ul>\n<li>item2</li>\n</ul>"],
  ["fenceInTable", "| a | b |\n| - | - |\n| 1 | 2 |\n```\nc\n```",
    "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>\n<p> <pre>c</pre> </p>"],
  ["quotes", "> quoted **bold**\n>no space\n  > indented",
    "<blockquote>quoted <strong>bold</strong></blockquote>\n<blockquote>no space</blockquote>\n<blockquote>indented</blockquote>"],
  ["hr", "a\n---\nb\n***\nc\n- - -",
    "<p>a</p>\n<hr>\n<p>b</p>\n<hr>\n<p>c</p>\n<ul>\n<li>- -</li>\n</ul>"],
  ["links", "[ok](https://example.com/a?b=1&c=2) [bad](javascript:alert(1)) [ftp](ftp://x)",
    "<p><a href=\"https://example.com/a?b=1&amp;c=2\" target=\"_blank\" rel=\"noopener noreferrer\">ok</a> [bad](javascript:alert(1)) [ftp](ftp://x)</p>"],
  ["inlineCode", "`a` and `<b>` and ``double`` and `unclosed",
    "<p><code>a</code> and <code>&lt;b&gt;</code> and `<code>double</code><code> and </code>unclosed</p>"],
  ["crlf", "# H\r\n- a\r\n- b\r\n\r\npara\r\n```js\r\ncode\r\n```\r\n",
    "<p># H\r</p>\n<p>- a\r</p>\n<p>- b\r</p>\n<p>para\r</p>\n<p>```js\r</p>\n<p>code\r</p>\n<p>```\r</p>"],
  ["unterminated", "text\n```js\nnever closed\n**still prose**",
    "<p>text</p>\n<p>```js</p>\n<p>never closed</p>\n<p><strong>still prose</strong></p>"],
  ["unterminatedThenReal", "```\nopen\n",
    "<p>```</p>\n<p>open</p>"],
  ["html", "见 <img src=x onerror=alert(1)> 和 <script>alert(2)</script>",
    "<p>见 &lt;img src=x onerror=alert(1)&gt; 和 &lt;script&gt;alert(2)&lt;/script&gt;</p>"],
  ["F1", "F1 是个变量名\n\n```\ncode\n```",
    "<p>F1 是个变量名</p>\n<p> <pre>code</pre> </p>"],
  ["testTable", "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>"],
  ["testProsePipe", "cost | benefit is the tradeoff",
    "<p>cost | benefit is the tradeoff</p>"],
  ["testMixed", "## 结论\n\n**是** 且 `16.5s`\n\n- 一\n- 二\n\n1. 甲\n2. 乙",
    "<div class=\"mdh h2\">结论</div>\n<p><strong>是</strong> 且 <code>16.5s</code></p>\n<ul>\n<li>一</li>\n<li>二</li>\n</ul>\n<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>"],
  ["testQuote", "> 注意这个",
    "<blockquote>注意这个</blockquote>"],
  ["testFence", "```\n<b>not bold</b> **not strong**\n```",
    "<p> <pre>&lt;b&gt;not bold&lt;/b&gt; **not strong**</pre> </p>"],
  ["testLinkOk", "[good](https://example.com)",
    "<p><a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">good</a></p>"],
  ["testLinkBad", "[bad](javascript:alert(1))",
    "<p>[bad](javascript:alert(1))</p>"],
  ["empty", "",
    ""],
  ["blank", "\n\n  \n",
    ""],
  ["trailingNewlines", "para\n\n\n",
    "<p>para</p>"],
  ["longReply", "## Summary\n\nThe run **passed** in `16.5s`.\n\n| step | ms |\n|---|---|\n| fetch | 12 |\n| parse | 3 |\n\n1. First\n2. Second\n\n```bash\nnpm ci && node test/markdown.ts\n```\n\n> Note: see [docs](https://example.com/docs).\n\n---\n\n- done",
    "<div class=\"mdh h2\">Summary</div>\n<p>The run <strong>passed</strong> in <code>16.5s</code>.</p>\n<table><tr><th>step</th><th>ms</th></tr><tr><td>fetch</td><td>12</td></tr><tr><td>parse</td><td>3</td></tr></table>\n<ol>\n<li>First</li>\n<li>Second</li>\n</ol>\n<p> <pre>npm ci &amp;&amp; node test/markdown.ts</pre> </p>\n<blockquote>Note: see <a href=\"https://example.com/docs\" target=\"_blank\" rel=\"noopener noreferrer\">docs</a>.</blockquote>\n<hr>\n<ul>\n<li>done</li>\n</ul>"],

];

check("常规 markdown 的输出与旧渲染器逐字节相同", () => {
  const off = CORPUS.filter(([, src, want]) => md(src) !== want);
  if (off.length) {
    throw new Error(off.map(([name, src, want]) =>
      `${name}: want ${JSON.stringify(want)} got ${JSON.stringify(md(src))}`).join("\n"));
  }
});

console.log(`\n  Markdown rendering\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
