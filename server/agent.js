import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendEvent, hashAction } from './recorder.js';
import { diagnoseSales } from './domain.js';
import { invokeReadTool } from './tools.js';
import { structuredAnalysis } from './llm.js';

export const stageNames = [
  'Receive and validate objective', 'Create task and define outcome', 'Inspect context, permissions, and tools', 'Plan the investigation',
  'Select registered tools', 'Collect read-only sales evidence', 'Validate returned records', 'Diagnose supported patterns',
  'Build prioritized recovery actions', 'Request human approval', 'Execute approved actions and verify', 'Record result and next step',
];
const delay = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (state, taskId, type, status, title, actor, details = {}) => appendEvent(state, { taskId, type, status, title, actor: typeof actor === 'string' ? actor : (actor?.name ?? 'system'), details });
const messageTemplate = (deal) => `Hi ${deal.account} team,\n\nI wanted to reconnect about ${deal.name}. Would a short conversation this week be useful to understand current priorities and any open questions?\n\nBest,\n${deal.owner}`;

export async function createTask(store, user, objective, { periodDays = 90, demoScenario = true } = {}) {
  const taskId = randomUUID(); const now = new Date().toISOString();
  await store.mutate((state) => {
    const task = { id: taskId, userId: user.id, objective, periodDays, demoScenario, status: 'Running', createdAt: now, updatedAt: now, provider: process.env.AI_API_URL ? 'configured-llm' : 'rules-engine', result: null };
    state.tasks.unshift(task);
    state.stages.push(...stageNames.map((name, index) => ({ id: randomUUID(), taskId, number: index + 1, name, status: 'Pending', details: {}, startedAt: null, completedAt: null })));
    emit(state, taskId, 'task.created', 'Running', 'Investigation task created', user.name, { objective, desiredOutcome: 'Identify evidence-backed, approval-gated sales recovery actions.' });
  });
  void runInvestigation(store, taskId).catch((error) => failTask(store, taskId, error));
  return taskId;
}
async function setStage(store, taskId, number, status, details = {}) {
  await store.mutate((state) => {
    const task = state.tasks.find((item) => item.id === taskId); if (!task || task.status === 'Cancelled') return;
    const stage = state.stages.find((item) => item.taskId === taskId && item.number === number); if (!stage) return;
    stage.status = status; stage.details = { ...stage.details, ...details };
    if (status === 'Running') stage.startedAt = new Date().toISOString();
    if (['Completed', 'Failed', 'Cancelled'].includes(status)) stage.completedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString(); emit(state, taskId, `stage.${status.toLowerCase()}`, status, `${number}. ${stage.name}`, 'agent', details);
  });
}
async function canContinue(store, taskId) {
  while (true) {
    const task = (await store.read()).tasks.find((item) => item.id === taskId);
    if (!task || task.status === 'Cancelled') return false;
    if (task.status !== 'Paused') return true;
    await delay(200);
  }
}
async function runInvestigation(store, taskId) {
  const stage = async (number, details, work) => {
    if (!await canContinue(store, taskId)) return false;
    await setStage(store, taskId, number, 'Running', details); await delay();
    if (!await canContinue(store, taskId)) return false;
    if (work) await work();
    await setStage(store, taskId, number, 'Completed', details);
    return await canContinue(store, taskId);
  };
  const initial = await store.read(); const task0 = initial.tasks.find((item) => item.id === taskId); if (!task0) return;
  const user = initial.users.find((item) => item.id === task0.userId);
  if (!await stage(1, { objectiveValidated: true, objective: task0.objective.slice(0, 180) })) return;
  if (!await stage(2, { taskId, desiredOutcome: 'Evidence-backed diagnosis and prioritized actions' })) return;
  if (!await stage(3, { toolsAvailable: 6, permissions: ['sales:read', 'crm:read', 'communications:draft'], source: 'sample dataset' })) return;
  if (!await stage(4, { plan: ['Compare sample revenue periods', 'Review open opportunity contact history', 'Separate observed facts from hypotheses'] })) return;
  if (!await stage(5, { selectedTools: ['sales.analytics', 'crm.records', 'opportunity.diagnosis', 'communication.draft'] })) return;
  let calls;
  if (!await stage(6, { mode: 'read-only', source: 'Sample sales ledger and sample CRM adapter' }, async () => {
    await store.mutate((state) => {
      const activeTask = state.tasks.find((item) => item.id === taskId);
      calls = {
        analytics: invokeReadTool(state, { taskId, toolId: 'sales.analytics', input: { periodDays: activeTask.periodDays } }),
        records: invokeReadTool(state, { taskId, toolId: 'crm.records', input: { status: 'Open', minAmount: 0 } }),
        diagnosis: invokeReadTool(state, { taskId, toolId: 'opportunity.diagnosis', input: {} }),
      };
    });
  })) return;
  if (!calls?.analytics || calls.analytics.status !== 'Completed' || calls.records.status !== 'Completed' || calls.diagnosis.status !== 'Completed') throw new Error('Read-only sales evidence could not be validated');
  if (!await stage(7, { validation: 'Tool outputs were checked against registered schemas', allCallsSuccessful: true })) return;
  const current = await store.read(); const diagnosis = diagnoseSales(current);
  let llmResult;
  try {
    llmResult = await structuredAnalysis({ diagnosis: diagnosis.findings, revenue: current.revenue, opportunities: current.opportunities.map(({ id, account, stage, amount, status, lastContactAt }) => ({ id, account, stage, amount, status, lastContactAt })) });
  } catch (error) {
    llmResult = { provider: 'rules-engine', analysis: null, note: 'Configured provider unavailable; deterministic rules remain authoritative.' };
  }  if (!await stage(8, { diagnosis: diagnosis.findings, confidence: 'Moderate', analysisProvider: llmResult?.provider ?? 'rules-engine', analysisSummary: llmResult?.analysis?.summary ?? null, confidenceLimit: 'Contact inactivity is observed; the dataset cannot establish why it occurred or prove causation.' }, async () => {
    await store.mutate((state) => {
      state.evidence.push({ id: randomUUID(), taskId, source: 'Sample sales ledger', referenceId: calls.analytics.id, summary: `${calls.analytics.output.records.length} monthly revenue records show a recent decline.`, facts: { records: calls.analytics.output.records } });
      state.evidence.push({ id: randomUUID(), taskId, source: 'Sample CRM adapter', referenceId: calls.diagnosis.id, summary: `${calls.diagnosis.output.stalledOpportunities.length} open opportunities have 14+ days without recorded contact.`, facts: { opportunities: calls.diagnosis.output.stalledOpportunities } });
      emit(state, taskId, 'diagnosis.ready', 'Completed', 'Evidence-backed diagnosis prepared', 'agent', { findings: diagnosis.findings, confidence: 'Moderate' });
    });
  })) return;
  if (!await stage(9, { priorityRule: 'High value and days since last contact', estimateLabel: 'Opportunity value, not forecast recovery' }, async () => makePlan(store, taskId, user, llmResult))) return;
  if (!await stage(10, { awaitingHumanDecision: true }, async () => {
    await store.mutate((state) => {
      const task = state.tasks.find((item) => item.id === taskId); task.status = 'Awaiting Approval'; task.updatedAt = new Date().toISOString();
      emit(state, taskId, 'approval.requested', 'Awaiting Approval', 'Consequential actions await your review', 'agent', { actionCount: state.actions.filter((action) => action.taskId === taskId).length });
    });
  })) return;
}

