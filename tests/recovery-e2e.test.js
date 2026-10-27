import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

process.env.NODE_ENV = 'production';
process.env.PORT = '0';
process.env.DEMO_MODE = 'true';
const dataFile = path.join(process.cwd(), 'data', 'nexusai-e2e-state.json');
process.env.DATA_FILE = dataFile;
const { start } = await import('../server/index.js');
const instance = await start();
const base = `http://127.0.0.1:${instance.server.address().port}`;
let cookie = '';
const api = async (url, options = {}) => {
  const headers = { ...(cookie ? { cookie } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) };
  const response = await fetch(`${base}${url}`, { headers, ...options });
  const contentType = response.headers.get('content-type') ?? '';
  return { response, data: contentType.includes('application/json') ? await response.json() : await response.text() };
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function waitForReview(taskId) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const { response, data } = await api(`/api/tasks/${taskId}`);
    assert.equal(response.status, 200);
    if (data.task.status === 'Awaiting Approval') return data;
    if (['Failed', 'Cancelled'].includes(data.task.status)) throw new Error(`Task ended early: ${data.task.status}`);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error('Timed out waiting for the agent to reach human review.');
}
async function createDemoTask(demoScenario = true) {
  const { response, data } = await api('/api/tasks', json('POST', { objective: 'Investigate the sample revenue decline and propose safe recovery actions.', periodDays: 90, demoScenario }));
  assert.equal(response.status, 202); return waitForReview(data.taskId);
}

