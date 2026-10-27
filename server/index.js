import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadEnv } from './config.js';
import { createStore } from './store.js';
import { runMigrations } from './migrate.js';
import { passwordHash, verifyPassword, tokenDigest, cookieOptions, parseCookies, newSession, DEMO_EMAIL, DEMO_PASSWORD } from './auth.js';
import { appendEvent, verifyEventChain, safeUser } from './recorder.js';
import { dashboardMetrics, compatibilityScore, INTEREST_WEIGHTS } from './domain.js';
import { registeredTools } from './tools.js';
import { createTask, cancelTask, pauseTask, resumeTask, decideApproval, executeAction, stageNames } from './agent.js';
import { aiFriendSchema, generateFriendReply } from './ai-friends.js';

const app = express();
const attempts = new Map();
const emailSchema = z.string().email().max(200).transform((value) => value.toLowerCase());
const loginSchema = z.object({ email: emailSchema, password: z.string().min(8).max(200) });
const registerSchema = z.object({ name: z.string().trim().min(2).max(80), email: emailSchema, password: z.string().min(10).max(200) });
const taskSchema = z.object({ objective: z.string().trim().min(10).max(1600), periodDays: z.union([z.literal(30), z.literal(90), z.literal(180)]).default(90), demoScenario: z.boolean().default(true) });
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject', 'cancel']), rationale: z.string().max(500).default('') });
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const sendError = (res, error) => res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Unexpected server error', code: error.code ?? 'SERVER_ERROR' });

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '200kb' }));

