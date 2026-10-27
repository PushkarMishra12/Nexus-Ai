export const INTEREST_WEIGHTS = { interests: 35, goals: 25, socialStyle: 15, availability: 10, languages: 10, location: 5 };
const normalizedSet = (value) => new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean));
const jaccard = (a, b) => {
  const aa = normalizedSet(a); const bb = normalizedSet(b);
  if (!aa.size && !bb.size) return null;
  if (!aa.size || !bb.size) return 0;
  const common = [...aa].filter((item) => bb.has(item)).length;
  return common / new Set([...aa, ...bb]).size;
};
export function compatibilityScore(left = {}, right = {}) {
  const comparisons = {
    interests: jaccard(left.interests, right.interests),
    goals: jaccard(left.goals, right.goals),
    socialStyle: left.socialStyle && right.socialStyle ? (left.socialStyle === right.socialStyle ? 1 : 0) : null,
    availability: left.availability && right.availability ? (left.availability === right.availability ? 1 : 0) : null,
    languages: jaccard(left.languages, right.languages),
    location: left.location && right.location ? (left.location.toLowerCase() === right.location.toLowerCase() ? 1 : 0) : null,
  };
  const availableWeight = Object.entries(comparisons).reduce((sum, [key, value]) => sum + (value === null ? 0 : INTEREST_WEIGHTS[key]), 0);
  if (!availableWeight) return { score: null, factors: comparisons, limitation: 'Not enough shared profile information to estimate a score.' };
  const weighted = Object.entries(comparisons).reduce((sum, [key, value]) => sum + (value === null ? 0 : value * INTEREST_WEIGHTS[key]), 0);
  return { score: Math.round((weighted / availableWeight) * 100), factors: comparisons, limitation: 'An estimate based on the profile fields both people provided; it is not a guarantee of relationship quality.' };
}

export function diagnoseSales(state) {
  const revenue = [...state.revenue].sort((a, b) => a.month.localeCompare(b.month));
  const latest = revenue.at(-1); const previous = revenue.at(-2);
  const revenueChangePct = previous ? ((latest.amount - previous.amount) / previous.amount) * 100 : null;
  const open = state.opportunities.filter((deal) => deal.status === 'Open');
  const stalled = open.filter((deal) => (Date.now() - Date.parse(deal.lastContactAt)) / 86400000 >= 14);
  const highValueStalled = stalled.filter((deal) => deal.amount >= 75000).sort((a, b) => b.amount - a.amount);
  const avgOpen = open.length ? open.reduce((sum, deal) => sum + deal.amount, 0) / open.length : 0;
  return {
    revenueChangePct,
    latestRevenue: latest?.amount ?? 0,
    previousRevenue: previous?.amount ?? 0,
    stalled,
    highValueStalled,
    open,
    averageOpenDealSize: avgOpen,
    findings: [
      ...(revenueChangePct !== null && revenueChangePct < 0 ? [{ id: 'revenue-down', label: 'Revenue declined month over month', evidence: `${latest.month} sample revenue is ${Math.abs(revenueChangePct).toFixed(1)}% below ${previous.month}.`, source: 'Sample sales ledger', confidence: 'High for the recorded sample periods', type: 'observed' }] : []),
      ...(stalled.length ? [{ id: 'stalled-followup', label: `${stalled.length} open opportunities have no contact for 14+ days`, evidence: `${highValueStalled.length} of those are valued at $75k or more; ${highValueStalled.map((deal) => deal.account).join(', ') || 'no high-value deals'}.`, source: 'Sample CRM opportunity records', confidence: 'Medium; contact dates show inactivity, not why it happened.', type: 'observed' }] : []),
      { id: 'causation-limit', label: 'Cause is not established', evidence: 'Revenue trend and contact gaps are correlated signals. This sample does not establish that follow-up timing caused the revenue decline.', source: 'Analyst limitation', confidence: 'Not applicable', type: 'limitation' },
    ],
  };
}

export function dashboardMetrics(state, days = 90) {
  const points = [...state.revenue].sort((a, b) => a.month.localeCompare(b.month));
  const buckets = Math.max(1, Math.ceil(days / 30));
  const current = points.slice(-buckets);
  const previous = points.length >= buckets * 2 ? points.slice(-buckets * 2, -buckets) : [];
  const revenue = current.reduce((sum, row) => sum + row.amount, 0);
  const previousRevenue = previous.reduce((sum, row) => sum + row.amount, 0);
  const open = state.opportunities.filter((deal) => deal.status === 'Open');
  const atRisk = open.filter((deal) => (Date.now() - Date.parse(deal.lastContactAt)) / 86400000 >= 14);
  const activeTasks = state.tasks.filter((task) => ['Running', 'Paused', 'Awaiting Approval', 'Approved'].includes(task.status));
  const executed = state.executions.filter((execution) => execution.status === 'Executed');
  const verified = state.verifications.filter((verification) => verification.status === 'Verified').length;
  const failedTools = state.toolInvocations.filter((call) => call.status === 'Failed').length;
  const totalTools = state.toolInvocations.length;
  return {
    days, revenue, previousRevenue: previous.length ? previousRevenue : null,
    revenueChangePct: previous.length ? ((revenue - previousRevenue) / previousRevenue) * 100 : null,
    stalledCount: atRisk.length, atRiskValue: atRisk.reduce((sum, deal) => sum + deal.amount, 0),
    openPipeline: open.reduce((sum, deal) => sum + deal.amount, 0), potentialRecovery: atRisk.reduce((sum, deal) => sum + deal.amount, 0),
    activeTasks: activeTasks.length, completedTasks: state.tasks.filter((task) => task.status === 'Completed').length,
    awaitingApproval: state.actions.filter((action) => action.status === 'Awaiting Approval').length,
    approvedActions: state.actions.filter((action) => action.status === 'Approved').length,
    rejectedActions: state.actions.filter((action) => action.status === 'Rejected').length,
    executedActions: executed.length, failedActions: state.executions.filter((execution) => execution.status === 'Failed').length,
    verifiedActions: verified, inconclusiveActions: state.verifications.filter((verification) => verification.status === 'Inconclusive').length,
    toolFailureRate: totalTools ? failedTools / totalTools : 0,
    recoverySuccessRate: executed.length ? verified / executed.length : 0,
    revenueTrend: points.slice(-6),
  };
}

