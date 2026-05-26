'use strict';

const EXECUTION_COLLECTION_PATH = '/v1/agent-executions';
const DEFAULT_CUSTOMERS = Object.freeze({
  '+13125550100': {
    customer_id: 'cust_001',
    segment: 'gold',
    locale: 'en-US',
  },
});

let configuredApiKey = '';
let lookupDelayMs = 25;
let failLookupNumbers = new Set();
let customerFixtures = { ...DEFAULT_CUSTOMERS };

const executionsById = new Map();
const executionsByProviderEventId = new Map();

function parseCsvSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function loadCustomerFixtures() {
  if (!process.env.CUSTOMER_FIXTURE_JSON) return { ...DEFAULT_CUSTOMERS };
  try {
    const parsed = JSON.parse(process.env.CUSTOMER_FIXTURE_JSON);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.warn('Invalid CUSTOMER_FIXTURE_JSON, falling back to defaults', error);
  }
  return { ...DEFAULT_CUSTOMERS };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resetState() {
  executionsById.clear();
  executionsByProviderEventId.clear();
}

function initFromEnv() {
  configuredApiKey = process.env.EDGE_API_KEY || '';
  lookupDelayMs = Number.parseInt(process.env.LOOKUP_CUSTOMER_DELAY_MS || '25', 10);
  if (!Number.isFinite(lookupDelayMs) || lookupDelayMs < 0) lookupDelayMs = 25;
  failLookupNumbers = parseCsvSet(process.env.LOOKUP_CUSTOMER_FAIL_NUMBERS);
  customerFixtures = loadCustomerFixtures();
}

function buildExecutionPath(executionId) {
  return `${EXECUTION_COLLECTION_PATH}/${encodeURIComponent(executionId)}`;
}

function parseBearerToken(headers) {
  const header = headers.authorization || headers.Authorization || '';
  const [scheme, token] = String(header).split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

function authenticate(headers) {
  if (!configuredApiKey) {
    return { ok: false, statusCode: 503, body: { error: 'EDGE_API_KEY not configured' } };
  }

  const token = parseBearerToken(headers);
  if (!token) {
    return { ok: false, statusCode: 401, body: { error: 'Missing bearer token' } };
  }

  if (token !== configuredApiKey) {
    return { ok: false, statusCode: 403, body: { error: 'Invalid bearer token' } };
  }

  return { ok: true };
}

function getHeader(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

function validateExecutionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Expected a JSON object body';
  }

  const candidate = body;
  const requiredTopLevel = ['app_id', 'tenant_id', 'execution_id', 'trace_id', 'deadline_ms', 'agent', 'source', 'tool_input'];
  for (const field of requiredTopLevel) {
    if (!(field in candidate)) return `Missing required field: ${field}`;
  }

  if (!candidate.agent || typeof candidate.agent !== 'object') return 'agent must be an object';
  if (!candidate.source || typeof candidate.source !== 'object') return 'source must be an object';
  if (!candidate.tool_input || typeof candidate.tool_input !== 'object') return 'tool_input must be an object';
  if (!candidate.tool_input.lookup_customer || typeof candidate.tool_input.lookup_customer !== 'object') {
    return 'tool_input.lookup_customer must be an object';
  }
  if (candidate.source.kind !== 'telnyx_voice_call') return 'source.kind must be telnyx_voice_call';
  if (typeof candidate.tool_input.lookup_customer.phone_number !== 'string' || candidate.tool_input.lookup_customer.phone_number.length === 0) {
    return 'tool_input.lookup_customer.phone_number must be a non-empty string';
  }
  if (!Number.isFinite(candidate.deadline_ms) || candidate.deadline_ms <= 0) {
    return 'deadline_ms must be a positive number';
  }

  return null;
}

function createExecutionRecord(request, traceId, idempotencyKey) {
  const now = new Date().toISOString();
  return {
    execution_id: request.execution_id,
    trace_id: traceId,
    tenant_id: request.tenant_id,
    provider_event_id: request.source.provider_event_id,
    call_control_id: request.source.call_control_id,
    call_session_id: request.source.call_session_id,
    status: 'pending',
    tool: 'lookup_customer',
    created_at: now,
    updated_at: now,
    deadline_ms: request.deadline_ms,
    idempotency_key: idempotencyKey,
    agent: clone(request.agent),
    source: clone(request.source),
    request: clone(request),
    result: null,
    failure: null,
  };
}

function updateExecution(record, patch) {
  Object.assign(record, patch, { updated_at: new Date().toISOString() });
  executionsById.set(record.execution_id, record);
  executionsByProviderEventId.set(record.provider_event_id, record.execution_id);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLookupCustomer(record) {
  const phoneNumber = record.request.tool_input.lookup_customer.phone_number;
  if (lookupDelayMs > 0) {
    await delay(lookupDelayMs);
  }

  if (failLookupNumbers.has(phoneNumber)) {
    const error = new Error(`lookup_customer failed for ${phoneNumber}`);
    error.code = 'lookup_customer_failed';
    throw error;
  }

  return clone(customerFixtures[phoneNumber] || {
    customer_id: 'cust_unknown',
    segment: 'unknown',
    locale: 'en-US',
  });
}

async function createExecution(context, body) {
  const validationError = validateExecutionRequest(body);
  if (validationError) {
    return { statusCode: 422, body: { error: validationError } };
  }

  const traceIdHeader = getHeader(context.headers, 'x-telnyx-trace-id');
  const idempotencyKey = getHeader(context.headers, 'idempotency-key') || getHeader(context.headers, 'x-idempotency-key');
  const traceId = traceIdHeader || body.trace_id;

  if (!idempotencyKey) {
    return { statusCode: 422, body: { error: 'Missing idempotency key header' } };
  }

  if (body.source.provider_event_id !== idempotencyKey) {
    return {
      statusCode: 422,
      body: {
        error: 'provider_event_id must match idempotency key',
        provider_event_id: body.source.provider_event_id,
        idempotency_key: idempotencyKey,
      },
    };
  }

  const existingExecutionId = executionsByProviderEventId.get(body.source.provider_event_id);
  if (existingExecutionId) {
    const existingRecord = executionsById.get(existingExecutionId);
    return {
      statusCode: 409,
      body: {
        error: 'Duplicate provider event id',
        execution_id: existingExecutionId,
        status_path: buildExecutionPath(existingExecutionId),
        status: existingRecord?.status,
      },
    };
  }

  const record = createExecutionRecord(body, traceId, idempotencyKey);
  updateExecution(record, {});

  context.log.info('Accepted agent execution', {
    execution_id: record.execution_id,
    trace_id: record.trace_id,
    tenant_id: record.tenant_id,
    provider_event_id: record.provider_event_id,
    call_control_id: record.call_control_id,
  });

  if (lookupDelayMs > record.deadline_ms) {
    updateExecution(record, {
      status: 'deadline_exceeded',
      failure: {
        code: 'deadline_exceeded',
        message: `lookup_customer exceeded deadline_ms=${record.deadline_ms}`,
      },
    });
    context.log.warn('Execution exceeded deadline before tool result', {
      execution_id: record.execution_id,
      trace_id: record.trace_id,
      deadline_ms: record.deadline_ms,
      lookup_delay_ms: lookupDelayMs,
    });
    return {
      statusCode: 504,
      body: {
        error: 'Deadline exceeded',
        execution_id: record.execution_id,
        status_path: buildExecutionPath(record.execution_id),
      },
    };
  }

  try {
    const customer = await runLookupCustomer(record);
    updateExecution(record, {
      status: 'succeeded',
      result: {
        lookup_customer: {
          phone_number: body.tool_input.lookup_customer.phone_number,
          customer,
        },
      },
    });
    return {
      statusCode: 201,
      headers: {
        Location: buildExecutionPath(record.execution_id),
      },
      body: {
        execution_id: record.execution_id,
        status: record.status,
        status_path: buildExecutionPath(record.execution_id),
        trace_id: record.trace_id,
      },
    };
  } catch (error) {
    updateExecution(record, {
      status: 'tool_failed',
      failure: {
        code: error.code || 'lookup_customer_failed',
        message: error.message,
      },
    });
    context.log.warn('lookup_customer failed', {
      execution_id: record.execution_id,
      trace_id: record.trace_id,
      provider_event_id: record.provider_event_id,
      error: error.message,
    });
    return {
      statusCode: 424,
      body: {
        error: 'lookup_customer failed',
        execution_id: record.execution_id,
        status_path: buildExecutionPath(record.execution_id),
      },
    };
  }
}

function getExecution(path) {
  const prefix = `${EXECUTION_COLLECTION_PATH}/`;
  if (!path.startsWith(prefix)) return null;
  const executionId = decodeURIComponent(path.slice(prefix.length));
  if (!executionId) return null;
  return executionsById.get(executionId) || null;
}

module.exports = {
  init() {
    initFromEnv();
    resetState();
    if (configuredApiKey) {
      console.log('Bearer auth: enabled');
    } else {
      console.log('Bearer auth: disabled until EDGE_API_KEY is configured');
    }
  },

  handle: async (context, body) => {
    const path = context.path || '/';
    const auth = authenticate(context.headers || {});

    if (path === '/health' && context.method === 'GET') {
      return { statusCode: 200, body: { status: 'ok', service: 'voice-handoff-runtime' } };
    }

    if (!auth.ok) return { statusCode: auth.statusCode, body: auth.body };

    if (context.method === 'POST' && path === EXECUTION_COLLECTION_PATH) {
      return createExecution(context, body);
    }

    if (context.method === 'GET' && path.startsWith(`${EXECUTION_COLLECTION_PATH}/`)) {
      const record = getExecution(path);
      if (!record) {
        return { statusCode: 404, body: { error: 'Execution not found' } };
      }
      return { statusCode: 200, body: clone(record) };
    }

    if (context.method === 'GET' && path === '/') {
      return {
        statusCode: 200,
        body: {
          service: process.env.SERVICE_NAME || 'voice-handoff-runtime',
          version: process.env.VERSION || '1.0.0',
          post_path: EXECUTION_COLLECTION_PATH,
          status_path: `${EXECUTION_COLLECTION_PATH}/{execution_id}`,
          execution_count: executionsById.size,
          accepts_idempotency_headers: ['idempotency-key', 'x-idempotency-key'],
        },
      };
    }

    return { statusCode: 404, body: { error: 'Route not found', path, method: context.method } };
  },

  shutdown() {
    console.log(`Voice handoff runtime shutting down — tracked ${executionsById.size} executions`);
  },

  __test: {
    initFromEnv,
    resetState,
    getExecution,
  },
};
