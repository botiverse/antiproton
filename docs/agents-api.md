# OpenAI Agents API Compatibility Guide

Antiproton provides an edge-native, multi-tenant implementation of the **OpenAI Agents API** (`v1`). It allows applications built with the official `openai` SDK (`client.beta.agents`) to run against Antiproton by changing only the base URL and API key.

> **Status & Target Environment:**
> - Available on the **preview deployment**: `https://preview.antiproton.ai/v1`
> - Validated against the official OpenAI SDK: `openai 7.15.0` (pinned in `qa/sdk/package.json`)
> - The agents API lives on a separate branch and runs strictly in the preview environment.

---

## 1. Quick Start

### Installation & SDK Version Requirement

Install the official OpenAI Node.js / TypeScript SDK, pinned strictly to version **7.15.0**:

```bash
npm install openai@7.15.0
```

> ⚠️ **Important Versioning & Module Resolution Caveats:**
> - **SDK Version Must Be >= 7.15.0 (Tested on 7.15.0):** Older versions (such as `openai` 6.x) do not include `client.beta.agents`. Attempting to call `client.beta.agents.create()` on older versions will fail client-side with `TypeError: Cannot read properties of undefined (reading 'create')`.
> - **Node.js ESM Symlink Resolution:** Node.js resolves ESM imports using the real filesystem path of the executing script (`realpath`), walking up to find `node_modules`. If your project or repository root has an older version of `openai` installed (e.g. 6.40.0), a script executing across symlinks may inadvertently resolve the older `openai` package. Always ensure the resolved package directory carries `openai@7.15.0`.

### Configuration

You can connect either via environment variables or explicit SDK initialization options.

#### Option A: Environment Variables (Recommended)

Set the endpoint and API key in your environment:

```bash
export OPENAI_BASE_URL="https://preview.antiproton.ai/v1"
export OPENAI_API_KEY="ap-..."
```

Initialize the client with zero arguments:

```typescript
import { OpenAI } from "openai";

// Automatically picks up OPENAI_BASE_URL and OPENAI_API_KEY
const client = new OpenAI();
```

#### Option B: Explicit Client Options

```typescript
import { OpenAI } from "openai";

const client = new OpenAI({
  baseURL: "https://preview.antiproton.ai/v1",
  apiKey: "ap-...",
});
```

---

## 2. Authentication & API Key Provisioning

All requests to `/v1/*` require an `Authorization: Bearer ap-...` header.

### Key Characteristics
- **Prefix:** Keys are prefixed with `ap-` (e.g., `ap-7f9a...`).
- **Storage:** Only the SHA-256 hash of the key is stored in the database. Plaintext tokens are returned **only once** upon generation.
- **Scoping:** Each API key is bound to a specific `(tenantId, ownerAgentId)`. All agents, sessions, and data created by that key live strictly within that tenant's physical boundary.

### Operator Key Issuance
Issuing API keys is an administrative operation (not self-service for end-users). It requires an automation token passed in the `x-harness-token` header:

```bash
curl -X POST https://preview.antiproton.ai/admin/api-keys \
  -H "x-harness-token: <AUTOMATION_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "org_enterprise",
    "ownerAgentId": "agent_primary",
    "label": "production-service-key"
  }'
```

Response:
```json
{
  "key": "ap-abc123xyz...",
  "tenantId": "org_enterprise",
  "ownerAgentId": "agent_primary",
  "label": "production-service-key"
}
```

---

## 3. Core Capabilities & Workflows

### 3.1 Managing Agents

Create, retrieve, update, list, and delete agents using `client.beta.agents`:

```typescript
// Create an agent
const agent = await client.beta.agents.create({
  name: "support-analyst",
  instructions: "You are a tier-2 technical support analyst. Always be precise and concise.",
  model: "gpt-6-astra", // Stored for metadata; actual inference uses the deployment's configured model
});

console.log("Agent created:", agent.id);

// Retrieve agent
const retrieved = await client.beta.agents.retrieve(agent.id);

// Update agent
await client.beta.agents.update(agent.id, {
  instructions: "Be brief.",
});

// List agents (supports auto-pagination)
for await (const a of client.beta.agents.list({ limit: 20 })) {
  console.log("Found agent:", a.id, a.name);
}

// Delete agent
await client.beta.agents.delete(agent.id);
```

### 3.2 Managing Sessions

Sessions represent ongoing stateful conversations backed by Antiproton's durable storage. Note that `environment` is required upon session creation:
- `environment: { type: "none" }`
- `environment: { type: "openai_hosted" }` (spawns a sandbox container; configuring custom packages/files/network is refused by parameter name)
- `self_hosted` is refused.

