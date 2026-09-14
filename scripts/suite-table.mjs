// Check the README's suite table against the suites themselves.
//
// The table is not carried by anything else: it names suites individually, so a
// commit touching one of those files can stale it, and only re-running finds
// out. Two rounds of this in one session (#224 three rows, #279 two) were found
// because a person chose to run them, which is why this is a command.
//
// It checks two of the three layers a stale row can be wrong in: the suite
// still exists, and its count still matches. It cannot check the third — whether
// the description still says what the suite covers — because that needs reading
// the description and then reading the tests, and neither is derivable here.
//
//   node scripts/suite-table.mjs [readme]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const readme = process.argv[2] ?? "README.md";
const text = readFileSync(readme, "utf8");

const rows = [];
for (const line of text.split("\n")) {
  const m = line.match(/^\|\s*`([a-z-]+)`(?:\s*·\s*`([a-z-]+)`)?\s*\|\s*(\d+)\s*\|/);
  if (m) rows.push({ first: m[1], second: m[2], stated: Number(m[3]) });
}
if (rows.length === 0) {
  console.error(`suite-table: no suite rows found in ${readme}`);
  process.exit(2);
}

const count = (suite) => {
  try {
    const out = execFileSync("node", [`test/${suite}.ts`], { encoding: "utf8", timeout: 300_000 });
    const m = out.match(/(\d+) passed/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
};

let stale = 0;
for (const { first, second, stated } of rows) {
  const a = count(first);
  const b = second ? count(second) : 0;
  const actual = a === null || b === null ? null : a + b;
  const label = second ? `${first} · ${second}` : first;
  if (actual === null) {
    stale++;
    console.log(`  ???   ${label.padEnd(24)} could not run (a suite missing, or this checkout has no node_modules)`);
  } else if (actual !== stated) {
    stale++;
    console.log(`  STALE ${label.padEnd(24)} readme=${stated} actual=${actual}`);
  } else {
    console.log(`  ok    ${label.padEnd(24)} ${stated}`);
  }
}

console.log(`\n  ${rows.length - stale}/${rows.length} rows agree`);
console.log(`  (a count is the symptom; whether the description still says what the suite covers is not checkable here)`);
process.exit(stale ? 1 : 0);
