#!/usr/bin/env node
// Makes the Ed25519 key that approval hints are signed with (docs/raft-approvals.md, "The signing key") and hands
// the private half straight to its consumer's stdin. The private key is never printed and never written to a file:
// it exists in this process's memory and in the child's stdin pipe, nowhere else. Standard output carries only what
// Raft is given, the public key and its key id, and only once the child has accepted the private key, so a failed
// store does not leave a public key behind that someone could configure.
//
//   node cf/scripts/approval-signing-key.mjs --put cf/wrangler.preview.jsonc
//       runs `npx wrangler secret put RAFT_APPROVAL_SIGNING_KEY --config <file>` with the private key on its stdin.
//   node cf/scripts/approval-signing-key.mjs --dry-run -- <command> [args...]
//       the same, piping the private key to <command> instead (what test/raft-approvals.ts runs).
//
// The child's own output goes to standard error, so standard output is exactly one line, the entry for Raft's
// {key id: public key} JSON map:
//   {"<first 16 hex characters of SHA-256 over the raw public key>":"<standard base64 of the raw 32-byte public key>"}
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";

const SECRET = "RAFT_APPROVAL_SIGNING_KEY";

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n`);
  process.stderr.write("usage: approval-signing-key.mjs --put <wrangler config> | --dry-run -- <command> [args...]\n");
  process.exit(2);
}

const args = process.argv.slice(2);
let command;
if (args[0] === "--put") {
  if (args.length !== 2 || !args[1]) usage("--put takes one wrangler config file");
  command = ["npx", "wrangler", "secret", "put", SECRET, "--config", args[1]];
} else if (args[0] === "--dry-run") {
  const rest = args[1] === "--" ? args.slice(2) : args.slice(1);
  if (!rest.length) usage("--dry-run needs a command to pipe the private key to");
  command = rest;
} else usage();

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
// The fields in a fixed order and nothing else: cf/src/approvals.ts `importSigningKey` reads exactly these.
const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
const raw = Buffer.from(jwk.x, "base64url");
if (raw.length !== 32) { process.stderr.write("unexpected public key length\n"); process.exit(1); }
const keyId = createHash("sha256").update(raw).digest("hex").slice(0, 16);

// stdout of the child is sent to our stderr: wrangler's chatter must not mix with the two lines Raft is given.
const child = spawn(command[0], command.slice(1), { stdio: ["pipe", process.stderr, "inherit"] });
child.on("error", (e) => {
  process.stderr.write(`could not run ${command[0]}: ${e.message}; nothing was stored\n`);
  process.exit(1);
});
child.stdin.on("error", () => {}); // a child that exits without reading: its exit code says so below
child.stdin.end(secret);
child.on("close", (code, signal) => {
  if (code !== 0) {
    process.stderr.write(`${command.join(" ")} ended with ${signal ?? `exit ${code}`}; the key was not stored, and this public key is void\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ [keyId]: raw.toString("base64") })}\n`);
});
