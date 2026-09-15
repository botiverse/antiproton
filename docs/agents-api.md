# OpenAI Agents API Compatibility Guide

Antiproton provides an edge-native, multi-tenant implementation of the **OpenAI Agents API** (`v1`). It allows applications built with the official `openai` SDK (`client.beta.agents`) to run against Antiproton by changing only the base URL and API key.

> **Status & Target Environment:**
> - Available on the **preview deployment**: `https://preview.antiproton.ai/v1`
> - Validated against the official OpenAI SDK: `openai >= 7.15.0`
> - Production deployment (`antiproton.ai/v1`) is scheduled following preview stabilization.

---

## 1. Quick Start

### Installation

Install the official OpenAI Node.js / TypeScript SDK:

```bash
npm install openai
```

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
Issuing API keys is an administrative operation (not self-service for end-users). It requires an automation token:

```bash
curl -X POST https://preview.antiproton.ai/admin/api-keys \
  -H "Authorization: Bearer <AUTOMATION_TOKEN>" \
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
  "prefix": "ap-abc123",
  "label": "production-service-key",
  "createdAt": "2026-09-15T06:00:00Z"
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

Sessions represent ongoing stateful conversations backed by Antiproton's durable storage:

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

// List sessions for an agent
for await (const s of client.beta.agents.sessions.list({ agent_id: agent.id })) {
  console.log("Session:", s.id);
}

// Delete session and its persistent state
await client.beta.agents.sessions.delete(session.id);
```

### 3.3 Running Conversational Turns (`sessions.stream`)

In the OpenAI SDK, turns are executed via `sessions.stream`:

```typescript
const stream = client.beta.agents.sessions.stream(session.id, {
  input: "What is 17 + 25?",
});

for await (const event of stream) {
  if (event.type === "agent.session.turn.output_text.delta") {
    process.stdout.write(event.delta ?? "");
  } else if (event.type === "agent.session.turn.output_text.done") {
    console.log("
Final answer text:", event.text);
  } else if (event.type === "agent.session.turn.completed") {
    console.log("Turn completed. Turn ID:", event.turn_id);
  }
}
```

You can also start the first turn immediately when creating a session by passing `stream: true`:

```typescript
const stream = await client.beta.agents.sessions.create({
  agent_id: agent.id,
  environment: { type: "none" },
  input: "Say hello.",
  stream: true,
});

for await (const event of stream) {
  // Handle events...
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

When an agent needs to invoke client-side functions, Antiproton supports two execution paths:

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
    get_weather: async (args) => {
      console.log("Called with city:", args.city);
      return { city: args.city, forecast: "light rain", temperature_c: 13 };
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

If your application polls or manages WebSocket/SSE events manually:
1. When the model requests a function, the stream emits an `agent.session.requires_action` event.
2. Inspect `event.session.required_actions[0]`.
3. Submit the result via `events.create` with `type: "agent.session.input.tool_result"`:

```typescript
const stream = await client.beta.agents.sessions.events.stream(session.id);

// Post a message event
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
    
    // Submit tool result
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

The model resumes execution on a clean branch, ensuring the history contains only actual results without placeholder pollution.

### 3.6 Canceling an In-Flight Turn

To abort an active turn mid-execution, submit an `agent.session.input.cancel` event:

```typescript
await client.beta.agents.sessions.events.create(session.id, {
  events: [{ type: "agent.session.input.cancel" }],
});
```

Antiproton cleanly interrupts execution and records a cancellation marker in the transcript so subsequent turns know the request was canceled.

---

## 4. Supported Endpoints

| Resource | Method | Path | Description |
|---|---|---|---|
| **Agents** | `POST` | `/v1/agents` | Create an agent |
| | `GET` | `/v1/agents` | List agents (paginated by `limit` / `after`) |
| | `GET` | `/v1/agents/{id}` | Retrieve agent details |
| | `POST` | `/v1/agents/{id}` | Update agent (name, instructions, tools) |
| | `DELETE` | `/v1/agents/{id}` | Delete an agent |
| **Sessions** | `POST` | `/v1/sessions` | Create a session (supports `stream: true`) |
| | `GET` | `/v1/sessions` | List sessions (`agent_id`, `limit`, `after`) |
| | `GET` | `/v1/sessions/{id}` | Retrieve a session |
| | `POST` | `/v1/sessions/{id}` | Update session metadata |
| | `DELETE` | `/v1/sessions/{id}` | Delete a session and its persistent state |
| **Items & Turns** | `GET` | `/v1/sessions/{id}/items` | List transcript items (order `asc` / `desc`) |
| | `GET` | `/v1/sessions/{id}/turns` | List turns for a session |
| | `GET` | `/v1/sessions/{id}/turns/{turn_id}` | Retrieve details of a specific turn (includes usage) |
| **Events** | `POST` | `/v1/sessions/{id}/events` | Submit events (`input.message`, `input.tool_result`, `input.cancel`) |
| | `GET` | `/v1/sessions/{id}/events` | SSE event stream |

---

## 5. Unsupported Features & Error Behavior

Antiproton enforces strict validation. When an unsupported parameter is provided, the API returns a standard `400 Bad Request` naming the exact parameter:

| Unsupported Parameter / Event | Behavior |
|---|---|
| Non-function tools (e.g. `mcp`, `file_search`) | Returns `400 (unsupported_parameter: tools)` naming the unsupported tool type. |
| `vault_ids` | Encrypted vault attachments are not supported; returns `400 (unsupported_parameter: vault_ids)`. |
| `defer_loading` | Deferred agent tool schemas are not supported; returns `400 (unsupported_parameter: defer_loading)`. |
| `environment.packages` | Package managers on environments return `400 (unsupported_parameter: environment.packages)`. |
| Non-text input | Multimodal / binary message inputs return `400 (unsupported_parameter: content)`. |
| `environment_connection` events | Environment socket pairing events return `400 (unsupported_event_type)`. |

---

## 6. Known Behavioral Differences & Limits

1. **Model Parameter:** The `model` parameter is accepted and preserved on the agent entity. However, actual inference execution routes through the deployment's configured model provider (e.g. `deepseek-flash` on the preview cluster).
2. **Container Lease Lifecycles:** If a client tool call pauses execution for an extended period, the agent's underlying sandbox container (if mounted) may sleep to conserve compute, re-attaching when execution resumes.
3. **Discrete Tool Results:** Tool results must be submitted in separate `agent.session.input.tool_result` event payloads rather than bundled into a single batch submission.
