import { randomUUID } from 'node:crypto';
import { passwordHash, DEMO_EMAIL, DEMO_PASSWORD } from './auth.js';

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const monthsAgo = (count) => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - count);
  return date.toISOString().slice(0, 10);
};

export async function createSeedState() {
  const demoId = randomUUID();
  const sampleUser = (name, interests, goals, style, availability, languages, location) => ({
    id: randomUUID(), name, role: 'member', interests, goals, socialStyle: style,
    availability, languages, location, visibility: 'discoverable',
  });
  return {
    version: 1,
    mode: 'demo',
    seededAt: new Date().toISOString(),
    users: [{ id: demoId, email: DEMO_EMAIL, name: 'Alex Morgan', role: 'admin', passwordHash: await passwordHash(DEMO_PASSWORD), createdAt: new Date().toISOString() }],
    sessions: [],
    opportunities: [
      { id: 'opp-blueharbor', account: 'Blue Harbor Logistics', name: 'Network expansion', stage: 'Discovery', amount: 142000, owner: 'Maya Cole', status: 'Open', lastContactAt: daysAgo(32), expectedCloseAt: daysAgo(-24), product: 'Enterprise platform' },
      { id: 'opp-redwood', account: 'Redwood Analytics', name: 'Data platform renewal', stage: 'Negotiation', amount: 96000, owner: 'Jordan Lee', status: 'Open', lastContactAt: daysAgo(25), expectedCloseAt: daysAgo(-18), product: 'Analytics suite' },
      { id: 'opp-solace', account: 'Solace Medical', name: 'Regional rollout', stage: 'Proposal', amount: 128000, owner: 'Maya Cole', status: 'Open', lastContactAt: daysAgo(19), expectedCloseAt: daysAgo(-31), product: 'Healthcare workspace' },
      { id: 'opp-kestrel', account: 'Kestrel Cloud', name: 'Cloud migration', stage: 'Proposal', amount: 74000, owner: 'Sam Patel', status: 'Open', lastContactAt: daysAgo(8), expectedCloseAt: daysAgo(-42), product: 'Cloud migration' },
      { id: 'opp-summit', account: 'Summit Education', name: 'District partnership', stage: 'Qualification', amount: 58000, owner: 'Jordan Lee', status: 'Open', lastContactAt: daysAgo(41), expectedCloseAt: daysAgo(-54), product: 'Education plan' },
      { id: 'opp-cedar', account: 'Cedar Peak Energy', name: 'Portfolio expansion', stage: 'Closed Lost', amount: 112000, owner: 'Sam Patel', status: 'Lost', lastContactAt: daysAgo(67), expectedCloseAt: daysAgo(7), product: 'Enterprise platform' },
      { id: 'opp-juniper', account: 'Juniper Works', name: 'Annual renewal', stage: 'Closed Won', amount: 89000, owner: 'Maya Cole', status: 'Won', lastContactAt: daysAgo(12), expectedCloseAt: daysAgo(21), product: 'Analytics suite' },
      { id: 'opp-aster', account: 'Aster Manufacturing', name: 'Operations pilot', stage: 'Qualification', amount: 43000, owner: 'Jordan Lee', status: 'Open', lastContactAt: daysAgo(16), expectedCloseAt: daysAgo(-63), product: 'Operations suite' },
    ],
    revenue: [
      { id: randomUUID(), month: monthsAgo(5), amount: 1320000, source: 'Sample sales ledger' },
      { id: randomUUID(), month: monthsAgo(4), amount: 1275000, source: 'Sample sales ledger' },
      { id: randomUUID(), month: monthsAgo(3), amount: 1208000, source: 'Sample sales ledger' },
      { id: randomUUID(), month: monthsAgo(2), amount: 1095000, source: 'Sample sales ledger' },
      { id: randomUUID(), month: monthsAgo(1), amount: 982000, source: 'Sample sales ledger' },
      { id: randomUUID(), month: monthsAgo(0), amount: 884000, source: 'Sample sales ledger' },
    ],
    tasks: [], stages: [], evidence: [], toolInvocations: [], actions: [], approvals: [], executions: [], verifications: [],
    events: [], auditLogs: [], notifications: [{ id: randomUUID(), userId: demoId, kind: 'system', title: 'Demo workspace ready', body: 'Sample records are labeled. No external integrations are connected.', createdAt: new Date().toISOString(), readAt: null }],
    profiles: [{ userId: demoId, data: { bio: 'Revenue operations lead exploring better ways to recover stalled deals.', interests: ['Revenue operations', 'AI tools', 'Hiking'], goals: ['Build useful systems', 'Meet thoughtful people'], socialStyle: 'Small groups', availability: 'Weekends', languages: ['English'], location: 'Remote' }, privacy: { discoverable: true, showLocation: false, shareInterests: true }, updatedAt: new Date().toISOString() }],
    friendProfiles: [
      sampleUser('Riley Chen', ['AI tools', 'Cycling', 'Product design'], ['Build useful systems', 'Learn new skills'], 'Small groups', 'Weekends', ['English', 'Mandarin'], 'Remote'),
      sampleUser('Noah Williams', ['Revenue operations', 'Hiking', 'Reading'], ['Meet thoughtful people', 'Build useful systems'], 'One to one', 'Evenings', ['English'], 'Seattle'),
      sampleUser('Priya Nair', ['Startups', 'AI tools', 'Cooking'], ['Learn new skills', 'Explore ideas'], 'Small groups', 'Weekends', ['English', 'Hindi'], 'Remote'),
      sampleUser('Elena García', ['Product design', 'Photography', 'Travel'], ['Explore ideas', 'Meet thoughtful people'], 'Large groups', 'Evenings', ['English', 'Spanish'], 'Austin'),
    ],
    friendRequests: [],
    aiFriends: [],
    aiFriendMessages: [],
    communities: [
      { id: 'community-revops', name: 'Revenue Operators', description: 'Share practical ways to improve pipeline health and customer follow-up.', memberCount: 128, joinedBy: [] },
      { id: 'community-ai', name: 'Responsible AI Builders', description: 'A space for transparent and human-guided AI workflows.', memberCount: 86, joinedBy: [] },
      { id: 'community-hikers', name: 'Weekend Trail Crew', description: 'Plan low-key local hikes and share favorite routes.', memberCount: 54, joinedBy: [] },
    ],
    conversations: [{ id: 'conversation-riley', participantIds: [demoId, 'friend-riley'], title: 'Riley Chen' }],
    messages: [{ id: randomUUID(), conversationId: 'conversation-riley', senderId: 'friend-riley', senderName: 'Riley Chen', body: 'Hi Alex — I saw your interest in responsible AI workflows. What are you working on lately?', createdAt: new Date().toISOString() }],
    sideEffects: [],
    settings: { demoMode: true, databaseMode: process.env.DATABASE_URL ? 'postgres' : 'file', aiProvider: process.env.AI_API_URL ? 'configured' : 'rules-engine' },
  };
}
