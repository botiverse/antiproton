/**
 * Markdown, rendered into a fixed subset on the server.
 *
 * The agent answers in markdown — tables, headings, emphasis — and showing that
 * as literal text throws most of it away. But its output is not trustworthy: it
 * reads web pages, so a page it fetched can try to make it emit an `onerror`
 * attribute, and this console carries the operator's session.
 *
 * So no HTML passes through. The text is escaped *first*, and every tag below
 * is built from what survives escaping: there is no path from model output to a
 * tag name or an attribute. That is the whole security argument, and it is one
 * line rather than a sanitiser to keep up to date.
 *
 * A subset on purpose — what the agent actually writes, and no more. Anything
 * unrecognised stays the text it was.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function md(src: string): string {
  const fences: string[] = [];
  // Escaped before anything else, so every branch below works on inert text.
  let t = esc(src ?? "");
  t = t.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, body) => {
    fences.push(`<pre>${String(body).replace(/\n$/, "")}</pre>`);
    return ` F${fences.length - 1} `;
  });

  const inline = (x: string) =>
    x
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      // http(s) only, and never sharing the opener's window.
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  const out: string[] = [];
  const lines = t.split("\n");
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // A table needs its separator row to be a table at all, or every line with
    // a pipe in it becomes one.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      closeList();
      const cells = (r: string) =>
        r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 1;
      const body: string[][] = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1]!)) {
        body.push(cells(lines[++i]!));
      }
      out.push(
        `<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>` +
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
        "</table>",
      );
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<div class="mdh h${h[1]!.length}">${inline(h[2]!)}</div>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
      continue;
    }
    closeList();

    // `>` has already been escaped by the time we get here.
    if (/^\s*&gt;\s?/.test(line)) {
      out.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); continue; }
    if (!line.trim()) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return out.join("\n").replace(/F(\d+)/g, (_m, n) => fences[Number(n)]!);
}