async function makePlan(store, taskId, user, llmResult) {
  await store.mutate((state) => {
    const diagnosis = diagnoseSales(state); const candidates = diagnosis.highValueStalled;
    const picks = [
      { type: 'send_email', title: 'Send a follow-up to Blue Harbor Logistics', target: candidates.find((row) => row.id === 'opp-blueharbor') ?? candidates[0], priority: 'Urgent', outcome: 'verified' },
      { type: 'update_crm', title: 'Update Redwood Analytics opportunity stage', target: state.opportunities.find((row) => row.id === 'opp-redwood') ?? candidates[1] ?? candidates[0], priority: 'High', outcome: 'inconclusive' },
      { type: 'schedule_call', title: 'Schedule a sponsor check-in with Summit Education', target: state.opportunities.find((row) => row.id === 'opp-summit') ?? candidates.at(-1) ?? candidates[0], priority: 'Medium', outcome: state.tasks.find((item) => item.id === taskId).demoScenario ? 'controlled_failure' : 'adapter_unavailable' },
    ].filter((item) => item.target);
    for (const pick of picks) {
      const params = pick.type === 'send_email'
        ? { to: `${pick.target.account.toLowerCase().replaceAll(/[^a-z0-9]+/g, '.')}@example.test`, subject: `Following up: ${pick.target.name}`, message: messageTemplate(pick.target), sandboxOutcome: pick.outcome }
        : pick.type === 'update_crm'
          ? { stage: 'Negotiation', expectedCurrentStage: pick.target.stage, reason: 'Reconfirm next step after a prolonged contact gap.', sandboxOutcome: pick.outcome }
          : { requestedWindow: 'Next 5 business days', attendees: [pick.target.owner, 'Account sponsor'], agenda: `Revisit ${pick.target.name} and confirm current priorities.`, sandboxOutcome: pick.outcome };
      const action = { id: randomUUID(), taskId, userId: user.id, type: pick.type, title: pick.title, targetId: pick.target.id, account: pick.target.account, targetName: pick.target.name, amount: pick.target.amount, priority: pick.priority, status: 'Awaiting Approval', params, evidence: [{ source: 'Sample CRM opportunity records', referenceId: pick.target.id, summary: `Open ${pick.target.stage} opportunity worth $${pick.target.amount.toLocaleString()} with last contact ${Math.floor((Date.now() - Date.parse(pick.target.lastContactAt)) / 86400000)} days ago.` }], rationale: 'A timely, relevant next step may clarify whether this opportunity is active. The estimate is the opportunity amount, not predicted recovered revenue.', risk: pick.type === 'send_email' ? 'External communication; simulated in Demo Mode.' : 'Would change a customer-facing record or calendar; simulated adapter only.', objective: 'Re-engage the customer and clarify next steps.', verificationCriteria: pick.outcome === 'verified' ? 'A matching sandbox receipt is recorded.' : pick.outcome === 'inconclusive' ? 'An authoritative CRM record must confirm the stage change.' : 'A calendar confirmation must exist.', estimate: { amount: pick.target.amount, label: 'Opportunity value at risk; not expected recovery' }, demoScenario: state.tasks.find((item) => item.id === taskId).demoScenario };
      action.actionHash = hashAction(action); action.createdAt = new Date().toISOString(); state.actions.unshift(action);
      const approval = { id: randomUUID(), actionId: action.id, userId: user.id, status: 'Awaiting Approval', actionHash: action.actionHash, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), reviewerId: null, decidedAt: null };
      state.approvals.unshift(approval);
      emit(state, taskId, 'action.proposed', 'Awaiting Approval', pick.title, 'agent', { actionId: action.id, type: action.type, target: action.account, parameters: params, evidence: action.evidence, priority: action.priority, estimate: action.estimate, risk: action.risk, approvalId: approval.id });
    }
    const firstDeal = picks[0]?.target;
    if (firstDeal) {
      const draft = invokeReadTool(state, { taskId, toolId: 'communication.draft', input: { opportunityId: firstDeal.id, tone: 'warm' } });
      if (draft.status === 'Completed') state.evidence.push({ id: randomUUID(), taskId, source: 'Communication Draft Tool', referenceId: draft.id, summary: 'A follow-up draft was prepared for review; no message was sent.', facts: { message: draft.output.message } });
    }
    const task = state.tasks.find((item) => item.id === taskId);
    task.provider = llmResult?.provider ?? task.provider;
    task.result = { analysisSummary: llmResult?.analysis?.summary ?? null, diagnosis: diagnosis.findings, plan: state.actions.filter((action) => action.taskId === taskId).map(({ id, title, account, amount, priority, rationale, verificationCriteria }) => ({ id, title, account, amount, priority, rationale, verificationCriteria })), provider: task.provider };
    emit(state, taskId, 'plan.ready', 'Completed', `${picks.length} prioritized recovery actions are ready`, 'agent', { actionIds: state.actions.filter((action) => action.taskId === taskId).map((action) => action.id), note: 'Each estimate is opportunity value, not forecast recovered revenue.' });
  });
}

