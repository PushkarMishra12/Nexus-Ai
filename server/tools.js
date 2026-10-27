import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { appendEvent } from './recorder.js';
import { diagnoseSales } from './domain.js';

const schemas = {
  'sales.analytics': z.object({ periodDays: z.number().int().min(30).max(180).default(90) }).strict(),
  'crm.records': z.object({ status: z.enum(['Open', 'Won', 'Lost']).optional(), minAmount: z.number().nonnegative().optional() }).strict(),
  'opportunity.diagnosis': z.object({ opportunityIds: z.array(z.string()).max(100).optional() }).strict(),
  'communication.draft': z.object({ opportunityId: z.string(), tone: z.enum(['warm', 'direct', 'concise']).default('warm') }).strict(),
  'action.execute': z.object({ actionId: z.string() }).strict(),
  'verification.audit': z.object({ executionId: z.string() }).strict(),
};
const definitions = [
  { id: 'sales.analytics', name: 'Sales Analytics Tool', description: 'Summarizes sample revenue records by period.', permission: 'sales:read', kind: 'read-only', timeoutMs: 5000, maxRetries: 0, inputSchema: { type: 'object', properties: { periodDays: { type: 'integer', minimum: 30, maximum: 180, default: 90 } }, additionalProperties: false }, outputSchema: { type: 'object', required: ['source', 'records'], properties: { source: { type: 'string' }, records: { type: 'array' }, latest: { type: ['object', 'null'] }, prior: { type: ['object', 'null'] } } } },
  { id: 'crm.records', name: 'CRM Records Tool', description: 'Searches the sample opportunity register.', permission: 'crm:read', kind: 'read-only', timeoutMs: 5000, maxRetries: 0, inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['Open', 'Won', 'Lost'] }, minAmount: { type: 'number', minimum: 0 } }, additionalProperties: false }, outputSchema: { type: 'object', required: ['source', 'records'], properties: { source: { type: 'string' }, records: { type: 'array', items: { type: 'object' } } } } },
  { id: 'opportunity.diagnosis', name: 'Opportunity Diagnosis Tool', description: 'Identifies stale opportunities and supporting evidence.', permission: 'crm:read', kind: 'read-only', timeoutMs: 5000, maxRetries: 0, inputSchema: { type: 'object', properties: { opportunityIds: { type: 'array', items: { type: 'string' }, maxItems: 100 } }, additionalProperties: false }, outputSchema: { type: 'object', required: ['findings', 'stalledOpportunities'], properties: { findings: { type: 'array' }, stalledOpportunities: { type: 'array' } } } },
  { id: 'communication.draft', name: 'Communication Draft Tool', description: 'Creates a proposed follow-up message for human review.', permission: 'communications:draft', kind: 'draft', timeoutMs: 5000, maxRetries: 0, inputSchema: { type: 'object', required: ['opportunityId'], properties: { opportunityId: { type: 'string' }, tone: { type: 'string', enum: ['warm', 'direct', 'concise'], default: 'warm' } }, additionalProperties: false }, outputSchema: { type: 'object', required: ['opportunityId', 'message', 'disclaimer'], properties: { opportunityId: { type: 'string' }, message: { type: 'string' }, disclaimer: { type: 'string' } } } },
  { id: 'action.execute', name: 'Action Execution Tool', description: 'Runs only actions with a matching approved payload in the sandbox adapter.', permission: 'actions:execute', kind: 'consequential', timeoutMs: 5000, maxRetries: 0, inputSchema: { type: 'object', required: ['actionId'], properties: { actionId: { type: 'string', format: 'uuid' } }, additionalProperties: false }, outputSchema: { type: 'object', required: ['execution', 'verification'], properties: { execution: { type: 'object' }, verification: { type: 'object' } } } },
  { id: 'verification.audit', name: 'Verification and Audit Tool', description: 'Checks sandbox receipts and records verification status.', permission: 'audit:read', kind: 'verification', timeoutMs: 5000, maxRetries: 0, inputSchema: { type: 'object', required: ['executionId'], properties: { executionId: { type: 'string', format: 'uuid' } }, additionalProperties: false }, outputSchema: { type: 'object', required: ['status', 'criteria', 'evidence'], properties: { status: { type: 'string', enum: ['Verified', 'Failed', 'Inconclusive'] }, criteria: { type: 'string' }, evidence: { type: 'array' } } } },
];
export const registeredTools = definitions;