function limited(req, res, next) {
  const key = `${req.ip}:${req.path}`; const now = Date.now(); const bucket = attempts.get(key) ?? { count: 0, resetAt: now + 60000 };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60000; }
  bucket.count += 1; attempts.set(key, bucket);
  if (bucket.count > 12) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  next();
}
function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).nexus_session;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  return req.app.locals.store.read().then((state) => {
    const session = state.sessions.find((item) => item.id === tokenDigest(token) && Date.parse(item.expiresAt) > Date.now());
    const user = state.users.find((item) => item.id === session?.userId);
    if (!session || !user) return res.status(401).json({ error: 'Your session expired. Sign in again.' });
    req.user = safeUser(user); req.sessionId = session.id; next();
  }).catch(next);
}
function requireAdmin(req, res, next) { if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' }); next(); }
const ownTask = (state, user, id) => state.tasks.find((item) => item.id === id && item.userId === user.id);
const sortNewest = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

app.get('/api/health', asyncRoute(async (req, res) => res.json({ status: 'ok', demoMode: process.env.DEMO_MODE !== 'false', persistence: process.env.DATABASE_URL ? 'postgres' : 'local-file', aiProvider: process.env.AI_API_URL ? 'configured' : 'rules-engine' })));
app.get('/api/session', asyncRoute(async (req, res) => {
  const token = parseCookies(req.headers.cookie).nexus_session;
  if (!token) return res.json({ user: null, demo: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
  const state = await req.app.locals.store.read(); const session = state.sessions.find((item) => item.id === tokenDigest(token) && Date.parse(item.expiresAt) > Date.now());
  const user = state.users.find((item) => item.id === session?.userId);
  return res.json({ user: user ? safeUser(user) : null, demo: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
}));
app.post('/api/login', limited, asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const state = await req.app.locals.store.read(); const user = state.users.find((item) => item.email === parsed.data.email);
  if (!user || !await verifyPassword(parsed.data.password, user.passwordHash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const session = newSession(user.id);
  await req.app.locals.store.mutate((data) => { data.sessions = data.sessions.filter((item) => Date.parse(item.expiresAt) > Date.now()); data.sessions.push(session.record); data.auditLogs.unshift({ id: randomUUID(), actorId: user.id, kind: 'auth.login', createdAt: new Date().toISOString() }); });
  res.setHeader('Set-Cookie', `nexus_session=${encodeURIComponent(session.token)}; ${cookieOptions(Number(process.env.SESSION_TTL_HOURS || 12) * 3600)}`);
  return res.json({ user: safeUser(user) });
}));
app.post('/api/register', limited, asyncRoute(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Check your name, email, and password (10 characters minimum).' });
  const passwordDigest = await passwordHash(parsed.data.password); const user = { id: randomUUID(), email: parsed.data.email, name: parsed.data.name, role: 'member', passwordHash: passwordDigest, createdAt: new Date().toISOString() };
  const session = newSession(user.id);
  try { await req.app.locals.store.mutate((state) => { if (state.users.some((item) => item.email === user.email)) throw Object.assign(new Error('An account with that email already exists.'), { status: 409 }); state.users.push(user); state.sessions.push(session.record); state.profiles.push({ userId: user.id, data: { bio: '', interests: [], goals: [], socialStyle: '', availability: '', languages: [], location: '' }, privacy: { discoverable: false, showLocation: false, shareInterests: true }, updatedAt: new Date().toISOString() }); state.auditLogs.unshift({ id: randomUUID(), actorId: user.id, kind: 'auth.register', createdAt: new Date().toISOString() }); }); }
  catch (error) { return sendError(res, error); }
  res.setHeader('Set-Cookie', `nexus_session=${encodeURIComponent(session.token)}; ${cookieOptions(Number(process.env.SESSION_TTL_HOURS || 12) * 3600)}`); return res.status(201).json({ user: safeUser(user) });
}));
app.post('/api/logout', requireAuth, asyncRoute(async (req, res) => {
  await req.app.locals.store.mutate((state) => { state.sessions = state.sessions.filter((item) => item.id !== req.sessionId); state.auditLogs.unshift({ id: randomUUID(), actorId: req.user.id, kind: 'auth.logout', createdAt: new Date().toISOString() }); });
  res.setHeader('Set-Cookie', `nexus_session=; ${cookieOptions(0)}`); res.json({ ok: true });
}));

app.use('/api', (req, res, next) => { if (['/health', '/session', '/login', '/register'].includes(req.path)) return next(); return requireAuth(req, res, next); });
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const days = [30, 90, 180].includes(Number(req.query.days)) ? Number(req.query.days) : 90;
  res.json({ metrics: dashboardMetrics(state, days), unreadNotifications: state.notifications.filter((item) => item.userId === req.user.id && !item.readAt).length, recentTasks: state.tasks.filter((task) => task.userId === req.user.id).slice(0, 6), recentEvents: state.events.slice().reverse().filter((event) => event.taskId && ownTask(state, req.user, event.taskId)).slice(0, 8), sample: true });
}));
app.get('/api/tools', (req, res) => res.json({ tools: registeredTools }));
app.get('/api/opportunities', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const q = String(req.query.q ?? '').toLowerCase(); const status = req.query.status;
  const rows = state.opportunities.filter((row) => (!status || row.status === status) && (!q || `${row.account} ${row.name} ${row.owner} ${row.stage} ${row.product}`.toLowerCase().includes(q))).map((row) => ({ ...row, daysSinceContact: Math.floor((Date.now() - Date.parse(row.lastContactAt)) / 86400000), evidenceSource: 'Sample CRM opportunity records' }));
  res.json({ opportunities: rows, sample: true });
}));
app.get('/api/tasks', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read();
  const tasks = state.tasks.filter((task) => task.userId === req.user.id).map((task) => ({ ...task, stageCounts: Object.fromEntries(['Completed', 'Running', 'Pending', 'Failed'].map((status) => [status, state.stages.filter((stage) => stage.taskId === task.id && stage.status === status).length])) }));
  res.json({ tasks });
}));
app.post('/api/tasks', asyncRoute(async (req, res) => {
  const parsed = taskSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Enter an objective with at least 10 characters and choose a supported period.' });
  if (!/\b(sales|revenue|pipeline|opportunit(y|ies)|deal|crm|customer|account|recovery|stalled|decline)\b/i.test(parsed.data.objective)) return res.status(400).json({ error: 'NexusAI currently investigates sales revenue, pipeline, customer, and opportunity recovery objectives.' });
  const id = await createTask(req.app.locals.store, req.user, parsed.data.objective, parsed.data); return res.status(202).json({ taskId: id, status: 'Running' });
}));
app.post('/api/tasks/:id/cancel', asyncRoute(async (req, res) => res.json({ task: await cancelTask(req.app.locals.store, req.user, req.params.id) })));
app.post('/api/tasks/:id/pause', asyncRoute(async (req, res) => res.json({ task: await pauseTask(req.app.locals.store, req.user, req.params.id) })));
app.post('/api/tasks/:id/resume', asyncRoute(async (req, res) => res.json({ task: await resumeTask(req.app.locals.store, req.user, req.params.id) })));
app.post('/api/tasks/:id/retry', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const task = ownTask(state, req.user, req.params.id); if (!task) return res.status(404).json({ error: 'Task not found' });
  const id = await createTask(req.app.locals.store, req.user, task.objective, { periodDays: task.periodDays, demoScenario: task.demoScenario }); return res.status(202).json({ taskId: id, status: 'Running' });
}));
app.get('/api/tasks/:id', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const task = ownTask(state, req.user, req.params.id); if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task, stages: state.stages.filter((item) => item.taskId === task.id).sort((a, b) => a.number - b.number), evidence: state.evidence.filter((item) => item.taskId === task.id), tools: state.toolInvocations.filter((item) => item.taskId === task.id), actions: state.actions.filter((item) => item.taskId === task.id), approvals: state.approvals.filter((item) => item.userId === req.user.id && state.actions.some((a) => a.id === item.actionId && a.taskId === task.id)), executions: state.executions.filter((item) => state.actions.some((a) => a.id === item.actionId && a.taskId === task.id)), verifications: state.verifications.filter((item) => state.executions.some((e) => e.id === item.executionId && state.actions.some((a) => a.id === e.actionId && a.taskId === task.id))), events: state.events.filter((item) => item.taskId === task.id) });
}));
app.get('/api/approvals', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read();
  const rows = state.approvals.filter((approval) => approval.userId === req.user.id).map((approval) => ({ ...approval, action: state.actions.find((item) => item.id === approval.actionId) })).filter((approval) => approval.action).sort(sortNewest);
  res.json({ approvals: rows });
}));
app.post('/api/approvals/:id/decision', asyncRoute(async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Choose approve, reject, or cancel.' });
  const result = await decideApproval(req.app.locals.store, req.user, req.params.id, parsed.data.decision, parsed.data.rationale); res.json(result);
}));
app.post('/api/actions/:id/execute', asyncRoute(async (req, res) => res.json(await executeAction(req.app.locals.store, req.user, req.params.id))));
app.get('/api/flight-recorder', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const allowed = new Set(state.tasks.filter((task) => task.userId === req.user.id).map((task) => task.id));
  const type = String(req.query.type ?? ''); const status = String(req.query.status ?? ''); const q = String(req.query.q ?? '').toLowerCase(); const from = req.query.from ? Date.parse(String(req.query.from)) : 0;
  const events = state.events.filter((event) => allowed.has(event.taskId) && (!type || event.type === type) && (!status || event.status === status) && (!q || `${event.title} ${event.type} ${JSON.stringify(event.details)}`.toLowerCase().includes(q)) && Date.parse(event.createdAt) >= from).slice().reverse();
  const tasks = state.tasks.filter((task) => task.userId === req.user.id).sort(sortNewest);
  res.json({ events, tasks, eventTypes: [...new Set(state.events.filter((event) => allowed.has(event.taskId)).map((event) => event.type))].sort() });
}));
app.get('/api/flight-recorder/:id', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const task = ownTask(state, req.user, req.params.id); if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task, events: state.events.filter((event) => event.taskId === task.id), chainIntegrity: verifyEventChain(state.events), actions: state.actions.filter((item) => item.taskId === task.id), approvals: state.approvals.filter((item) => state.actions.some((action) => action.id === item.actionId && action.taskId === task.id)), executions: state.executions.filter((item) => state.actions.some((action) => action.id === item.actionId && action.taskId === task.id)), verifications: state.verifications.filter((item) => state.executions.some((execution) => execution.id === item.executionId && state.actions.some((action) => action.id === execution.actionId && action.taskId === task.id))) });
}));
app.get('/api/flight-recorder/:id/export', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const task = ownTask(state, req.user, req.params.id); if (!task) return res.status(404).json({ error: 'Task not found' });
  const payload = { exportedAt: new Date().toISOString(), task, stages: state.stages.filter((item) => item.taskId === task.id), evidence: state.evidence.filter((item) => item.taskId === task.id), toolInvocations: state.toolInvocations.filter((item) => item.taskId === task.id), actions: state.actions.filter((item) => item.taskId === task.id), approvals: state.approvals.filter((item) => state.actions.some((action) => action.id === item.actionId && action.taskId === task.id)), executions: state.executions.filter((item) => state.actions.some((action) => action.id === item.actionId && action.taskId === task.id)), verifications: state.verifications.filter((item) => state.executions.some((execution) => execution.id === item.executionId && state.actions.some((action) => action.id === execution.actionId && action.taskId === task.id))), events: state.events.filter((item) => item.taskId === task.id), chainIntegrity: verifyEventChain(state.events) };
  if (req.query.format === 'report') {
    const lines = [`NexusAI Recovery Flight Recorder`, `Exported: ${payload.exportedAt}`, `Task: ${task.id}`, `Objective: ${task.objective}`, `Status: ${task.status}`, `Integrity chain valid: ${payload.chainIntegrity.valid} (${payload.chainIntegrity.checked} event(s) checked)`, '', 'EVENTS', ...payload.events.map((event) => `${event.createdAt} | ${event.status} | ${event.title}\n  ${JSON.stringify(event.details)}`), '', 'LIMITATION', 'SHA-256 hashes can help detect changes to this record. They do not independently prove that an external action occurred.'];
    return res.type('text/plain').attachment(`nexusai-flight-recorder-${task.id}.txt`).send(lines.join('\n'));
  }
  return res.type('application/json').attachment(`nexusai-flight-recorder-${task.id}.json`).send(JSON.stringify(payload, null, 2));
}));
app.get('/api/telemetry', requireAdmin, asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const start = req.query.from ? Date.parse(String(req.query.from)) : Date.now() - 30 * 86400000;
  const tasks = state.tasks.filter((task) => Date.parse(task.createdAt) >= start); const calls = state.toolInvocations.filter((call) => Date.parse(call.startedAt) >= start);
  const approvals = state.approvals.filter((item) => Date.parse(item.createdAt) >= start && item.decidedAt);
  const avgApprovalMs = approvals.length ? approvals.reduce((sum, item) => sum + Date.parse(item.decidedAt) - Date.parse(item.createdAt), 0) / approvals.length : null;
  const tools = [...new Set(calls.map((call) => call.toolId))].map((toolId) => { const rows = calls.filter((call) => call.toolId === toolId); const latencies = rows.filter((call) => call.completedAt).map((call) => Date.parse(call.completedAt) - Date.parse(call.startedAt)); return { toolId, count: rows.length, failures: rows.filter((call) => call.status === 'Failed').length, avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null }; });
  res.json({ windowStart: new Date(start).toISOString(), taskCount: tasks.length, activeTasks: tasks.filter((task) => ['Running', 'Awaiting Approval', 'Approved'].includes(task.status)).length, completed: tasks.filter((task) => task.status === 'Completed').length, failed: tasks.filter((task) => task.status === 'Failed').length, inconclusive: tasks.filter((task) => task.status === 'Inconclusive').length, retryCount: state.auditLogs.filter((event) => event.kind === 'task.retry').length, avgApprovalMs, tools, stages: stageNames.map((name, index) => { const rows = state.stages.filter((stage) => stage.number === index + 1 && stage.startedAt && stage.completedAt); return { name, count: rows.length, avgDurationMs: rows.length ? Math.round(rows.reduce((sum, row) => sum + Date.parse(row.completedAt) - Date.parse(row.startedAt), 0) / rows.length) : null }; }), errorCategories: calls.filter((call) => call.error).reduce((counts, call) => { const key = call.error.code ?? 'UNKNOWN'; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}), privacy: 'Message bodies and credentials are excluded from telemetry.' });
}));

