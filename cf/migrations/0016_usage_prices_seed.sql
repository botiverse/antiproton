-- The first prices, so the ledger can say what usage cost. Phase 1 of credits: accounting only, nothing is
-- enforced or charged against a balance.
--
-- ONE CREDIT IS ONE US DOLLAR. `credits_per_unit` (0005) is dollars per unit; every reader of cost
-- (cf/src/usage-d1.ts priceFor, the console's /ui/usage, /v1/agents/{id}/usage, /admin/usage-costs) shows
-- it as an estimated dollar amount. docs/metering.md, "Prices", says the same.
--
-- EVERY ROW HERE IS ROUGH AND TO BE REFINED LATER: each says where its number came from, and a better
-- number is a new row with a later `effective_from`, never an UPDATE of this one (0005: cost is worked out
-- when read, so a price change must not rewrite what was used).
--
-- All rows take effect at 2026-10-09T00:00:00Z (1791504000000), the day this migration was written. Usage
-- before it reads as unpriced, which is what it was.
--
-- Subset keys are priced at the DIFFERENCE (0005). For the models below that is three relations, because the
-- clients fill pi-ai's usage with the provider's own counts (src/model/pi-bridge.ts usageOf;
-- src/model/openai-compatible.ts; src/model/openai-responses.ts):
--   reasoning      ⊂ output       priced at output's rate, so its delta is 0
--   cache_write_1h ⊂ cache_write  priced at cache_write's rate, so its delta is 0
--   cache_read     ⊂ input        `input` is the WHOLE prompt (prompt_tokens / input_tokens), cache hits
--                                 included; cache_read is priced at (hit rate − miss rate), which is
--                                 negative when hits are cheaper. input×miss + cache_read×(hit − miss)
--                                 = (input − cache_read)×miss + cache_read×hit.
--   cache_write                   never written by these clients (usageOf sets it to 0). Priced "as input":
--                                 under the same whole-prompt reading a write is already inside `input`,
--                                 so its extra is 0.
-- Every subset key gets an explicit row, so no `*` can ever become its price (0005's corollary).

-- deepseek-flash, key `deepseek-flash:<kind>`: the model the queue consumer stamps on the answer
-- (cf/src/model-request.ts callQueuedModel; HARNESS_MODEL and USER_MODELS in cf/wrangler.jsonc).
-- Source: DeepSeek's official pricing page, PEAK rate (off-peak is half): input cache miss $0.30/1M,
-- cache hit $0.006/1M, output $1.20/1M. Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES
  ('model.tokens', 'deepseek-flash:input',          'tokens',  0.0000003,    1791504000000), -- $0.30/1M, cache miss. Rough, refine later.
  ('model.tokens', 'deepseek-flash:cache_read',     'tokens', -0.000000294,  1791504000000), -- $0.006/1M − $0.30/1M: cache_read ⊂ input. Rough, refine later.
  ('model.tokens', 'deepseek-flash:output',         'tokens',  0.0000012,    1791504000000), -- $1.20/1M. Rough, refine later.
  ('model.tokens', 'deepseek-flash:reasoning',      'tokens',  0,            1791504000000), -- ⊂ output, already charged there. Rough, refine later.
  ('model.tokens', 'deepseek-flash:cache_write',    'tokens',  0,            1791504000000), -- as input, already inside input. Rough, refine later.
  ('model.tokens', 'deepseek-flash:cache_write_1h', 'tokens',  0,            1791504000000); -- ⊂ cache_write. Rough, refine later.

-- GPT-5.6 Luna through the Cloudflare gateway, key `openai/gpt-5.6-luna:<kind>` (the gateway's vendor/model
-- form, USER_MODELS in cf/wrangler.jsonc). Source: third-party price aggregators after OpenAI's August 2026
-- price cut — TO VERIFY against OpenAI's own page: input $0.20/1M, output $1.20/1M. Cached input's price is
-- not known, so it is priced as input (delta 0). Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES
  ('model.tokens', 'openai/gpt-5.6-luna:input',          'tokens', 0.0000002, 1791504000000), -- $0.20/1M. To verify. Rough, refine later.
  ('model.tokens', 'openai/gpt-5.6-luna:cache_read',     'tokens', 0,         1791504000000), -- unknown, priced as input. Rough, refine later.
  ('model.tokens', 'openai/gpt-5.6-luna:output',         'tokens', 0.0000012, 1791504000000), -- $1.20/1M. To verify. Rough, refine later.
  ('model.tokens', 'openai/gpt-5.6-luna:reasoning',      'tokens', 0,         1791504000000), -- ⊂ output. Rough, refine later.
  ('model.tokens', 'openai/gpt-5.6-luna:cache_write',    'tokens', 0,         1791504000000), -- as input. Rough, refine later.
  ('model.tokens', 'openai/gpt-5.6-luna:cache_write_1h', 'tokens', 0,         1791504000000); -- ⊂ cache_write. Rough, refine later.

-- The same model prices for answers no job accepted (docs/metering.md, "Verdicts"). They are OUR cost, so they
-- are priced, and the tenant's reads leave the resource out (cf/src/usage-d1.ts readUsage, readAgentLedger);
-- only the operator's /admin/usage-costs shows them. Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from)
  SELECT 'model.tokens.unaccepted', key, unit, credits_per_unit, effective_from FROM usage_prices
  WHERE resource = 'model.tokens' AND effective_from = 1791504000000;

-- The agent's own Durable Object, while busy (`object.active`, key "", unit ms). Source: Cloudflare's
-- Durable Objects pricing, $12.50 per 1M GB-s of duration, at the 128 MB an object is billed for:
-- $12.50/1M × 0.125 GB = $0.0000015625 per second = $0.0000000015625 per ms. Requests and storage are not
-- counted by this resource. Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES
  ('object.active', '*', 'ms', 0.0000000015625, 1791504000000);

-- Container time (`sandbox.container`, key the plugin, units seconds and execs). AN ESTIMATE: run9 publishes
-- no prices; $0.00004 per second of a box existing. A command run inside it costs nothing extra. The
-- `unreadable` unit is a marker that a pass could not read the record (src/usage/container.ts), not a
-- quantity; priced 0 so it is not reported as an amount nobody priced. A box run on the tenant's own run9
-- credential has an `own:` key and is never charged (priceFor). Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES
  ('sandbox.container', '*', 'seconds',    0.00004, 1791504000000), -- estimate, no published price. Rough, refine later.
  ('sandbox.container', '*', 'execs',      0,       1791504000000), -- in the seconds. Rough, refine later.
  ('sandbox.container', '*', 'unreadable', 0,       1791504000000); -- a marker, not usage.

-- Exa search on the operator's key (the seeded `search` mount, plugin `exa`, tool `search`: key
-- `exa.search`). Source: Exa's per-search rate as quoted when this was written, $0.007 per call — not
-- checked against Exa's own page here; to verify. A failed call is priced as a call (`failed` ⊂ `calls`,
-- delta 0); its time costs nothing extra. Every other tool is left unpriced. Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES
  ('tool.call', 'exa.search', 'calls',  0.007, 1791504000000), -- $0.007 per search, to verify. Rough, refine later.
  ('tool.call', 'exa.search', 'failed', 0,     1791504000000), -- ⊂ calls. Rough, refine later.
  ('tool.call', 'exa.search', 'ms',     0,     1791504000000); -- in the call's price. Rough, refine later.
