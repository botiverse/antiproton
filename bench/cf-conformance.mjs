const BASE = process.env.CF_BASE ?? "https://antiproton.botiverse.workers.dev";
const show = (title, d) => {
  console.log(`\n  ${title}\n  ${"─".repeat(66)}`);
  if (!d.results) { console.log("  " + JSON.stringify(d).slice(0, 400)); return; }
  for (const r of d.results) {
    if (r.ok) console.log(`  \x1b[32m✓\x1b[0m ${r.row.padEnd(22)} ${r.name}`);
    else console.log(`  \x1b[31m✗\x1b[0m ${r.row.padEnd(22)} ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
  }
  const pass = d.results.filter((r) => r.ok).length;
  console.log(`  ${"─".repeat(66)}\n  ${pass} passed, ${d.results.length - pass} failed  (${d.ms} ms)`);
};
for (const [path, title] of [
  ["/conformance/executor", "Executor contract — Cloudflare Dynamic Workers"],
]) {
  const res = await fetch(BASE + path);
  show(title, await res.json());
}