export async function decideApproval(store, user, approvalId, decision, rationale = '') {
  return store.mutate((state) => {
    const approval = state.approvals.find((item) => item.id === approvalId);
    if (!approval) throw Object.assign(new Error('Approval request not found'), { status: 404 });
    const action = state.actions.find((item) => item.id === approval.actionId); const task = state.tasks.find((item) => item.id === action?.taskId);
    if (!action || task?.userId !== user.id) throw Object.assign(new Error('Approval request not found'), { status: 404 });
    if (approval.status !== 'Awaiting Approval' || action.status !== 'Awaiting Approval') throw Object.assign(new Error('This request has already been decided'), { status: 409 });
    if (approval.actionHash !== action.actionHash || action.actionHash !== hashAction(action)) throw Object.assign(new Error('The proposed action changed after approval was requested; a new approval is required.'), { status: 409 });
    if (!['approve', 'reject', 'cancel'].includes(decision)) throw Object.assign(new Error('Decision must be approve, reject, or cancel'), { status: 400 });
    const status = decision === 'approve' ? 'Approved' : decision === 'reject' ? 'Rejected' : 'Cancelled';
    approval.status = status; approval.reviewerId = user.id; approval.decidedAt = new Date().toISOString(); approval.rationale = rationale.slice(0, 500); action.status = status;
    emit(state, task.id, `approval.${decision}`, status, `Action ${decision}d: ${action.title}`, user.name, { approvalId, actionId: action.id, actionHash: action.actionHash, rationale: approval.rationale, executionAllowed: decision === 'approve' });
    if (decision === 'approve') {
      const executionStage = state.stages.find((item) => item.taskId === task.id && item.number === 11);
      if (executionStage && executionStage.status === 'Pending') { executionStage.status = 'Running'; executionStage.startedAt = new Date().toISOString(); emit(state, task.id, 'stage.running', 'Running', `11. ${executionStage.name}`, 'agent', { approvalReceived: true }); }
    }
    refreshTaskStatus(state, task); return { approval, action };
  });
}

