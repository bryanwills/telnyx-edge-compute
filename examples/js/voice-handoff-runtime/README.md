# Voice Handoff Runtime (JavaScript)

Reference Edge validation surface for the TEL voice-path handoff contract.

This example exposes the two contract paths documented in `team-telnyx/ai`:

- `POST /v1/agent-executions`
- `GET /v1/agent-executions/{execution_id}`

It is intentionally narrow. The runtime keeps execution state in memory, runs only the allowlisted `lookup_customer` tool, and makes failure states explicit instead of hiding them behind retries or buffering.

The example directory is self-contained for deployment: `new-func --from-dir=examples/js/voice-handoff-runtime` carries its own `Dockerfile` and `app.js`, so the shipped artifact does not depend on files from `examples/js/`.

## Contract notes

- Bearer auth is required for both POST and GET. Configure `EDGE_API_KEY` before using the runtime.
- The current `team-telnyx/ai` contract references both `idempotency-key` and `X-Idempotency-Key`. This example accepts either header, but persists the canonical `provider_event_id` binding and returns `409` on replay.
- `X-Telnyx-Trace-Id` is recorded when present and falls back to the request body `trace_id`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service metadata and supported contract headers |
| `GET` | `/health` | Unauthenticated health probe |
| `POST` | `/v1/agent-executions` | Create and execute a voice handoff request |
| `GET` | `/v1/agent-executions/{execution_id}` | Read persisted execution status |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EDGE_API_KEY` | *(unset)* | Required bearer token for contract requests |
| `LOOKUP_CUSTOMER_DELAY_MS` | `25` | Simulated lookup latency used for deadline tests |
| `LOOKUP_CUSTOMER_FAIL_NUMBERS` | *(unset)* | CSV list of phone numbers that force `424` |
| `CUSTOMER_FIXTURE_JSON` | *(unset)* | Optional JSON map of phone number to customer fixture |
| `SERVICE_NAME` | `voice-handoff-runtime` | Service name returned by `GET /` |
| `VERSION` | `1.0.0` | Version returned by `GET /` |

## Run locally

```bash
cd examples/js/voice-handoff-runtime
EDGE_API_KEY=dev-edge-key npm start
```

## Deploy to Edge

The example directory is self-contained for `telnyx-edge ship`, so shipping from
`examples/js/voice-handoff-runtime` does not depend on copying `app.js` in from
the parent `examples/js` directory first.

```bash
cd examples/js/voice-handoff-runtime
telnyx-edge ship
```

## Minimal probe

```bash
curl -X POST "http://localhost:8080/v1/agent-executions" \
  -H "Authorization: Bearer dev-edge-key" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: evt_01HZY3JQ1Y3PYD3R4N0VYQ9Q8S" \
  -H "X-Telnyx-Trace-Id: trace_01HZY3JQ1V7TPKEMM9P83W4A0F" \
  -d '{
    "app_id": "voice-agent-prod",
    "tenant_id": "tenant-123",
    "execution_id": "exec_01HZY3JQ1T7V6A6M4A9V5T7Q2E",
    "trace_id": "trace_01HZY3JQ1V7TPKEMM9P83W4A0F",
    "deadline_ms": 1500,
    "agent": {
      "entrypoint": "agents/voice/customer-lookup.ts",
      "version": "2026-05-22"
    },
    "source": {
      "kind": "telnyx_voice_call",
      "provider_event_id": "evt_01HZY3JQ1Y3PYD3R4N0VYQ9Q8S",
      "call_control_id": "v3:cc:9a2eec89-5f36-4928-bf55-b0a32e4ce734",
      "call_session_id": "v3:cs:08f25048-a631-4e67-b9f8-20c0dca2dd38",
      "from": "+13125550100",
      "to": "+13125550999"
    },
    "tool_input": {
      "lookup_customer": {
        "phone_number": "+13125550100"
      }
    }
  }'
```

Then inspect the persisted state:

```bash
curl -H "Authorization: Bearer dev-edge-key" \
  "http://localhost:8080/v1/agent-executions/exec_01HZY3JQ1T7V6A6M4A9V5T7Q2E"
```

## Failure visibility

- Missing bearer token: `401`
- Invalid bearer token: `403`
- Duplicate provider event replay: `409`
- `lookup_customer` failure: `424`
- Deadline exceeded before tool result: `504`
