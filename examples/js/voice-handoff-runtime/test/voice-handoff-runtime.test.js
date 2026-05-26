'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../index.js');

function buildContext(overrides = {}) {
  return {
    method: overrides.method || 'GET',
    path: overrides.path || '/',
    headers: overrides.headers || {},
    query: overrides.query || {},
    rawBody: Buffer.from(overrides.rawBody || ''),
    log: overrides.log || {
      info() {},
      warn() {},
      error() {},
    },
  };
}

function sampleRequest(overrides = {}) {
  const request = {
    app_id: 'voice-agent-prod',
    tenant_id: 'tenant-123',
    execution_id: 'exec_01HZY3JQ1T7V6A6M4A9V5T7Q2E',
    trace_id: 'trace_01HZY3JQ1V7TPKEMM9P83W4A0F',
    deadline_ms: 1500,
    agent: {
      entrypoint: 'agents/voice/customer-lookup.ts',
      version: '2026-05-22',
    },
    source: {
      kind: 'telnyx_voice_call',
      provider_event_id: 'evt_01HZY3JQ1Y3PYD3R4N0VYQ9Q8S',
      call_control_id: 'v3:cc:9a2eec89-5f36-4928-bf55-b0a32e4ce734',
      call_session_id: 'v3:cs:08f25048-a631-4e67-b9f8-20c0dca2dd38',
      from: '+13125550100',
      to: '+13125550999',
    },
    tool_input: {
      lookup_customer: {
        phone_number: '+13125550100',
      },
    },
  };

  return { ...request, ...overrides, source: { ...request.source, ...(overrides.source || {}) }, tool_input: overrides.tool_input || request.tool_input };
}

function authHeaders(providerEventId = 'evt_01HZY3JQ1Y3PYD3R4N0VYQ9Q8S', traceId = 'trace_01HZY3JQ1V7TPKEMM9P83W4A0F') {
  return {
    authorization: 'Bearer test-edge-key',
    'x-idempotency-key': providerEventId,
    'x-telnyx-trace-id': traceId,
  };
}

test.beforeEach(() => {
  process.env.EDGE_API_KEY = 'test-edge-key';
  delete process.env.LOOKUP_CUSTOMER_FAIL_NUMBERS;
  process.env.LOOKUP_CUSTOMER_DELAY_MS = '0';
  delete process.env.CUSTOMER_FIXTURE_JSON;
  runtime.__test.initFromEnv();
  runtime.__test.resetState();
});

test('creates and reads an execution record', async () => {
  const request = sampleRequest();
  const create = await runtime.handle(
    buildContext({
      method: 'POST',
      path: '/v1/agent-executions',
      headers: authHeaders(request.source.provider_event_id, request.trace_id),
    }),
    request,
  );

  assert.equal(create.statusCode, 201);
  assert.equal(create.body.execution_id, request.execution_id);
  assert.equal(create.body.status_path, `/v1/agent-executions/${request.execution_id}`);

  const read = await runtime.handle(
    buildContext({
      method: 'GET',
      path: `/v1/agent-executions/${request.execution_id}`,
      headers: { authorization: 'Bearer test-edge-key' },
    }),
  );

  assert.equal(read.statusCode, 200);
  assert.equal(read.body.status, 'succeeded');
  assert.equal(read.body.provider_event_id, request.source.provider_event_id);
  assert.equal(read.body.result.lookup_customer.customer.customer_id, 'cust_001');
});

test('returns 409 for duplicate provider event replay', async () => {
  const request = sampleRequest();
  const context = buildContext({
    method: 'POST',
    path: '/v1/agent-executions',
    headers: authHeaders(request.source.provider_event_id, request.trace_id),
  });

  const first = await runtime.handle(context, request);
  assert.equal(first.statusCode, 201);

  const duplicate = await runtime.handle(
    buildContext({
      method: 'POST',
      path: '/v1/agent-executions',
      headers: authHeaders(request.source.provider_event_id, 'trace_duplicate'),
    }),
    sampleRequest({
      execution_id: 'exec_duplicate',
      trace_id: 'trace_duplicate',
    }),
  );

  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.execution_id, request.execution_id);
});

test('returns 424 when lookup_customer fails', async () => {
  process.env.LOOKUP_CUSTOMER_FAIL_NUMBERS = '+13125550100';
  runtime.__test.initFromEnv();
  runtime.__test.resetState();

  const request = sampleRequest();
  const response = await runtime.handle(
    buildContext({
      method: 'POST',
      path: '/v1/agent-executions',
      headers: authHeaders(request.source.provider_event_id, request.trace_id),
    }),
    request,
  );

  assert.equal(response.statusCode, 424);

  const stored = runtime.__test.getExecution(`/v1/agent-executions/${request.execution_id}`);
  assert.equal(stored.status, 'tool_failed');
  assert.equal(stored.failure.code, 'lookup_customer_failed');
});

test('returns 504 when deadline_ms is lower than the configured lookup delay', async () => {
  process.env.LOOKUP_CUSTOMER_DELAY_MS = '50';
  runtime.__test.initFromEnv();
  runtime.__test.resetState();

  const request = sampleRequest({ deadline_ms: 10 });
  const response = await runtime.handle(
    buildContext({
      method: 'POST',
      path: '/v1/agent-executions',
      headers: authHeaders(request.source.provider_event_id, request.trace_id),
    }),
    request,
  );

  assert.equal(response.statusCode, 504);

  const stored = runtime.__test.getExecution(`/v1/agent-executions/${request.execution_id}`);
  assert.equal(stored.status, 'deadline_exceeded');
});

test('requires bearer auth', async () => {
  const response = await runtime.handle(
    buildContext({
      method: 'POST',
      path: '/v1/agent-executions',
      headers: {
        'x-idempotency-key': 'evt_missing_auth',
      },
    }),
    sampleRequest({
      execution_id: 'exec_missing_auth',
      trace_id: 'trace_missing_auth',
      source: {
        provider_event_id: 'evt_missing_auth',
      },
    }),
  );

  assert.equal(response.statusCode, 401);
});
