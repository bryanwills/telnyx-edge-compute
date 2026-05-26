#!/bin/bash

source "$(dirname "$0")/../../demo_wrapper.sh"

start_section "📞 Voice Handoff Runtime — JavaScript" "Reference Edge validation surface for POST /v1/agent-executions"

AUTH='-H Authorization: Bearer dev-edge-key'

test_http_rich "GET" "/" "" "1️⃣ Service Metadata" \
    "GET / shows the contract paths and accepted idempotency headers" \
    "This runtime is intentionally narrow and stateful only in memory" \
    "$AUTH"

test_http_rich "POST" "/v1/agent-executions" '{"app_id":"voice-agent-prod","tenant_id":"tenant-123","execution_id":"exec_demo_1","trace_id":"trace_demo_1","deadline_ms":1500,"agent":{"entrypoint":"agents/voice/customer-lookup.ts","version":"2026-05-22"},"source":{"kind":"telnyx_voice_call","provider_event_id":"evt_demo_1","call_control_id":"v3:cc:demo","call_session_id":"v3:cs:demo","from":"+13125550100","to":"+13125550999"},"tool_input":{"lookup_customer":{"phone_number":"+13125550100"}}}' "2️⃣ Create Execution" \
    "POST /v1/agent-executions persists the correlation fields and runs lookup_customer" \
    "A successful request returns 201 with the status path" \
    "$AUTH -H Content-Type: application/json -H X-Idempotency-Key: evt_demo_1 -H X-Telnyx-Trace-Id: trace_demo_1"

test_http_rich "GET" "/v1/agent-executions/exec_demo_1" "" "3️⃣ Read Execution Status" \
    "GET /v1/agent-executions/{execution_id} returns the persisted execution record" \
    "Operators can confirm status, correlation ids, and failure state from this surface" \
    "$AUTH"

test_http_status "POST" "/v1/agent-executions" '{"app_id":"voice-agent-prod","tenant_id":"tenant-123","execution_id":"exec_demo_2","trace_id":"trace_demo_2","deadline_ms":1500,"agent":{"entrypoint":"agents/voice/customer-lookup.ts","version":"2026-05-22"},"source":{"kind":"telnyx_voice_call","provider_event_id":"evt_demo_1","call_control_id":"v3:cc:demo-dup","call_session_id":"v3:cs:demo-dup","from":"+13125550100","to":"+13125550999"},"tool_input":{"lookup_customer":{"phone_number":"+13125550100"}}}' "4️⃣ Duplicate Replay Returns 409" 409 \
    "Replay protection is keyed by provider_event_id/idempotency header" \
    "The runtime returns the original execution path instead of running side effects twice" \
    "$AUTH -H Content-Type: application/json -H X-Idempotency-Key: evt_demo_1 -H X-Telnyx-Trace-Id: trace_demo_2"

finish_tests_rich "The voice handoff runtime demonstrates a narrow validation surface for the published TEL contract. It keeps authentication, duplicate handling, tool failure, and deadline expiry explicit so TEL-18 can validate the handoff without claiming a broader production orchestration layer."
