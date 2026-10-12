-- Claude Haiku 5.5's prices, key `claude-haiku-5-5:<kind>`: the model the queue consumer stamps on the answer when an
-- agent is bound to it (USER_MODELS in cf/wrangler.jsonc, provider `cloudflare-anthropic`, Anthropic's own bare name).
--
-- Source: Anthropic's pricing page, https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-12, the tier
-- for prompts of at most 100,000 tokens: input $0.10/1M, 5-minute cache write $0.125/1M, 1-hour cache write $0.20/1M,
-- cache hit $0.01/1M, output $0.50/1M. Called through Cloudflare AI Gateway, which bills it; priced here at
-- Anthropic's own rate, as 0017 prices Luna at OpenAI's.
--
-- Under 0016's reading every subset is priced at its difference from the kind it is inside. This client fills all of
-- them (src/model/anthropic-messages.ts `readMessage`): `input` is the WHOLE prompt (Anthropic's input_tokens plus the
-- cache writes and reads), and both cache kinds are inside it.
--   cache_read     ⊂ input        $0.01/1M − $0.10/1M  = −$0.09/1M
--   cache_write    ⊂ input        $0.125/1M − $0.10/1M = +$0.025/1M (the 5-minute write; 0016 priced cache_write as
--                                 input for models whose clients never wrote it; this one does)
--   cache_write_1h ⊂ cache_write  0: never asked for (every breakpoint is the 5-minute one, src/model/pi-bridge.ts
--                                 `CACHE_BREAKPOINT`) and never written (pi-bridge's `usageOf` sets no 1-hour count)
--   reasoning      ⊂ output       0
--
-- Not priced here, and why: a prompt over 100,000 tokens is billed at another tier for the whole call ($0.50 input,
-- $2.50 output, writes and hits in proportion), and a ledger key cannot say how long a call's prompt was, so every call
-- is priced at the lower tier. The soft window keeps calls in it: pi085 does not send a call once the conversation's
-- last call measured 90,000 input tokens (src/runtime/rebuild.ts `DEFAULT_SOFT_WINDOW_POLICY`). A call over it (a
-- conversation that starts over it, or pd, which has no soft window) reads cheaper here than it was.
--
-- A new key, so no earlier row is replaced. It takes effect at 2026-10-13T00:00:00Z (1791849600000), a UTC midnight
-- after this was written, so an hourly and a daily bucket of the same day read the same price; usage before it reads as
-- unpriced. Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES
  ('model.tokens', 'claude-haiku-5-5:input',          'tokens',  0.0000001,    1791849600000), -- $0.10/1M.
  ('model.tokens', 'claude-haiku-5-5:cache_read',     'tokens', -0.00000009,   1791849600000), -- $0.01/1M − $0.10/1M: cache_read ⊂ input.
  ('model.tokens', 'claude-haiku-5-5:cache_write',    'tokens',  0.000000025,  1791849600000), -- $0.125/1M − $0.10/1M: cache_write ⊂ input.
  ('model.tokens', 'claude-haiku-5-5:cache_write_1h', 'tokens',  0,            1791849600000), -- ⊂ cache_write, never written.
  ('model.tokens', 'claude-haiku-5-5:output',         'tokens',  0.0000005,    1791849600000), -- $0.50/1M.
  ('model.tokens', 'claude-haiku-5-5:reasoning',      'tokens',  0,            1791849600000); -- ⊂ output.

-- The same prices for answers no job accepted (0016: our cost, read only by the operator's /admin/usage-costs).
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from)
  SELECT 'model.tokens.unaccepted', key, unit, credits_per_unit, effective_from FROM usage_prices
  WHERE resource = 'model.tokens' AND key LIKE 'claude-haiku-5-5:%' AND effective_from = 1791849600000;