```typescript
// Create a session
const session = await client.beta.agents.sessions.create({
  agent_id: agent.id,
  environment: { type: "none" },
});

console.log("Session created:", session.id, session.status); // "idle"

// Retrieve session
const retrievedSession = await client.beta.agents.sessions.retrieve(session.id);

// Update session metadata
await client.beta.agents.sessions.update(session.id, {
  metadata: { project: "customer-support" },
});

// List sessions for an agent (default order is "desc")
for await (const s of client.beta.agents.sessions.list({ agent_id: agent.id, order: "asc" })) {
  console.log("Session:", s.id);
}

// Delete session and its persistent state
await client.beta.agents.sessions.delete(session.id);
```

### 3.3 Running Conversational Turns (`sessions.stream`)

In the OpenAI SDK, turns are initiated when input arrives. There is no `turns.create` endpoint. You run a turn via `sessions.stream`:

```typescript
const stream = client.beta.agents.sessions.stream(session.id, {
  input: "What is 17 + 25?",
});

for await (const event of stream) {
  if (event.type === "agent.session.turn.created") {
    console.log("Turn started:", event.turn_id);
  } else if (event.type === "agent.session.turn.output_text.delta") {
    process.stdout.write(event.delta ?? "");
  } else if (event.type === "agent.session.turn.output_text.done") {
    console.log("
Full output:", event.text);
  } else if (event.type === "agent.session.turn.completed") {
    console.log("Turn completed. Usage:", event.usage);
  }
}
```

You can also start the first turn immediately when creating a session by setting `stream: true`:

```typescript
const stream = await client.beta.agents.sessions.create({
  agent_id: agent.id,
  environment: { type: "none" },
  input: "Say hello.",
  stream: true,
});

for await (const event of stream) {
  // Handle stream events...
}
```

### 3.4 Inspecting History (Items & Turns)

Antiproton translates session history from its internal pi transcript into standard items and turns:

```typescript
// List transcript items (messages, function calls, outputs)
for await (const item of client.beta.agents.sessions.items.list(session.id, { order: "asc" })) {
  console.log(item.type, item.role, item.phase);
}

// List turns
for await (const turn of client.beta.agents.sessions.turns.list(session.id)) {
  console.log("Turn:", turn.id, turn.status);
}

// Retrieve details of a specific turn (including token usage)
const turn = await client.beta.agents.sessions.turns.retrieve(turnId, {
  session_id: session.id,
});
console.log("Usage:", turn.usage?.input_tokens, turn.usage?.output_tokens);
```

### 3.5 Client Function Tools

Tools are defined with a flat structure (`type: "function"`, with `name`, `description`, and `parameters` directly on the object; nested `function: { ... }` wrappers are refused).

When an agent invokes client-side functions, Antiproton supports two execution paths:

#### Path A: SDK Automatic Function Handling (`toolHandlers`)

The official SDK automatically handles tool invocations when `toolHandlers` are provided to `sessions.stream`:

```typescript
const agent = await client.beta.agents.create({
  name: "weather-agent",
  instructions: "For weather questions always call get_weather, then answer using its result.",
  model: "gpt-6-astra",
  tools: [
    {
      type: "function",
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  ],
});

const stream = client.beta.agents.sessions.stream(session.id, {
  input: "What's the weather in Oslo right now?",
  toolHandlers: {
    get_weather: async ({ city }) => {
      console.log("Fetching weather for:", city);
      return { city, forecast: "light rain", temperature_c: 13 };
    },
  },
});

for await (const event of stream) {
  if (event.type === "agent.session.turn.output_text.done") {
    console.log("Answer:", event.text);
  }
}
```

#### Path B: Explicit Turn Suspension (`requires_action` & `input.tool_result`)

If your application manages events manually via SSE streams:
1. When the model requests a function call, the session status becomes `requires_action`, and the stream emits an `agent.session.requires_action` event carrying `session.required_actions`.
2. Inspect `action.call_id`, `action.turn_id`, `action.name`, and `action.arguments`.
3. Submit the result via `events.create` with `type: "agent.session.input.tool_result"`:

```typescript
const stream = await client.beta.agents.sessions.events.stream(session.id);

// Post an initial user message
await client.beta.agents.sessions.events.create(session.id, {
  events: [
    {
      type: "agent.session.input.message",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "What's the weather in Bergen?" }],
        },
      ],
    },
  ],
});

for await (const event of stream) {
  if (event.type === "agent.session.requires_action") {
    const action = event.session.required_actions[0];
    
    // Submit tool result back to the session
    await client.beta.agents.sessions.events.create(session.id, {
      events: [
        {
          type: "agent.session.input.tool_result",
          turn_id: action.turn_id,
          call_id: action.call_id,
          success: true,
          output: JSON.stringify({ city: "Bergen", forecast: "heavy rain", temperature_c: 9 }),
        },
      ],
    });
  } else if (event.type === "agent.session.turn.completed") {
    console.log("Turn finished.");
    break;
  }
}
```

