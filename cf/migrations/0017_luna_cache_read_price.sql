-- GPT-5.6 Luna's cached-input price, which 0016 did not know and priced as input (cache_read delta 0).
--
-- Source: OpenAI's pricing page, https://developers.openai.com/api/docs/pricing (platform.openai.com/docs/pricing
-- redirects there), read 2026-10-11, Standard tier, short context (≤272K input tokens): gpt-5.6-luna input
-- $0.20/1M, cached input $0.02/1M, cache writes $0.25/1M, output $1.20/1M. That confirms 0016's input and output
-- rows, so they are not repeated here. The ledger's key (`openai/gpt-5.6-luna`) is this model called through
-- Cloudflare AI Gateway's OpenAI-compatible endpoint; it is priced here at OpenAI's own rate.
--
-- cache_read ⊂ input (0016's header), so it is priced at the difference: $0.02/1M − $0.20/1M = −$0.18/1M.
--
-- Not priced here, and why:
--   long context (>272K input tokens) has a higher price on that page; the ledger's keys do not say a call's
--     prompt length, so every call is priced at the short-context rate.
--   cache writes ($0.25/1M) stay at 0016's delta 0: these clients never write cache_write (usageOf sets it to 0).
--
-- A new row with a later `effective_from`, never an UPDATE of 0016's (0005: cost is worked out when read, so a
-- price change must not rewrite what was used). It takes effect at 2026-10-12T00:00:00Z (1791763200000), a UTC
-- midnight so an hourly and a daily bucket of the same day read the same price. Usage from 2026-10-09 to then
-- keeps 0016's price (cached tokens at the input rate). Rough, refine later.
INSERT OR IGNORE INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES
  ('model.tokens',            'openai/gpt-5.6-luna:cache_read', 'tokens', -0.00000018, 1791763200000), -- $0.02/1M − $0.20/1M: cache_read ⊂ input.
  ('model.tokens.unaccepted', 'openai/gpt-5.6-luna:cache_read', 'tokens', -0.00000018, 1791763200000); -- the same, for answers no job accepted.
