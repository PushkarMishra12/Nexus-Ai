import { createHash, randomUUID } from 'node:crypto';

export const canonicalize = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const hashAction = (action) => sha256(canonicalize({ type: action.type, targetId: action.targetId, params: action.params, verificationCriteria: action.verificationCriteria }));
export function appendEvent(state, event) {
  const body = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'Completed', ...event };
  const previousHash = state.events.at(-1)?.integrityHash ?? 'GENESIS';
  const integrityHash = sha256(`${previousHash}|${canonicalize(body)}`);
  const record = { ...body, previousHash, integrityHash };
  state.events.push(record);
  return record;
}
export function verifyEventChain(events) {
  let previousHash = 'GENESIS';
  const results = [];
  for (const event of events) {
    const { previousHash: actualPrevious, integrityHash, ...body } = event;
    const expected = sha256(`${previousHash}|${canonicalize(body)}`);
    const valid = actualPrevious === previousHash && integrityHash === expected;
    results.push({ id: event.id, valid, expected, actual: integrityHash, expectedPrevious: previousHash, actualPrevious });
    if (!valid) return { valid: false, checked: results.length, results };
    previousHash = integrityHash;
  }
  return { valid: true, checked: results.length, results };
}
export const safeUser = ({ passwordHash, ...user }) => user;
