import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityScore, INTEREST_WEIGHTS, diagnoseSales, dashboardMetrics } from '../server/domain.js';
import { appendEvent, verifyEventChain, hashAction } from '../server/recorder.js';
import { invokeReadTool } from '../server/tools.js';
import { aiFriendSchema, localFriendReply } from '../server/ai-friends.js';

const sample = {
  revenue: [{ month: '2026-08', amount: 120 }, { month: '2026-09', amount: 90 }],
  opportunities: [
    { id: 'a', account: 'A', status: 'Open', amount: 80000, lastContactAt: new Date(Date.now() - 30 * 86400000).toISOString(), stage: 'Proposal' },
    { id: 'b', account: 'B', status: 'Won', amount: 50000, lastContactAt: new Date().toISOString(), stage: 'Closed Won' },
  ], tasks: [], actions: [], approvals: [], executions: [], verifications: [], toolInvocations: [], events: [],
};

test('compatibility scores use the specified weights and normalize shared fields', () => {
  assert.equal(Object.values(INTEREST_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const result = compatibilityScore({ interests: ['AI'], goals: ['Build'], socialStyle: 'Small groups', availability: 'Weekends', languages: ['English'], location: 'Remote' }, { interests: ['AI'], goals: ['Build'], socialStyle: 'Small groups', availability: 'Weekends', languages: ['English'], location: 'Remote' });
  assert.equal(result.score, 100);
  const partial = compatibilityScore({ interests: ['AI'] }, { interests: ['AI'], goals: ['Learn'] });
  assert.equal(partial.score, 58);
  assert.match(partial.limitation, /estimate/);
});

test('sales diagnosis distinguishes observed trends from causation', () => {
  const result = diagnoseSales(sample);
  assert.ok(result.revenueChangePct < 0);
  assert.equal(result.stalled.length, 1);
  assert.equal(result.highValueStalled[0].id, 'a');
  assert.equal(result.findings.at(-1).type, 'limitation');
  assert.match(result.findings.at(-1).evidence, /does not establish/i);
});

test('dashboard calculations only report comparisons when both windows exist', () => {
  const short = dashboardMetrics(sample, 90);
  assert.equal(short.previousRevenue, null);
  assert.equal(short.revenue, 210);
  const larger = dashboardMetrics({ ...sample, revenue: [{ month: '2026-07', amount: 100 }, { month: '2026-08', amount: 100 }, { month: '2026-09', amount: 100 }, { month: '2026-10', amount: 80 }, { month: '2026-11', amount: 70 }, { month: '2026-12', amount: 60 }] }, 90);
  assert.equal(larger.previousRevenue, 300);
  assert.equal(larger.revenue, 210);
});

test('flight recorder hashes detect a changed payload', () => {
  const state = { events: [] };
  appendEvent(state, { taskId: 't1', type: 'task.created', status: 'Running', title: 'Created', actor: 'user', details: { objective: 'Review the pipeline' } });
  appendEvent(state, { taskId: 't1', type: 'stage.completed', status: 'Completed', title: 'Evidence collected', actor: 'agent', details: { count: 3 } });
  assert.equal(verifyEventChain(state.events).valid, true);
  state.events[0].details.objective = 'Changed';
  assert.equal(verifyEventChain(state.events).valid, false);
});

test('registered tools validate inputs and log every call', () => {
  const state = { revenue: sample.revenue, opportunities: sample.opportunities, toolInvocations: [], events: [] };
  const invalid = invokeReadTool(state, { taskId: 't', toolId: 'sales.analytics', input: { periodDays: 999, query: 'DROP TABLE' } });
  assert.equal(invalid.status, 'Failed');
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  const valid = invokeReadTool(state, { taskId: 't', toolId: 'sales.analytics', input: { periodDays: 30 } });
  assert.equal(valid.status, 'Completed');
  assert.equal(state.toolInvocations.length, 2);
  assert.equal(state.events.length, 4);
});

test('approval action hash binds material parameters', () => {
  const action = { type: 'send_email', targetId: 'opp-a', params: { to: 'a@example.test', message: 'Hello' }, verificationCriteria: 'A receipt exists' };
  const original = hashAction(action);
  assert.equal(hashAction({ ...action }), original);
  assert.notEqual(hashAction({ ...action, params: { ...action.params, message: 'Changed' } }), original);
});


test('AI friend local replies reflect the requested need and reply style', () => {
  const friend = aiFriendSchema.parse({ name: 'Study Buddy', need: 'Help me build a steady coding study habit and break goals into small steps.', tone: 'encouraging' });
  const reply = localFriendReply(friend, 'I keep putting off my practice sessions.');
  assert.match(reply, /coding study habit/i);
  assert.match(reply, /small win/i);
  assert.throws(() => aiFriendSchema.parse({ name: 'A', need: 'Help me', tone: 'warm' }));
});