export function refreshTaskStatus(state, task) {
  if (!task || task.status === 'Cancelled') return;
  const actions = state.actions.filter((item) => item.taskId === task.id);
  if (actions.some((action) => ['Awaiting Approval', 'Approved'].includes(action.status))) {
    task.status = actions.some((action) => action.status === 'Awaiting Approval') ? 'Awaiting Approval' : 'Approved'; task.updatedAt = new Date().toISOString(); return;
  }
  const executions = actions.map((action) => state.executions.find((item) => item.actionId === action.id)).filter(Boolean);
  const verifications = executions.map((execution) => state.verifications.find((item) => item.executionId === execution.id)).filter(Boolean);
  const failed = executions.some((execution) => execution.status === 'Failed'); const inconclusive = verifications.some((item) => item.status === 'Inconclusive');
  task.status = failed ? 'Failed' : inconclusive ? 'Inconclusive' : 'Completed'; task.updatedAt = new Date().toISOString();
  const stages = [
    [state.stages.find((item) => item.taskId === task.id && item.number === 11), { actionsSettled: true }],
    [state.stages.find((item) => item.taskId === task.id && item.number === 12), { finalStatus: task.status, verifiedCount: verifications.filter((item) => item.status === 'Verified').length, failedCount: executions.filter((item) => item.status === 'Failed').length, inconclusiveCount: verifications.filter((item) => item.status === 'Inconclusive').length }],
  ];
  const now = new Date().toISOString();
  for (const [stage, details] of stages) if (stage && stage.status !== 'Completed') { stage.status = 'Completed'; stage.completedAt = now; stage.details = { ...stage.details, ...details }; }
  task.result = { ...(task.result ?? {}), finalStatus: task.status, nextStep: failed ? 'Review the failed action and approve a safe alternative if appropriate.' : inconclusive ? 'Check the connected source of truth before treating this action as verified.' : 'Review the verified sandbox receipts and decide whether to connect a live integration.' };
}