function executeReadTool(state, toolId, input) {
  if (toolId === 'sales.analytics') {
    const rows = [...state.revenue].sort((a, b) => a.month.localeCompare(b.month)); const count = Math.ceil(input.periodDays / 30);
    return { source: 'Sample sales ledger', periodDays: input.periodDays, records: rows.slice(-count), latest: rows.at(-1) ?? null, prior: rows.at(-2) ?? null, note: 'Sample data; no live finance system is connected.' };
  }
  if (toolId === 'crm.records') return { source: 'Sample CRM adapter', records: state.opportunities.filter((deal) => (!input.status || deal.status === input.status) && (!input.minAmount || deal.amount >= input.minAmount)) };
  if (toolId === 'opportunity.diagnosis') {
    const diagnosis = diagnoseSales(state); const filter = input.opportunityIds ? new Set(input.opportunityIds) : null;
    return { findings: diagnosis.findings, stalledOpportunities: diagnosis.stalled.filter((deal) => !filter || filter.has(deal.id)).map((deal) => ({ id: deal.id, account: deal.account, stage: deal.stage, amount: deal.amount, daysSinceContact: Math.floor((Date.now() - Date.parse(deal.lastContactAt)) / 86400000), source: 'Sample CRM opportunity records' })) };
  }
  if (toolId === 'communication.draft') {
    const deal = state.opportunities.find((row) => row.id === input.opportunityId);
    if (!deal) throw Object.assign(new Error('Opportunity not found'), { code: 'NOT_FOUND' });
    const greeting = input.tone === 'direct' ? `Hello ${deal.account} team,` : `Hi ${deal.account} team,`;
    return { opportunityId: deal.id, account: deal.account, message: `${greeting}\n\nI wanted to reconnect about ${deal.name}. Would a short conversation this week be useful to understand current priorities and any open questions?\n\nBest,\n${deal.owner}`, disclaimer: 'Draft only. No message has been sent.' };
  }
  throw Object.assign(new Error(`Tool ${toolId} is not available for this operation`), { code: 'TOOL_UNAVAILABLE' });
}

export function invokeReadTool(state, { taskId, toolId, input }) {
  const definition = definitions.find((item) => item.id === toolId);
  if (!definition) throw Object.assign(new Error('Tool is not registered'), { code: 'UNKNOWN_TOOL' });
  const parsed = schemas[toolId].safeParse(input); const priorCalls = state.toolInvocations.filter((item) => item.taskId === taskId).length;
  const invocation = { id: randomUUID(), taskId, toolId, status: 'Running', input: parsed.success ? parsed.data : input, startedAt: new Date().toISOString(), completedAt: null, output: null, error: null };
  state.toolInvocations.push(invocation);
  appendEvent(state, { taskId, type: 'tool.started', status: 'Running', title: `${definition.name} started`, actor: 'agent', details: { toolId, input: invocation.input, permission: definition.permission } });
  if (priorCalls >= 12) {
    invocation.status = 'Failed'; invocation.completedAt = new Date().toISOString(); invocation.error = { code: 'TOOL_CALL_LIMIT', message: 'This task reached its bounded limit of 12 tool calls.' };
    appendEvent(state, { taskId, type: 'tool.failed', status: 'Failed', title: `${definition.name} blocked by tool-call limit`, actor: 'system', details: { invocationId: invocation.id, error: invocation.error } });
    return invocation;
  }
  if (!parsed.success) {
    invocation.status = 'Failed'; invocation.completedAt = new Date().toISOString(); invocation.error = { code: 'INVALID_INPUT', message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
    appendEvent(state, { taskId, type: 'tool.failed', status: 'Failed', title: `${definition.name} rejected invalid input`, actor: 'system', details: { invocationId: invocation.id, error: invocation.error } });
    return invocation;
  }
  try {
    invocation.output = executeReadTool(state, toolId, parsed.data); invocation.status = 'Completed'; invocation.completedAt = new Date().toISOString();
    appendEvent(state, { taskId, type: 'tool.completed', status: 'Completed', title: `${definition.name} completed`, actor: 'system', details: { invocationId: invocation.id, toolId, resultSummary: `${Array.isArray(invocation.output.records) ? invocation.output.records.length : (invocation.output.stalledOpportunities?.length ?? 0)} record(s) returned`, source: invocation.output.source ?? 'sample records' } });
  } catch (error) {
    invocation.status = 'Failed'; invocation.completedAt = new Date().toISOString(); invocation.error = { code: error.code ?? 'TOOL_ERROR', message: error.message };
    appendEvent(state, { taskId, type: 'tool.failed', status: 'Failed', title: `${definition.name} failed`, actor: 'system', details: { invocationId: invocation.id, error: invocation.error } });
  }
  return invocation;
}