app.get('/api/discovery', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const ownProfile = state.profiles.find((item) => item.userId === req.user.id);
  const privacy = ownProfile?.privacy ?? {};
  const profileData = ownProfile?.data ?? {};
  const profile = privacy.shareInterests === false ? { ...profileData, interests: [], goals: [] } : profileData;
  if (privacy.discoverable === false && req.user.role !== 'admin') return res.json({ profiles: [], notice: 'Turn on discovery in Privacy Settings to see recommendations.' });
  const blocked = new Set(privacy.blockedProfileIds ?? []);
  const profiles = state.friendProfiles.filter((person) => person.visibility === 'discoverable' && !blocked.has(person.id)).map((person) => { const visible = person.shareInterests === false ? { ...person, interests: [], goals: [] } : person; return { ...visible, ...(visible.location && privacy.showLocation === false ? { location: 'Not shared' } : {}), compatibility: compatibilityScore(profile, visible) }; }).sort((a, b) => (b.compatibility.score ?? -1) - (a.compatibility.score ?? -1));
  res.json({ profiles, weights: INTEREST_WEIGHTS, estimateNotice: 'Scores are estimates based on shared profile fields, not guarantees of relationship quality.' });
}));
app.get('/api/ai-friends', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read();
  const friends = (state.aiFriends ?? []).filter((friend) => friend.userId === req.user.id).sort(sortNewest);
  res.json({ friends, provider: process.env.AI_API_URL ? 'configured-llm' : 'local-fallback' });
}));
app.post('/api/ai-friends', asyncRoute(async (req, res) => {
  const parsed = aiFriendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Add a name, describe the support you need, and choose a reply style.' });
  const friend = { id: randomUUID(), userId: req.user.id, ...parsed.data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await req.app.locals.store.mutate((state) => {
    state.aiFriends ??= []; state.aiFriendMessages ??= [];
    if (state.aiFriends.filter((item) => item.userId === req.user.id).length >= 20) throw Object.assign(new Error('You can create up to 20 AI friends.'), { status: 409 });
    state.aiFriends.unshift(friend);
  });
  res.status(201).json({ friend });
}));
app.get('/api/ai-friends/:id/messages', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read();
  const friend = (state.aiFriends ?? []).find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!friend) return res.status(404).json({ error: 'AI friend not found.' });
  const messages = (state.aiFriendMessages ?? []).filter((item) => item.aiFriendId === friend.id && item.userId === req.user.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  res.json({ messages });
}));
app.post('/api/ai-friends/:id/messages', asyncRoute(async (req, res) => {
  const parsed = z.object({ content: z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Message must contain 1–2000 characters.' });
  const store = req.app.locals.store;
  const state = await store.read();
  const friend = (state.aiFriends ?? []).find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!friend) return res.status(404).json({ error: 'AI friend not found.' });
  const previous = (state.aiFriendMessages ?? []).filter((item) => item.aiFriendId === friend.id && item.userId === req.user.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const userMessage = { id: randomUUID(), aiFriendId: friend.id, userId: req.user.id, role: 'user', content: parsed.data.content, createdAt: new Date().toISOString() };
  await store.mutate((data) => { data.aiFriendMessages ??= []; data.aiFriendMessages.push(userMessage); });
  const history = [...previous.slice(-11).map(({ role, content }) => ({ role, content })), { role: 'user', content: userMessage.content }];
  const generated = await generateFriendReply(friend, history);
  const reply = { id: randomUUID(), aiFriendId: friend.id, userId: req.user.id, role: 'assistant', content: generated.content, provider: generated.provider, createdAt: new Date().toISOString() };
  await store.mutate((data) => {
    data.aiFriendMessages ??= []; data.aiFriendMessages.push(reply);
    const current = (data.aiFriends ?? []).find((item) => item.id === friend.id && item.userId === req.user.id);
    if (current) current.updatedAt = reply.createdAt;
  });
  res.json({ userMessage, reply, provider: generated.provider });
}));

app.post('/api/friend-requests', asyncRoute(async (req, res) => {
  const profileId = z.string().min(1).max(100).safeParse(req.body?.profileId); if (!profileId.success) return res.status(400).json({ error: 'Choose a profile.' });
  return req.app.locals.store.mutate((state) => {
    const privacy = state.profiles.find((item) => item.userId === req.user.id)?.privacy ?? {};
    const target = state.friendProfiles.find((item) => item.id === profileId.data && item.visibility === 'discoverable' && !(privacy.blockedProfileIds ?? []).includes(item.id));
    if (!target) throw Object.assign(new Error('Profile is not available.'), { status: 404 });
    let created = false; let request = state.friendRequests.find((item) => item.fromUserId === req.user.id && item.toProfileId === target.id);
    if (!request) { request = { id: randomUUID(), fromUserId: req.user.id, toProfileId: target.id, status: 'Pending', createdAt: new Date().toISOString() }; state.friendRequests.push(request); created = true; state.notifications.unshift({ id: randomUUID(), userId: req.user.id, kind: 'social', title: 'Friend request sent', body: `Your request to ${target.name} is in the demo outbox.`, createdAt: new Date().toISOString(), readAt: null }); }
    return res.status(created ? 201 : 200).json({ request });
  });
}));
app.get('/api/matches', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read();
  res.json({ matches: state.friendRequests.filter((request) => request.fromUserId === req.user.id || request.toUserId === req.user.id).map((request) => ({ ...request, person: state.friendProfiles.find((profile) => profile.id === request.toProfileId) ?? state.users.find((user) => user.id === request.fromUserId) })) });
}));
app.get('/api/conversations', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read();
  const conversations = state.conversations.filter((conversation) => conversation.participantIds.includes(req.user.id)).map((conversation) => ({ ...conversation, messages: state.messages.filter((message) => message.conversationId === conversation.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) }));
  res.json({ conversations });
}));
app.post('/api/conversations/:id/messages', asyncRoute(async (req, res) => {
  const parsed = z.object({ body: z.string().trim().min(1).max(2000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Message must contain 1–2000 characters.' });
  return req.app.locals.store.mutate((state) => {
    const conversation = state.conversations.find((item) => item.id === req.params.id && item.participantIds.includes(req.user.id));
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const message = { id: randomUUID(), conversationId: conversation.id, senderId: req.user.id, senderName: req.user.name, body: parsed.data.body, createdAt: new Date().toISOString() };
    state.messages.push(message); conversation.updatedAt = message.createdAt; return res.status(201).json({ message });
  });
}));
app.get('/api/communities', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); res.json({ communities: state.communities.map(({ joinedBy = [], ...community }) => ({ ...community, joined: joinedBy.includes(req.user.id) })) });
}));
app.post('/api/communities/:id/join', asyncRoute(async (req, res) => req.app.locals.store.mutate((state) => {
  const community = state.communities.find((item) => item.id === req.params.id); if (!community) return res.status(404).json({ error: 'Community not found.' });
  community.joinedBy ??= []; const index = community.joinedBy.indexOf(req.user.id);
  if (index >= 0) { community.joinedBy.splice(index, 1); community.memberCount = Math.max(0, community.memberCount - 1); }
  else { community.joinedBy.push(req.user.id); community.memberCount += 1; }
  return res.json({ joined: index < 0, community: { id: community.id, memberCount: community.memberCount } });
})));
app.get('/api/notifications', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); res.json({ notifications: state.notifications.filter((item) => item.userId === req.user.id).sort(sortNewest), unread: state.notifications.filter((item) => item.userId === req.user.id && !item.readAt).length });
}));
app.post('/api/notifications/:id/read', asyncRoute(async (req, res) => req.app.locals.store.mutate((state) => {
  const notification = state.notifications.find((item) => item.id === req.params.id && item.userId === req.user.id); if (!notification) return res.status(404).json({ error: 'Notification not found.' });
  notification.readAt = new Date().toISOString(); return res.json({ notification });
})));
app.get('/api/profile', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); const profile = state.profiles.find((item) => item.userId === req.user.id);
  res.json({ user: req.user, profile: profile?.data ?? {}, privacy: profile?.privacy ?? {} });
}));
app.patch('/api/profile', asyncRoute(async (req, res) => {
  const schema = z.object({ name: z.string().trim().min(2).max(80).optional(), bio: z.string().max(500).optional(), interests: z.array(z.string().trim().min(1).max(40)).max(12).optional(), goals: z.array(z.string().trim().min(1).max(80)).max(12).optional(), socialStyle: z.string().max(40).optional(), availability: z.string().max(40).optional(), languages: z.array(z.string().trim().min(1).max(40)).max(8).optional(), location: z.string().max(80).optional() }).strict();
  const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Profile fields did not pass validation.' });
  return req.app.locals.store.mutate((state) => {
    const user = state.users.find((item) => item.id === req.user.id); if (parsed.data.name) user.name = parsed.data.name;
    let profile = state.profiles.find((item) => item.userId === req.user.id); if (!profile) { profile = { userId: req.user.id, data: {}, privacy: {}, updatedAt: new Date().toISOString() }; state.profiles.push(profile); }
    const { name, ...profileFields } = parsed.data; Object.assign(profile.data, profileFields); profile.updatedAt = new Date().toISOString();
    state.auditLogs.unshift({ id: randomUUID(), actorId: req.user.id, kind: 'profile.update', createdAt: new Date().toISOString() }); return res.json({ user: safeUser(user), profile: profile.data });
  });
}));
app.patch('/api/privacy', asyncRoute(async (req, res) => {
  const parsed = z.object({ discoverable: z.boolean().optional(), showLocation: z.boolean().optional(), shareInterests: z.boolean().optional() }).strict().safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Privacy settings did not pass validation.' });
  return req.app.locals.store.mutate((state) => {
    let profile = state.profiles.find((item) => item.userId === req.user.id); if (!profile) { profile = { userId: req.user.id, data: {}, privacy: {}, updatedAt: new Date().toISOString() }; state.profiles.push(profile); }
    Object.assign(profile.privacy, parsed.data); profile.updatedAt = new Date().toISOString();
    state.auditLogs.unshift({ id: randomUUID(), actorId: req.user.id, kind: 'privacy.update', createdAt: new Date().toISOString() }); return res.json({ privacy: profile.privacy });
  });
}));
app.post('/api/privacy/block/:profileId', asyncRoute(async (req, res) => req.app.locals.store.mutate((state) => {
  if (!state.friendProfiles.some((item) => item.id === req.params.profileId)) return res.status(404).json({ error: 'Profile not found.' });
  let profile = state.profiles.find((item) => item.userId === req.user.id); if (!profile) { profile = { userId: req.user.id, data: {}, privacy: {}, updatedAt: new Date().toISOString() }; state.profiles.push(profile); }
  profile.privacy.blockedProfileIds ??= []; if (!profile.privacy.blockedProfileIds.includes(req.params.profileId)) profile.privacy.blockedProfileIds.push(req.params.profileId);
  profile.updatedAt = new Date().toISOString(); state.auditLogs.unshift({ id: randomUUID(), actorId: req.user.id, kind: 'privacy.block', createdAt: new Date().toISOString() }); return res.json({ blocked: true });
})));
app.get('/api/settings', asyncRoute(async (req, res) => {
  const state = await req.app.locals.store.read(); res.json({ mode: 'demo', persistence: state.settings.databaseMode, aiProvider: state.settings.aiProvider, sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12), tools: registeredTools.map(({ id, name, kind, permission }) => ({ id, name, kind, permission })) });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must be valid JSON.' });
  if (error.status) return sendError(res, error);
  console.error('Request failed:', error.message); return res.status(500).json({ error: 'Unexpected server error', code: 'SERVER_ERROR' });
});

export async function start() {
  await loadEnv();
  if (process.env.DATABASE_URL) await runMigrations();
  const store = await createStore(); app.locals.store = store;
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist'), { index: false, fallthrough: true }));
    app.use((req, res) => res.sendFile(path.resolve('dist/index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: path.resolve('vite.config.js'), server: { middlewareMode: true }, appType: 'custom' });
    app.use(vite.middlewares);
    const { readFile } = await import('node:fs/promises');
    app.use(asyncRoute(async (req, res) => {
      const html = await readFile(path.resolve('src/index.html'), 'utf8');
      res.status(200).type('html').send(await vite.transformIndexHtml(req.originalUrl, html));
    }));
  }
  const port = Number(process.env.PORT || 4173);
  const server = app.listen(port, () => process.stdout.write(`NexusAI listening at http://localhost:${port}\n`));
  const close = async () => { server.close(); await store.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { app, server, store };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) start().catch((error) => { console.error(error); process.exitCode = 1; });