export async function executeAction(store, user, actionId) {
  return store.mutate(async (state) => {
    const action = state.actions.find((item) => item.id === actionId); const task = state.tasks.find((item) => item.id === action?.taskId);
    if (!action || task?.userId !== user.id) throw Object.assign(new Error('Action not found'), { status: 404 });
    const approval = state.approvals.find((item) => item.actionId === action.id);
    if (approval?.status === 'Rejected' || action.status === 'Rejected') throw Object.assign(new Error('Rejected approval prevents execution.'), { status: 409 });
    if (!approval || approval.status !== 'Approved' || action.status !== 'Approved') throw Object.assign(new Error('A current approval is required before execution.'), { status: 409 });
    if (approval.actionHash !== action.actionHash || action.actionHash !== hashAction(action)) throw Object.assign(new Error('Action parameters changed after approval. Request fresh approval before execution.'), { status: 409 });
    if (state.executions.some((item) => item.actionId === actionId)) throw Object.assign(new Error('Duplicate execution prevented; this action already has an execution record.'), { status: 409 });
    if (Date.parse(approval.expiresAt) < Date.now()) throw Object.assign(new Error('Approval expired; request a new approval.'), { status: 409 });
    if (state.toolInvocations.filter((item) => item.taskId === task.id).length >= 12) throw Object.assign(new Error('This task reached its bounded limit of 12 tool calls.'), { status: 409 });
    const invocation = { id: randomUUID(), taskId: task.id, toolId: 'action.execute', input: { actionId, approvedHash: action.actionHash }, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, output: null, error: null };
    state.toolInvocations.push(invocation);
    emit(state, task.id, 'tool.started', 'Running', 'Action Execution Tool started', user.name, { invocationId: invocation.id, toolId: 'action.execute', input: invocation.input, permission: 'actions:execute' });
    emit(state, task.id, 'execution.requested', 'Running', `Executing approved action: ${action.title}`, user.name, { actionId, approvalId: approval.id, actionHash: action.actionHash, sandbox: true });
    const execution = { id: randomUUID(), actionId, status: 'Running', request: { actionType: action.type, targetId: action.targetId, params: action.params }, response: null, startedAt: new Date().toISOString(), completedAt: null };
    state.executions.push(execution);
    let verification;
    if (['controlled_failure', 'adapter_unavailable'].includes(action.params.sandboxOutcome)) {
      const injected = action.params.sandboxOutcome === 'controlled_failure';
      execution.status = 'Failed'; execution.response = { accepted: false, adapter: 'sandbox', code: injected ? 'DEMO_INJECTED_TIMEOUT' : 'ADAPTER_UNAVAILABLE', message: injected ? 'The guided demo injects a timeout here to exercise recovery handling.' : 'No calendar integration is configured; no event was created.' }; action.status = 'Failed';
      invocation.status = 'Failed'; invocation.error = { code: execution.response.code, message: execution.response.message };
      emit(state, task.id, 'execution.failed', 'Failed', `Action failed: ${action.title}`, 'sandbox-adapter', { executionId: execution.id, response: execution.response, controlledDemoFailure: injected });
      const recovery = createRecoveryAction(state, task, action, user);
      if (recovery) emit(state, task.id, 'recovery.proposed', 'Awaiting Approval', 'A safe follow-up draft is available for fresh approval', 'agent', { actionId: recovery.id, parentActionId: action.id, reason: 'Scheduling failed; a draft preserves human control while the calendar connection is unavailable.' });
      verification = { id: randomUUID(), executionId: execution.id, status: 'Inconclusive', criteria: action.verificationCriteria, evidence: [{ source: 'Sandbox execution response', summary: 'The calendar action failed; there is no successful result to verify.' }], checkedAt: new Date().toISOString() };
      state.verifications.push(verification); emit(state, task.id, 'verification.inconclusive', 'Inconclusive', 'No external outcome can be verified', 'verification-tool', { executionId: execution.id, criteria: action.verificationCriteria, evidence: verification.evidence });
    } else if (action.params.sandboxOutcome === 'inconclusive') {
      execution.status = 'Executed'; execution.response = { accepted: true, adapter: 'sandbox', receiptId: `sbx_${randomUUID()}`, message: 'Sandbox adapter accepted the stage update request.' }; action.status = 'Executed';
      state.sideEffects.push({ id: execution.response.receiptId, actionId, type: action.type, targetId: action.targetId, createdAt: new Date().toISOString(), evidenceClass: 'sandbox-acceptance-only' });
      invocation.status = 'Completed'; invocation.output = execution.response;
      emit(state, task.id, 'execution.completed', 'Executed', `Sandbox accepted: ${action.title}`, 'sandbox-adapter', { executionId: execution.id, response: execution.response });
      verification = { id: randomUUID(), executionId: execution.id, status: 'Inconclusive', criteria: action.verificationCriteria, evidence: [{ source: 'Sandbox adapter response', summary: 'Accepted response only; no authoritative CRM record is connected to confirm a stage change.' }], checkedAt: new Date().toISOString() };
      state.verifications.push(verification); emit(state, task.id, 'verification.inconclusive', 'Inconclusive', 'Execution accepted but not verified in an authoritative CRM', 'verification-tool', { executionId: execution.id, criteria: verification.criteria, evidence: verification.evidence });
    } else if (action.type === 'email_draft') {
      const receipt = `sbx_${randomUUID()}`;
      execution.status = 'Executed'; execution.response = { accepted: true, adapter: 'sandbox-drafts', receiptId: receipt, message: 'Draft stored in the sandbox for review. No email was sent.' }; action.status = 'Executed';
      state.sideEffects.push({ id: receipt, actionId, type: 'email_draft', targetId: action.targetId, subject: action.params.subject, message: action.params.message, createdAt: new Date().toISOString(), evidenceClass: 'sandbox-draft-receipt' });
      invocation.status = 'Completed'; invocation.output = execution.response;
      emit(state, task.id, 'execution.completed', 'Executed', `Recovery draft created: ${action.title}`, 'sandbox-adapter', { executionId: execution.id, response: execution.response });
      verification = { id: randomUUID(), executionId: execution.id, status: state.sideEffects.some((row) => row.id === receipt && row.actionId === actionId) ? 'Verified' : 'Failed', criteria: action.verificationCriteria, evidence: [{ source: 'Demo sandbox drafts', referenceId: receipt, summary: 'The approved draft is present in the sandbox draft list.' }], checkedAt: new Date().toISOString() };
      state.verifications.push(verification); emit(state, task.id, `verification.${verification.status.toLowerCase()}`, verification.status, `Sandbox draft ${verification.status.toLowerCase()}`, 'verification-tool', { executionId: execution.id, verificationId: verification.id, criteria: verification.criteria, evidence: verification.evidence });
    } else {
      const receipt = `sbx_${randomUUID()}`;
      execution.status = 'Executed'; execution.response = { accepted: true, adapter: 'sandbox-mailbox', receiptId: receipt, recipient: action.params.to, message: 'Email stored in the demo sandbox mailbox. No email was sent externally.' }; action.status = 'Executed';
      state.sideEffects.push({ id: receipt, actionId, type: action.type, targetId: action.targetId, to: action.params.to, message: action.params.message, createdAt: new Date().toISOString(), evidenceClass: 'sandbox-mailbox-receipt' });
      invocation.status = 'Completed'; invocation.output = execution.response;
      emit(state, task.id, 'execution.completed', 'Executed', `Sandbox action executed: ${action.title}`, 'sandbox-adapter', { executionId: execution.id, response: execution.response });
      verification = { id: randomUUID(), executionId: execution.id, status: state.sideEffects.some((row) => row.id === receipt && row.actionId === actionId) ? 'Verified' : 'Failed', criteria: action.verificationCriteria, evidence: [{ source: 'Demo sandbox mailbox', referenceId: receipt, summary: 'A matching sandbox receipt is present for the approved action.' }], checkedAt: new Date().toISOString() };
      state.verifications.push(verification); emit(state, task.id, `verification.${verification.status.toLowerCase()}`, verification.status, `Sandbox receipt ${verification.status.toLowerCase()}`, 'verification-tool', { executionId: execution.id, verificationId: verification.id, criteria: verification.criteria, evidence: verification.evidence });
    }
    execution.completedAt = new Date().toISOString(); invocation.completedAt = new Date().toISOString();
    emit(state, task.id, 'tool.completed', invocation.status === 'Completed' ? 'Completed' : 'Failed', 'Action Execution Tool finished', 'system', { invocationId: invocation.id, toolId: 'action.execute', resultSummary: execution.response?.message });
    const verificationCall = { id: randomUUID(), taskId: task.id, toolId: 'verification.audit', input: { executionId: execution.id }, output: { status: verification.status, criteria: verification.criteria, evidence: verification.evidence }, status: 'Completed', startedAt: verification.checkedAt, completedAt: verification.checkedAt, error: null };
    state.toolInvocations.push(verificationCall); emit(state, task.id, 'tool.completed', 'Completed', 'Verification and Audit Tool completed', 'system', { invocationId: verificationCall.id, toolId: 'verification.audit', resultSummary: verification.status });
    refreshTaskStatus(state, task);
    if (['Failed', 'Inconclusive', 'Completed'].includes(task.status)) emit(state, task.id, 'task.finalized', task.status, `Task settled with ${task.status.toLowerCase()} status`, 'agent', { nextStep: task.result.nextStep });
    return { execution, verification, action };
  });
}
function createRecoveryAction(state, task, failedAction, user) {
  if (state.actions.some((item) => item.parentActionId === failedAction.id)) return null;
  const target = state.opportunities.find((item) => item.id === failedAction.targetId); if (!target) return null;
  const params = { draftOnly: true, subject: `Follow-up: ${target.name}`, message: messageTemplate(target), sandboxOutcome: 'pending_review' };
  const action = { id: randomUUID(), taskId: task.id, userId: user.id, type: 'email_draft', title: `Create a follow-up draft for ${target.account}`, targetId: target.id, account: target.account, targetName: target.name, amount: target.amount, priority: 'Alternative', status: 'Awaiting Approval', params, evidence: [{ source: 'Failed action', referenceId: failedAction.id, summary: 'Calendar adapter unavailable; a draft is a reversible alternative.' }], rationale: 'Creates a draft only. No message is sent and the calendar event is not retried.', risk: 'Draft content remains in the sandbox for review.', objective: 'Keep a safe next step available while calendar integration is unavailable.', verificationCriteria: 'A draft record is available in the sandbox.', estimate: { amount: target.amount, label: 'Opportunity value at risk; not expected recovery' }, parentActionId: failedAction.id, demoScenario: task.demoScenario };
  action.actionHash = hashAction(action); action.createdAt = new Date().toISOString(); state.actions.unshift(action);
  state.approvals.unshift({ id: randomUUID(), actionId: action.id, userId: user.id, status: 'Awaiting Approval', actionHash: action.actionHash, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), reviewerId: null, decidedAt: null });
  return action;
}
export async function cancelTask(store, user, taskId) {
  return store.mutate((state) => {
    const task = state.tasks.find((item) => item.id === taskId && item.userId === user.id);
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    if (['Completed', 'Failed', 'Inconclusive', 'Cancelled'].includes(task.status)) throw Object.assign(new Error('Task is already settled'), { status: 409 });
    task.status = 'Cancelled'; task.updatedAt = new Date().toISOString();
    for (const stage of state.stages.filter((item) => item.taskId === taskId && ['Pending', 'Running'].includes(item.status))) { stage.status = 'Cancelled'; stage.completedAt = new Date().toISOString(); }
    emit(state, taskId, 'task.cancelled', 'Cancelled', 'Task cancelled by user', user.name, {}); return task;
  });
}
async function failTask(store, taskId, error) {
  await store.mutate((state) => {
    const task = state.tasks.find((item) => item.id === taskId); if (!task || task.status === 'Cancelled') return;
    task.status = 'Failed'; task.updatedAt = new Date().toISOString(); emit(state, taskId, 'task.failed', 'Failed', 'Investigation stopped with an error', 'system', { message: error.message });
  });
}







export async function pauseTask(store, user, taskId) {
  return store.mutate((state) => {
    const task = state.tasks.find((item) => item.id === taskId && item.userId === user.id);
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    if (task.status !== 'Running') throw Object.assign(new Error('Only a running investigation can be paused.'), { status: 409 });
    task.status = 'Paused'; task.updatedAt = new Date().toISOString(); emit(state, taskId, 'task.paused', 'Paused', 'Investigation paused by user', user.name, {}); return task;
  });
}
export async function resumeTask(store, user, taskId) {
  return store.mutate((state) => {
    const task = state.tasks.find((item) => item.id === taskId && item.userId === user.id);
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    if (task.status !== 'Paused') throw Object.assign(new Error('Only a paused investigation can be resumed.'), { status: 409 });
    task.status = 'Running'; task.updatedAt = new Date().toISOString(); emit(state, taskId, 'task.resumed', 'Running', 'Investigation resumed by user', user.name, {}); return task;
  });
}





