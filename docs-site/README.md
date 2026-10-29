# Antiproton Documentation Site

This directory houses the static documentation site for Antiproton, served at `docs.antiproton.ai`.

## Architecture & Isolation

Following the design established in `report/`, `docs-site/` is published as a dedicated, unprivileged static assets Cloudflare Worker:
- **Zero Bindings**: No KV, D1, Queues, or Durable Objects.
- **Zero Secrets**: No runtime credentials or environment variables.
- **Isolated Bundle**: Never widens the core runtime Worker (`cf/`) bundle or security surface.
- **Strict Provenance**: Every build explicitly embeds the current git commit SHA, build timestamp, and document categorization metadata in `version.json` and on-page footers.

## Building & Deploying

To build the static site from the repository markdown files in `docs/` and `README.md`:

```bash
npm run docs:build
```

To deploy with pinned SHA verification:

```bash
bash scripts/deploy-docs.sh
```