To report a tool error, send `success: false, error: "error description"`. Note that timing determines whether the turn pauses for the caller (`requires_action`) or resumes immediately if results arrive before the tool call turn executes.

### 3.6 Canceling an In-Flight Turn

To abort an active turn mid-execution, submit an `agent.session.input.cancel` event:

```typescript
await client.beta.agents.sessions.events.create(session.id, {
  events: [{ type: "agent.session.input.cancel" }],
});
```

Canceling an idle session is accepted as a no-op. If a turn is active, Antiproton interrupts background execution and records a cancellation marker in the transcript so subsequent turns know the request was canceled.

---

## 4. Supported Endpoints

| Resource | Method | Path | Description |
|---|---|---|---|
| **Agents** | `POST` | `/v1/agents` | Create an agent |
| | `GET` | `/v1/agents` | List agents (paginated by `limit`, `after`, `order`) |
| | `GET` | `/v1/agents/{id}` | Retrieve agent details |
| | `POST` | `/v1/agents/{id}` | Update agent (name, instructions, tools) |
| | `DELETE` | `/v1/agents/{id}` | Delete an agent |
| **Sessions** | `POST` | `/v1/agents/sessions` | Create a session (supports `stream: true`) |
| | `GET` | `/v1/agents/sessions` | List sessions (`agent_id`, `limit`, `after`, `order`) |
| | `GET` | `/v1/agents/sessions/{id}` | Retrieve a session |
| | `POST` | `/v1/agents/sessions/{id}` | Update session metadata |
| | `DELETE` | `/v1/agents/sessions/{id}` | Delete a session and its persistent state |
| **Items & Turns** | `GET` | `/v1/agents/sessions/{id}/items` | List transcript items (order `asc` / `desc`) |
| | `GET` | `/v1/agents/sessions/{id}/turns` | List turns for a session |
| | `GET` | `/v1/agents/sessions/{id}/turns/{turn_id}` | Retrieve details of a specific turn (includes usage) |
| **Events** | `POST` | `/v1/agents/sessions/{id}/events` | Submit input events (`agent.session.input.*`) |
| | `GET` | `/v1/agents/sessions/{id}/events` | Open SSE event stream |

---

## 5. Unsupported Features & Error Behavior

### API Surface Scope: `client.beta.agents` Only
Antiproton's `/v1` endpoint is purpose-built to implement the **OpenAI Agents API (`client.beta.agents`)**. It does **not** provide general OpenAI endpoints:
- `POST /v1/chat/completions` returns `404 Not Found` with `code: "not_found"` (*"is not supported by this deployment"*).
- `POST /v1/responses`, `/v1/embeddings`, `/v1/audio/*`, and other standard endpoints are not supported.

Client applications must target the `beta.agents` interface rather than attempting to route generic completion traffic to this endpoint.

### Parameter Validation Refusals
When an unsupported parameter or event is provided to a supported Agents API route, the API returns a standard `400 Bad Request` with `code: "unsupported_parameter"` (or `invalid_value`), naming the exact field in `param`:

| Unsupported Parameter / Event | `param` |
|---|---|
| Non-function tools (e.g. `mcp`) | `tools[i].type` |
| `defer_loading: true` | `tools[i].defer_loading` |
| `vault_ids` | `vault_ids` |
| Configuring `openai_hosted` environment (packages, files, network, …) | `environment.<field>` |
| `self_hosted` environment | `environment.type` |
| Non-text message content parts | `input[i].content[j].type` |
| Unsupported event types (e.g. `agent.session.input.environment_connection`) | `events[i].type` |

---

## 6. Known Behavioral Differences & Limits

1. **Model Parameter:** The `model` parameter is accepted and preserved on the agent entity. However, actual inference execution routes through the preview deployment's configured model provider (`deepseek-flash`).
2. **Container Lease Lifecycles:** While a turn waits for a caller's client function result, the agent's underlying sandbox container **may be handed back**, and anything in the container filesystem not persisted with `keep` is lost.
3. **Event Batching Rules:** Several `tool_result` events may be submitted in a single request. However, `tool_result` events cannot be mixed with `input.message` or `input.cancel` in the same request. Furthermore, every result must name a valid `call_id` emitted by the model during that turn; unknown `call_id`s return a 400 error and discard the request.
