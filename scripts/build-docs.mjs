#!/usr/bin/env node
/**
 * Build script for antiproton documentation site (docs.antiproton.ai).
 * Generates standalone static HTML and version metadata in docs-site/public/.
 *
 * Invariants enforced:
 * 1. Content Stratification:
 *    - Public External (Guides, philosophy, APIs, runtime specs)
 *    - Internal Engineering (Upstream pi alignment, operational runbooks)
 *    - Historical Archives (Explicitly marked as frozen pre-implementation history)
 * 2. Deterministic Provenance:
 *    - Injects source git commit SHA, tree SHA, and build timestamp into docs-site/public/version.json
 *      and the page header/footer. No hollow "Status: Verified" assertions; readers can verify with
 *      `git rev-parse <commit>^{tree}` directly against the published tree SHA.
 * 3. Zero-Dependency & Fast:
 *    - Uses native Node.js standard library and cf/src/md.ts markdown compiler.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { md } from "../cf/src/md.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOCS_DIR = join(ROOT, "docs");
const OUT_DIR = join(ROOT, "docs-site", "public");

mkdirSync(OUT_DIR, { recursive: true });

// Copy favicons and stylesheet if present in report/public
const REPORT_PUB = join(ROOT, "report", "public");
if (existsSync(REPORT_PUB)) {
  for (const f of readdirSync(REPORT_PUB)) {
    if (f.startsWith("favicon") || f.endsWith(".css")) {
      cpSync(join(REPORT_PUB, f), join(OUT_DIR, f));
    }
  }
}

// Git provenance
let commitSha = "unknown";
let treeSha = "unknown";
let commitDate = new Date().toISOString();
try {
  commitSha = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  treeSha = execSync("git rev-parse HEAD^{tree}", { cwd: ROOT, encoding: "utf8" }).trim();
  commitDate = execSync("git log -1 --format=%cI", { cwd: ROOT, encoding: "utf8" }).trim();
} catch (e) {
  console.warn("Could not retrieve git metadata:", e.message);
}

const buildTime = new Date().toISOString();

// Document Registry with explicit stratification
const SECTIONS = [
  {
    id: "public",
    category: "Public Documentation & Guides",
    desc: "Authoritative specifications, architecture manifesto, and integration guides for builders.",
    docs: [
      { slug: "overview", file: "README.md", path: join(ROOT, "README.md"), title: "Overview & Architecture", desc: "Three-tier runtime, zero cost while idle, and execution substrate" },
      { slug: "philosophy", file: "philosophy.md", path: join(DOCS_DIR, "philosophy.md"), title: "Philosophy & Principles", desc: "First-principles manifesto: structural safety, loss-less compaction, programmable tools" },
      { slug: "plugins", file: "plugins.md", path: join(DOCS_DIR, "plugins.md"), title: "Plugin Authoring Guide", desc: "Writing, configuring, testing, and observing plugins in Antiproton" },
      { slug: "agents-api", file: "agents-api.md", path: join(DOCS_DIR, "agents-api.md"), title: "OpenAI Agents API Guide", desc: "Compatibility layer, authentication, endpoints, and tool call mapping" },
      { slug: "agent-surface", file: "agent-surface.md", path: join(DOCS_DIR, "agent-surface.md"), title: "Agent Surface & Workspaces", desc: "Usage metrics, workspace fs, subagents (send_to_agent), and Raft binding" },
      { slug: "metering", file: "metering.md", path: join(DOCS_DIR, "metering.md"), title: "Metering & Ledger Retention", desc: "Delivery attempts, credit billing, and drift checks on the pd engine" },
      { slug: "ax-design", file: "ax-design.md", path: join(DOCS_DIR, "ax-design.md"), title: "Agent Experience (AX) Design", desc: "How official applications communicate with agents across two layers" },
      { slug: "assistant-instructions", file: "assistant-default-instructions.md", path: join(DOCS_DIR, "assistant-default-instructions.md"), title: "Assistant Default Instructions", desc: "Authoritative standard instructions text for personal assistants" }
    ]
  },
  {
    id: "internal",
    category: "Internal Engineering Reference",
    desc: "Internal implementation details, operational runbooks, and upstream sync checklists.",
    badge: "Internal",
    docs: [
      { slug: "pi-upstream", file: "pi-upstream.md", path: join(DOCS_DIR, "pi-upstream.md"), title: "Upstream Pi Synchronization", desc: "Substrate seams, copied sources, deliberate divergences, and upgrade checklist" },
      { slug: "runbook", file: "runbook.md", path: join(DOCS_DIR, "runbook.md"), title: "Operator Runbook", desc: "Inspection, log diagnosis, stopping runaway turns, and trace forwarding" }
    ]
  },
  {
    id: "archive",
    category: "Historical Archives",
    desc: "Frozen pre-implementation planning documents preserved for historical rationale. Not current specifications.",
    badge: "Frozen Archive",
    docs: [
      { slug: "self-hosted-plan-archive", file: "self-hosted-plan-archive.md", path: join(DOCS_DIR, "self-hosted-plan-archive.md"), title: "Local Self-Hosted Plan (Archive)", desc: "Product Plan v1.0 (frozen history)" },
      { slug: "server-plan-archive", file: "server-plan-archive.md", path: join(DOCS_DIR, "server-plan-archive.md"), title: "Server-Side Plan (Archive)", desc: "Architecture & Implementation Plan v1.1 (frozen history)" }
    ]
  }
];

// Extract headings from markdown content
function extractHeadings(markdownText) {
  const headings = [];
  const lines = markdownText.split("\n");
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      const level = m[1].length;
      const text = m[2].trim().replace(/[*`_]/g, "");
      const anchor = text.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
      headings.push({ level, text, anchor });
    }
  }
  return headings;
}

// Render markdown to HTML and inject heading IDs for anchor linking
function renderMarkdownWithAnchors(markdownText) {
  let html = md(markdownText);
  // cf/src/md.ts emits <div class="mdh h1">Title</div>, <div class="mdh h2">...</div>
  html = html.replace(/<div class="mdh h([1-4])">([^<]+)<\/div>/g, (match, level, text) => {
    const anchor = text.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
    return `<h${level} id="${anchor}" class="heading-anchor"><a href="#${anchor}" class="anchor-link">${text}</a></h${level}>`;
  });
  return html;
}

// Compile all documents
const renderedDocs = [];
for (const section of SECTIONS) {
  for (const doc of section.docs) {
    if (!existsSync(doc.path)) {
      console.warn(`Warning: doc file missing at ${doc.path}`);
      continue;
    }
    const rawContent = readFileSync(doc.path, "utf8");
    const headings = extractHeadings(rawContent);
    const htmlContent = renderMarkdownWithAnchors(rawContent);
    renderedDocs.push({
      ...doc,
      sectionId: section.id,
      category: section.category,
      badge: section.badge,
      rawContent,
      headings,
      htmlContent
    });
  }
}

// Generate version.json
const versionData = {
  service: "docs.antiproton.ai",
  repository: "botiverse/antiproton",
  commit: commitSha,
  tree: treeSha,
  commitDate,
  builtAt: buildTime,
  sections: SECTIONS.map(s => ({
    id: s.id,
    category: s.category,
    badge: s.badge,
    docs: s.docs.map(d => ({ slug: d.slug, file: d.file, title: d.title }))
  }))
};
writeFileSync(join(OUT_DIR, "version.json"), JSON.stringify(versionData, null, 2) + "\n");

// Build single-page navigation application that can display any document instantly
// while offering search, theme toggle, and verified provenance.
const siteHtml = `<!doctype html>
<html lang="en" data-theme="elegant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Official documentation for Antiproton: serverless, multi-tenant runtime for AI agents.">
<title>Antiproton Documentation</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/favicon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="/rui-foundation.css">
<style>
:root {
  --ground: var(--layer-canvas);
  --surface: var(--layer-card);
  --sunk: var(--layer-inset);
  --ink: var(--foreground);
  --muted: var(--foreground-muted);
  --faint: var(--foreground-hint);
  --line: var(--line-muted);
  --line-strong: var(--line);
  --accent: var(--primary-strong);
  --accent-mark: var(--primary-400);
  --sidebar-w: 290px;
  --header-h: 56px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans-font);
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

/* Header */
header.top-bar {
  position: fixed; top: 0; left: 0; right: 0; height: var(--header-h);
  background: var(--surface); border-bottom: 1px solid var(--line);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 1.25rem; z-index: 100;
}
.brand { display: flex; align-items: center; gap: 0.75rem; text-decoration: none; color: var(--ink); }
.brand svg { width: 22px; height: 22px; }
.brand-name { font-family: var(--heading-font); font-weight: 700; font-size: 17px; }
.brand-tag {
  font-size: 11px; padding: 2px 7px; border-radius: 99px;
  background: var(--sunk); color: var(--muted); border: 1px solid var(--line);
}
.header-actions { display: flex; align-items: center; gap: 0.75rem; }
.search-input {
  background: var(--sunk); border: 1px solid var(--line); border-radius: 6px;
  color: var(--ink); font-size: 13px; padding: 5px 10px; width: 220px; outline: none;
}
.search-input:focus { border-color: var(--accent); }
.btn-toggle {
  background: var(--sunk); border: 1px solid var(--line); border-radius: 6px;
  color: var(--muted); padding: 5px 9px; font-size: 12px; cursor: pointer;
}
.btn-toggle:hover { color: var(--ink); border-color: var(--line-strong); }

