# Agents API QA with the official OpenAI SDK

Manually triggered, not part of any merge or deploy. Run it when a change touches
the agents API (task #17) or when you want to know how it behaves today.

```sh
qa/sdk/run.sh              # contract tier: no model needed
qa/sdk/run.sh model        # real-model tier
qa/sdk/run.sh all
QA_ONLY=cancel qa/sdk/run.sh all   # only scenarios whose name contains "cancel"
QA_REPEAT=5 QA_ONLY=cancel qa/sdk/run.sh model   # each 5 times: model behaviour is not the same every run
```

- **Target:** the preview deployment (`https://preview.antiproton.ai/v1`) by default. `docs/agents-api.md`
  says `/v1` is live on production too, so the same suite runs there with `QA_BASE`:
  `QA_BASE=https://antiproton.ai qa/sdk/run.sh contract`. The operator token follows the target
  (`PREVIEW_AUTOMATION_TOKEN`, `AUTOMATION_TOKEN`), and any other address is refused unless
  `QA_BASE_ALLOW=1`. The model tier is not offered on production: it would put a model credential on
  the deployment users reach, so a production Worker without one is a refusal, not a step.
- **Client:** `new OpenAI()` with no arguments. The address and key come only from
  `OPENAI_BASE_URL` / `OPENAI_API_KEY`, which is itself the "change only the address" check.
- **Key:** each run issues its own API key (owner `u-qa-sdk`) and deletes the agents and sessions it creates.
- **Model tiers:** `run.sh` puts `DEEPSEEK_API_KEY` from `~/.secrets/antiproton.env` on the
  `antiproton-preview` Worker for the run and deletes it on exit, and only when the Worker had none. The key
  is never printed or stored elsewhere. Model scenarios spend real DeepSeek tokens.
- **Record:** each run writes a JSON record and a self-contained HTML report to `qa/sdk/out/` (target, build,
  SDK version, each scenario's result, note or error, and time). It is not a published benchmark run, so it does
  not go in `report/runs/`. To combine several runs into one report:
  `node qa/sdk/report.mjs qa/sdk/out/a.json qa/sdk/out/b.json -o report.html`

## Writing a scenario

Add an object to the exported array in `scenarios/contract.mjs` or `scenarios/model.mjs`, or add a new
file there:

```js
export default [{
  name: "what it proves, in one line",
  tier: "contract" | "model",
  async run({ client, OpenAI, assert, TERMINAL, tag, cleanup }) {
    // create what you use, register cleanup(() => ...), throw (or assert) to fail,
    // and return a short note for the record
  },
}];
```

`contract` scenarios must hold with or without a model behind the deployment (a turn may end
completed or failed). `model` scenarios may assume a real model.
