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

You can connect either via environment variables or explicit SDK initialization arguments.

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

All requests to `/v1/*` must carry an `Authorization: Bearer ap-...` header.

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

Create, retrieve, update, list, and delete agents using the standard `beta.agents` interface:

```typescript
// Create an agent
const agent = await client.beta.agents.create({
  name: "support-analyst",
  instructions: "You are a tier-2 technical support analyst. Always be precise and concise.",
  model: "deepseek-flash", // Stored for metadata; active inference uses the deployment model
});

console.log("Agent created:", agent.id);

// Retrieve agent
const retrieved = await client.beta.agents.retrieve(agent.id);

// List agents
const agentsList = await client.beta.agents.list({ limit: 20 });
```

### 3.2 Running Sessions & Message Turns

A session represents an ongoing stateful conversation backed by Antiproton's durable storage:

```typescript
// Create a session
const session = await client.beta.agents.sessions.create({
  agent_id: agent.id,
});

// Run a turn by posting a user message
const turn = await client.beta.agents.sessions.turns.create(session.id, {
  messages: [
    { role: "user", content: "Check the status of cluster eu-west-1." }
  ],
});

console.log("Turn status:", turn.status); // "completed", "in_progress", or "requires_action"
```

### 3.3 Streaming via Server-Sent Events (SSE)

Antiproton supports live event streaming. Compute is maintained efficiently: the edge Worker holds the client connection while polling the underlying Durable Object, preventing idle streaming connections from billing the stateful object.

```typescript
const stream = await client.beta.agents.sessions.stream(session.id, {
  messages: [{ role: "user", content: "Summarize the recent deploy incidents." }],
});

for await (const event of stream) {
  if (event.type === "turn.created") {
    console.log("Turn started:", event.data.id);
  } else if (event.type === "message.delta") {
    process.stdout.write(event.data.delta.content?.[0]?.text ?? "");
  } else if (event.type === "turn.completed") {
    console.log("
Turn finished.");
  }
}
```

### 3.4 Client Function Tools (`requires_action` & `input.tool_result`)

When an agent needs to execute functions provided by your client application, Antiproton supports two execution paths:
1. **Synchronous Tool Handlers (`toolHandlers`):** Provided directly via the SDK.
2. **Explicit Turn Suspension (`requires_action`):** The server pauses the turn, returns the tool call parameters, and resumes execution once you post the tool result.

#### Example with SDK `toolHandlers`

```typescript
const agent = await client.beta.agents.create({
  name: "weather-bot",
  instructions: "Answer weather questions using get_weather.",
  model: "deepseek-flash",
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Fetch current weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" }
          },
          required: ["city"]
        }
      }
    }
  ]
});

// The SDK handles requires_action automatically when handlers are provided
const result = await client.beta.agents.sessions.turns.create(session.id, {
  messages: [{ role: "user", content: "What is the weather in Bergen?" }],
  toolHandlers: {
    async get_weather({ city }) {
      return JSON.stringify({ temp: 9, condition: "heavy rain" });
    }
  }
});

console.log(result.messages[0].content);
```

#### Example with Manual `requires_action` Workflow

If you handle polling and function execution manually:
1. When the turn requires a client function, `turn.status` transitions to `requires_action`.
2. Inspect `turn.required_action.submit_tool_outputs.tool_calls`.
3. Submit the result via `input.tool_result`:

```typescript
// Submit the tool output back to the session
await client.beta.agents.sessions.events.create(session.id, {
  type: "input.tool_result",
  tool_call_id: toolCall.id,
  output: JSON.stringify({ status: "active", nodes: 12 }),
});
```

The model resumes execution on a clean branch, ensuring the transcript only records real results without intermediate placeholders.

### 3.5 Canceling a Turn

You can cancel an in-flight turn using `input.cancel`. Antiproton aborts the background execution loop cleanly and records an explicit cancellation entry in the transcript so subsequent turns know the request was canceled:

```typescript
await client.beta.agents.sessions.events.create(session.id, {
  type: "input.cancel",
});
```

---

## 4. Supported Endpoints

| Resource | Method | Path | Description |
|---|---|---|---|
| **Agents** | `POST` | `/v1/agents` | Create a new agent definition |
| | `GET` | `/v1/agents` | List agents (paginated by `limit` / `after`) |
| | `GET` | `/v1/agents/{id}` | Retrieve agent details |
| | `POST` | `/v1/agents/{id}` | Update agent (name, instructions, tools) |
| | `DELETE` | `/v1/agents/{id}` | Delete an agent |
| **Sessions** | `POST` | `/v1/sessions` | Create a session (supports `stream: true`) |
| | `GET` | `/v1/sessions` | List sessions |
| | `GET` | `/v1/sessions/{id}` | Retrieve a session |
| | `POST` | `/v1/sessions/{id}` | Update session metadata |
| | `DELETE` | `/v1/sessions/{id}` | Delete a session and its persistent state |
| **Turns** | `POST` | `/v1/sessions/{id}/turns` | Run a conversational turn (or resume with tools) |
| | `GET` | `/v1/sessions/{id}/turns` | List turns for a session |
| | `GET` | `/v1/sessions/{id}/turns/{turn_id}` | Retrieve details of a specific turn |
| **Items & Events** | `GET` | `/v1/sessions/{id}/items` | List transcript items (messages, tool calls, results) |
| | `POST` | `/v1/sessions/{id}/events` | Submit events (`input.message`, `input.tool_result`, `input.cancel`) |
| | `GET` | `/v1/sessions/{id}/events` | SSE event stream |

---

## 5. Unsupported Features & Error Behavior

Antiproton implements strict validation. When an unsupported parameter is provided, the API returns a standard `400 Bad Request` naming the exact parameter:

| Unsupported Field | Reason / Behavior |
|---|---|
| `tools` (non-function types) | Only `type: "function"` is supported. Tools of type `mcp`, `file_search`, or `code_interpreter` return a `400` naming the tool type. |
| `vault_ids` | Encrypted vault attachments are not supported; returns `400 (unsupported_parameter: vault_ids)`. |
| `defer_loading` | Deferred agent tool schemas are not supported; returns `400 (unsupported_parameter: defer_loading)`. |
| Non-text input | Image/audio/multimodal message inputs return `400 (unsupported_parameter: content)`. |
| `environment_connection` events | Environment socket pairing events return `400 (unsupported_event_type)`. |

---

## 6. Known Behavioral Differences & Limits

1. **Model Parameter:** The `model` parameter is accepted and stored on the agent entity. However, actual inference execution routes through the deployment's configured provider (e.g. `deepseek-flash` on the preview cluster).
2. **Container Lease Lifecycles:** If a client tool call pauses execution for an extended period, the agent's underlying sandbox container (if mounted) may sleep to conserve compute, re-attaching when execution resumes.
3. **Discrete Tool Results:** Tool results must be submitted in separate `input.tool_result` event payloads rather than bundled into a single batch submission.