test('authenticated recovery demo persists evidence, approvals, executions, verification, and trace events', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => instance.server.close(resolve)); await instance.store.close(); await rm(dataFile, { force: true });
  });
  const unauth = await api('/api/dashboard'); assert.equal(unauth.response.status, 401);
  const badLogin = await api('/api/login', json('POST', { email: 'demo@nexusai.local', password: 'wrong-password' })); assert.equal(badLogin.response.status, 401);
  const login = await api('/api/login', json('POST', { email: 'demo@nexusai.local', password: 'NexusDemo!27' }));
  assert.equal(login.response.status, 200); cookie = login.response.headers.get('set-cookie').split(';')[0]; assert.equal(login.data.user.role, 'admin');
  const seed = await instance.store.read(); assert.notEqual(seed.users[0].passwordHash, 'NexusDemo!27'); assert.match(seed.users[0].passwordHash, /^scrypt\$/);
  const dashboard = await api('/api/dashboard?days=90'); assert.equal(dashboard.response.status, 200); assert.equal(dashboard.data.sample, true); assert.ok(dashboard.data.metrics.revenue > 0);

  const friendCreated = await api('/api/ai-friends', json('POST', { name: 'Study Buddy', need: 'Help me build a steady coding study habit and break goals into small steps.', personality: 'Patient and practical', tone: 'encouraging', boundaries: 'Keep advice supportive and manageable.' }));
  assert.equal(friendCreated.response.status, 201); const aiFriendId = friendCreated.data.friend.id;
  const friendReply = await api('/api/ai-friends/' + aiFriendId + '/messages', json('POST', { content: 'I keep putting off my practice sessions.' }));
  assert.equal(friendReply.response.status, 200); assert.equal(friendReply.data.reply.role, 'assistant'); assert.equal(friendReply.data.provider, 'local-fallback'); assert.match(friendReply.data.reply.content, /study habit/i);
  const friendHistory = await api('/api/ai-friends/' + aiFriendId + '/messages'); assert.equal(friendHistory.data.messages.length, 2);

  const trace = await createDemoTask(true); const taskId = trace.task.id;
  const demoCookie = cookie;
  const registration = await api('/api/register', json('POST', { name: 'Privacy Check', email: 'privacy-check@example.test', password: 'SecureTestPass!27' }));
  assert.equal(registration.response.status, 201); cookie = registration.response.headers.get('set-cookie').split(';')[0];
  const hidden = await api(`/api/tasks/${taskId}`); assert.equal(hidden.response.status, 404, 'another account cannot inspect this task');
  const hiddenFriend = await api('/api/ai-friends/' + aiFriendId + '/messages'); assert.equal(hiddenFriend.response.status, 404, 'another account cannot inspect this AI friend chat');
  await api('/api/logout', json('POST', {})); cookie = demoCookie;
  assert.equal(trace.stages.filter((stage) => stage.status === 'Completed').length, 10);
  assert.ok(trace.tools.some((call) => call.toolId === 'sales.analytics' && call.status === 'Completed'));
  assert.ok(trace.evidence.some((item) => item.source === 'Sample CRM adapter'));
  assert.ok(trace.actions.length >= 3);
  const emailAction = trace.actions.find((action) => action.type === 'send_email');
  const crmAction = trace.actions.find((action) => action.type === 'update_crm');
  const calendarAction = trace.actions.find((action) => action.type === 'schedule_call');
  const emailApproval = trace.approvals.find((approval) => approval.actionId === emailAction.id);
  const crmApproval = trace.approvals.find((approval) => approval.actionId === crmAction.id);
  const calendarApproval = trace.approvals.find((approval) => approval.actionId === calendarAction.id);

  const reject = await api(`/api/approvals/${calendarApproval.id}/decision`, json('POST', { decision: 'reject', rationale: 'Do not schedule from a demo record.' })); assert.equal(reject.response.status, 200);
  const blocked = await api(`/api/actions/${calendarAction.id}/execute`, json('POST', {})); assert.equal(blocked.response.status, 409); assert.match(blocked.data.error, /Rejected approval prevents execution/);
  assert.equal((await instance.store.read()).executions.some((execution) => execution.actionId === calendarAction.id), false);

  const approveEmail = await api(`/api/approvals/${emailApproval.id}/decision`, json('POST', { decision: 'approve', rationale: 'Reviewed exact message and target.' })); assert.equal(approveEmail.response.status, 200);
  const execution = await api(`/api/actions/${emailAction.id}/execute`, json('POST', {})); assert.equal(execution.response.status, 200); assert.equal(execution.data.verification.status, 'Verified');
  const duplicate = await api(`/api/actions/${emailAction.id}/execute`, json('POST', {})); assert.equal(duplicate.response.status, 409);
  await api(`/api/approvals/${crmApproval.id}/decision`, json('POST', { decision: 'approve' }));
  const inconclusive = await api(`/api/actions/${crmAction.id}/execute`, json('POST', {})); assert.equal(inconclusive.response.status, 200); assert.equal(inconclusive.data.execution.status, 'Executed'); assert.equal(inconclusive.data.verification.status, 'Inconclusive');
  const approveCalendar = await api(`/api/approvals/${calendarApproval.id}/decision`, json('POST', { decision: 'approve' })); assert.equal(approveCalendar.response.status, 409, 'a rejected request cannot be approved later');

  const second = await createDemoTask(true); const secondEmail = second.actions.find((action) => action.type === 'send_email'); const secondApproval = second.approvals.find((approval) => approval.actionId === secondEmail.id);
  await api(`/api/approvals/${secondApproval.id}/decision`, json('POST', { decision: 'approve' }));
  await instance.store.mutate((state) => { state.actions.find((action) => action.id === secondEmail.id).params.message += '\nChanged after approval.'; });
  const changed = await api(`/api/actions/${secondEmail.id}/execute`, json('POST', {})); assert.equal(changed.response.status, 409); assert.match(changed.data.error, /parameters changed/);
  const secondCalendar = second.actions.find((action) => action.type === 'schedule_call'); const secondCalendarApproval = second.approvals.find((approval) => approval.actionId === secondCalendar.id);
  await api(`/api/approvals/${secondCalendarApproval.id}/decision`, json('POST', { decision: 'approve' }));
  const failedExecution = await api(`/api/actions/${secondCalendar.id}/execute`, json('POST', {})); assert.equal(failedExecution.response.status, 200); assert.equal(failedExecution.data.execution.status, 'Failed'); assert.equal(failedExecution.data.verification.status, 'Inconclusive');

  const recorder = await api(`/api/flight-recorder/${taskId}`); assert.equal(recorder.response.status, 200); assert.equal(recorder.data.chainIntegrity.valid, true); assert.ok(recorder.data.events.some((event) => event.type === 'approval.reject')); assert.ok(recorder.data.events.some((event) => event.status === 'Verified')); assert.ok(recorder.data.events.some((event) => event.status === 'Inconclusive'));
  const report = await api(`/api/flight-recorder/${taskId}/export?format=report`); assert.equal(report.response.status, 200); assert.match(report.data, /do not independently prove/i);

  const state = await instance.store.read(); const errorInvocation = state.toolInvocations.find((call) => call.taskId === second.task.id && call.toolId === 'action.execute' && call.status === 'Failed');
  assert.ok(errorInvocation, 'the guided demo records a failed registered-tool invocation');
  const recovery = state.actions.find((action) => action.parentActionId === secondCalendar.id); assert.ok(recovery); assert.equal(state.approvals.find((item) => item.actionId === recovery.id).status, 'Awaiting Approval');
  const recoveryApproval = state.approvals.find((item) => item.actionId === recovery.id);
  await api(`/api/approvals/${recoveryApproval.id}/decision`, json('POST', { decision: 'approve' }));
  const recovered = await api(`/api/actions/${recovery.id}/execute`, json('POST', {})); assert.equal(recovered.response.status, 200); assert.equal(recovered.data.verification.status, 'Verified'); assert.match(recovered.data.execution.response.message, /No email was sent/);
  const settled = await api(`/api/tasks/${taskId}`); assert.equal(settled.data.task.status, 'Inconclusive');

  const pausedTaskStart = await api('/api/tasks', json('POST', { objective: 'Review stalled sales opportunities and revenue changes.', periodDays: 90, demoScenario: false }));
  const pausedId = pausedTaskStart.data.taskId; const paused = await api(`/api/tasks/${pausedId}/pause`, json('POST', {})); assert.equal(paused.data.task.status, 'Paused');
  await new Promise((resolve) => setTimeout(resolve, 350)); const stillPaused = await api(`/api/tasks/${pausedId}`); assert.equal(stillPaused.data.task.status, 'Paused');
  const resumed = await api(`/api/tasks/${pausedId}/resume`, json('POST', {})); assert.equal(resumed.data.task.status, 'Running');
  await waitForReview(pausedId);

  const createStore = (await import('../server/store.js')).createStore;
  const newStore = await createStore(); const persisted = await newStore.read();
  assert.ok(persisted.tasks.some((task) => task.id === taskId)); assert.ok(persisted.events.some((event) => event.taskId === taskId)); await newStore.close();
});