/* Main Layout */
.layout { display: flex; margin-top: var(--header-h); min-height: calc(100vh - var(--header-h)); }

/* Sidebar */
aside.sidebar {
  width: var(--sidebar-w); position: fixed; top: var(--header-h); bottom: 0; left: 0;
  background: var(--surface); border-right: 1px solid var(--line);
  overflow-y: auto; padding: 1.5rem 1rem 3rem;
}
.section-group { margin-bottom: 1.75rem; }
.section-title {
  font-family: var(--heading-font); font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
  margin-bottom: 0.6rem; padding-left: 0.5rem;
}
.nav-link {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; border-radius: 6px; text-decoration: none;
  color: var(--muted); font-size: 13.5px; line-height: 1.4; transition: all 0.15s ease;
}
.nav-link:hover { color: var(--ink); background: var(--sunk); }
.nav-link.active {
  color: var(--foreground-strong); background: var(--sunk);
  font-weight: 600; border-left: 3px solid var(--accent);
}
.badge-archive {
  font-size: 10px; padding: 1px 5px; border-radius: 4px;
  background: oklch(0.5 0.15 40 / 0.15); color: var(--warning-strong, #c47d00);
}
.badge-internal {
  font-size: 10px; padding: 1px 5px; border-radius: 4px;
  background: oklch(0.5 0.1 220 / 0.15); color: var(--primary-strong, #2563eb);
}

/* Content Area */
main.content-area {
  margin-left: var(--sidebar-w); flex: 1; max-width: 900px;
  padding: 2.5rem 3rem 6rem;
}
article.doc-content { display: none; }
article.doc-content.active { display: block; animation: fadeIn 0.15s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

/* Typography & Markdown Render */
h1, h2, h3, h4 { font-family: var(--heading-font); color: var(--foreground-strong); margin-top: 2rem; margin-bottom: 0.75rem; font-weight: 600; }
h1 { font-size: 28px; border-bottom: 1px solid var(--line); padding-bottom: 0.5rem; margin-top: 0; }
h2 { font-size: 20px; border-bottom: 1px solid var(--line); padding-bottom: 0.4rem; }
h3 { font-size: 16px; }
h4 { font-size: 14px; }
p { margin-bottom: 1rem; color: var(--ink); }
ul, ol { margin-bottom: 1rem; padding-left: 1.5rem; }
li { margin-bottom: 0.35rem; }
code {
  font-family: var(--mono-font); font-size: 13px;
  background: var(--sunk); padding: 2px 5px; border-radius: 4px;
  border: 1px solid var(--line);
}
pre {
  background: var(--sunk); padding: 1rem; border-radius: 8px;
  border: 1px solid var(--line); overflow-x: auto; margin-bottom: 1.25rem;
}
pre code { background: none; border: none; padding: 0; font-size: 13px; }
blockquote {
  border-left: 3px solid var(--accent); padding: 0.5rem 1rem;
  background: var(--sunk); margin-bottom: 1rem; color: var(--muted);
  border-radius: 0 6px 6px 0;
}
table {
  width: 100%; border-collapse: collapse; margin-bottom: 1.5rem;
  font-size: 13.5px;
}
th, td {
  padding: 8px 12px; border: 1px solid var(--line); text-align: left;
}
th { background: var(--sunk); font-weight: 600; color: var(--foreground-strong); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.anchor-link { color: inherit; text-decoration: none; }
.anchor-link:hover { text-decoration: underline; }

/* Callout Banners */
.callout-archive {
  padding: 1rem 1.25rem; background: oklch(0.95 0.05 60);
  border: 1px solid oklch(0.8 0.1 60); border-radius: 8px;
  margin-bottom: 1.75rem; color: oklch(0.3 0.1 60); font-size: 13.5px;
}
[data-theme="elegant"].dark .callout-archive {
  background: oklch(0.25 0.05 60 / 0.3); border-color: oklch(0.4 0.1 60);
  color: oklch(0.85 0.08 60);
}
.callout-internal {
  padding: 1rem 1.25rem; background: oklch(0.95 0.03 230);
  border: 1px solid oklch(0.8 0.08 230); border-radius: 8px;
  margin-bottom: 1.75rem; color: oklch(0.3 0.08 230); font-size: 13.5px;
}
[data-theme="elegant"].dark .callout-internal {
  background: oklch(0.25 0.04 230 / 0.3); border-color: oklch(0.4 0.08 230);
  color: oklch(0.85 0.06 230);
}

/* Provenance Card */
.provenance-card {
  margin-top: 4rem; padding: 1.25rem; border-radius: 8px;
  background: var(--sunk); border: 1px solid var(--line); font-size: 12.5px;
  font-family: var(--mono-font); color: var(--muted);
}
.provenance-card .row { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-bottom: 0.5rem; }
.provenance-card .verify-hint { color: var(--faint); font-size: 11.5px; margin-top: 0.5rem; }

@media (max-width: 768px) {
  aside.sidebar { transform: translateX(-100%); transition: transform 0.2s ease; z-index: 90; }
  aside.sidebar.open { transform: translateX(0); }
  main.content-area { margin-left: 0; padding: 1.5rem; }
}
</style>
</head>
<body>

<header class="top-bar">
  <div style="display:flex;align-items:center;gap:1rem;">
    <a href="#overview" class="brand">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
      <span class="brand-name">antiproton</span>
    </a>
    <span class="brand-tag">docs</span>
  </div>
  <div class="header-actions">
    <input type="text" id="searchInput" class="search-input" placeholder="Search documentation... (/)" accesskey="/">
    <a href="https://github.com/botiverse/antiproton" target="_blank" rel="noopener noreferrer" class="btn-toggle">GitHub ↗</a>
    <button id="themeToggle" class="btn-toggle" title="Toggle theme">🌓 Theme</button>
  </div>
</header>

<div class="layout">
  <aside class="sidebar" id="sidebar">
    ${SECTIONS.map(sec => `
      <div class="section-group">
        <div class="section-title">${sec.category}</div>
        ${sec.docs.map(d => `
          <a href="#${d.slug}" class="nav-link" data-slug="${d.slug}">
            <span>${d.title}</span>
            ${sec.badge === "Frozen Archive" ? `<span class="badge-archive">archive</span>` : ""}
            ${sec.badge === "Internal" ? `<span class="badge-internal">internal</span>` : ""}
          </a>
        `).join("")}
      </div>
    `).join("")}
  </aside>

  <main class="content-area">
    ${renderedDocs.map(d => `
      <article class="doc-content" id="doc-${d.slug}">
        ${d.sectionId === "archive" ? `
          <div class="callout-archive">
            <strong>⚠️ Historical Planning Archive (Frozen History):</strong>
            This document represents pre-implementation planning and exploration (preserved for design rationale).
            It is <strong>not</strong> the current specification or authoritative implementation guide.
            Refer to <a href="#overview">Overview & Architecture</a> for live system invariants.
          </div>
        ` : ""}
        ${d.sectionId === "internal" ? `
          <div class="callout-internal">
            <strong>ℹ️ Internal Engineering Reference:</strong>
            This document covers internal repository maintenance, upstream sync details, or operator runbooks.
          </div>
        ` : ""}
        ${d.htmlContent}
        
        <div class="provenance-card">
          <div class="row">
            <div><strong>source:</strong> <a href="https://github.com/botiverse/antiproton/tree/${commitSha}" target="_blank" rel="noopener noreferrer">botiverse/antiproton@${commitSha.slice(0, 8)}</a></div>
            <div><strong>tree:</strong> <code>${treeSha.slice(0, 8)}</code></div>
            <div><strong>built:</strong> ${buildTime.slice(0, 19)}Z</div>
          </div>
          <div class="verify-hint">
            To independently verify this build against the upstream repository:
            <code>git rev-parse ${commitSha.slice(0, 8)}^{tree}</code> (expected: <code>${treeSha}</code>)
          </div>
        </div>
      </article>
    `).join("")}
  </main>
</div>

<script>
// Hash-based client routing
function selectDoc(slug) {
  if (!slug) slug = "overview";
  const target = document.getElementById("doc-" + slug) || document.getElementById("doc-overview");
  const actualSlug = target.id.replace("doc-", "");

  document.querySelectorAll(".doc-content").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach(el => el.classList.remove("active"));

  target.classList.add("active");
  const link = document.querySelector('.nav-link[data-slug="' + actualSlug + '"]');
  if (link) {
    link.classList.add("active");
    link.scrollIntoView({ block: "nearest" });
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", () => {
  const hash = window.location.hash.slice(1);
  if (hash.includes(":")) {
    const parts = hash.split(":");
    selectDoc(parts[0]);
    const anchor = document.getElementById(parts[1]);
    if (anchor) anchor.scrollIntoView();
  } else {
    selectDoc(hash);
  }
});

// Initial route
const initialHash = window.location.hash.slice(1);
if (initialHash) {
  if (initialHash.includes(":")) {
    const parts = initialHash.split(":");
    selectDoc(parts[0]);
    setTimeout(() => {
      const anchor = document.getElementById(parts[1]);
      if (anchor) anchor.scrollIntoView();
    }, 100);
  } else {
    selectDoc(initialHash);
  }
} else {
  selectDoc("overview");
}

// Theme toggle
const themeBtn = document.getElementById("themeToggle");
const htmlEl = document.documentElement;
const savedTheme = localStorage.getItem("docs-theme");
if (savedTheme) {
  htmlEl.className = savedTheme;
} else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
  htmlEl.className = "dark";
}

themeBtn.addEventListener("click", () => {
  const isDark = htmlEl.classList.contains("dark");
  htmlEl.className = isDark ? "light" : "dark";
  localStorage.setItem("docs-theme", htmlEl.className);
});

// Search filter
const searchInput = document.getElementById("searchInput");
searchInput.addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase().trim();
  document.querySelectorAll(".nav-link").forEach(link => {
    const text = link.textContent.toLowerCase();
    const parent = link.closest(".section-group");
    if (!q || text.includes(q)) {
      link.style.display = "flex";
    } else {
      link.style.display = "none";
    }
  });
});
</script>
</body>
</html>
`;

writeFileSync(join(OUT_DIR, "index.html"), siteHtml);
console.log(`\n  Antiproton Documentation Site built successfully in docs-site/public/`);
console.log(`  Source Commit : ${commitSha}`);
console.log(`  Source Tree   : ${treeSha}`);
console.log(`  Documents     : ${renderedDocs.length} compiled`);
console.log(`  Version Info  : docs-site/public/version.json generated`);
