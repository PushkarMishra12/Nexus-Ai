# NexusAI — From Lost Revenue to Verified Recovery

NexusAI is a recovery-first sales teammate. It investigates the seeded sales ledger and sample CRM records, shows the evidence behind its findings, proposes prioritized actions, waits for a human decision, and records sandbox execution and verification.

The workspace is **Demo Mode** by default. It does not connect to a live CRM, email provider, calendar, or finance system. Sample revenue and deal values are labeled, and an approved email is written only to a sandbox mailbox.

## Start locally

Requirements: Node.js 20+ and npm.

    cd outputs/nexusai
    npm install
    Copy-Item .env.example .env
    npm run dev

Open http://localhost:4173.

Demo sign-in:

- Email: demo@nexusai.local
- Password: NexusDemo!27

The local demo creates data/nexusai.json on first start. It persists tasks, stages, evidence, tool invocations, proposals, approvals, executions, verifications, social records, and the Flight Recorder event chain. npm run seed creates this data when it is missing; it preserves an existing data file.

## Guided recovery walkthrough

1. Sign in and inspect the seeded revenue trend and stalled opportunities.
2. Open AI Workspace and use the suggested investigation or the pre-filled objective.
3. Leave “Include guided sandbox outcomes” enabled to see a verified mailbox receipt, an accepted but inconclusive CRM action, and a controlled calendar failure.
4. Inspect the evidence and exact parameters in the prioritized plan.
5. Reject one proposal. NexusAI records the rejection and the backend blocks execution.
6. Approve the follow-up email, then select “Execute approved action”. The adapter records a sandbox mailbox receipt; it sends no external email.
7. Approve the CRM stage request to see an Executed response with an Inconclusive verification, because no authoritative CRM is connected.
8. For the recovery branch, approve the calendar proposal. The guided demo injects a timeout, records the failure, and creates a new approval request for a draft-only alternative. Approve and execute that alternative to create a sandbox draft; no message is sent.
9. Open Recovery Flight Recorder to review the full event sequence, verify the SHA-256 chain, and export JSON or a readable report.

Unchecking the guided scenario does not connect a real calendar. The calendar proposal will fail visibly with ADAPTER_UNAVAILABLE, and a draft-only alternative still requires a separate approval.

## Architecture

    React + Vite UI
          │ same-origin JSON API
          ▼
    Express API ── session and record authorization
          │
          ├── Registered Zod tool registry
          ├── Bounded 12-call agent workflow
          ├── Rule-based sales diagnosis
          ├── Optional structured LLM adapter
          ├── Approval-bound sandbox executor
          ├── Verification and SHA-256 Flight Recorder
          └── Social discovery, messaging, and communities
          │
          ├── Local demo: atomic JSON file
          └── PostgreSQL mode: transactional JSONB state snapshot

### Runtime and persistence

- Local mode is the default and stores one canonical state document in DATA_FILE (default data/nexusai.json).
- PostgreSQL mode is enabled by setting DATABASE_URL; startup runs SQL migrations and uses the system_state JSONB row as the canonical transactional state. The migration also defines normalized entity tables for the next extraction step, but the current runtime does not dual-write them.
- The application deliberately keeps one source of truth in each mode. It does not copy the same tasks into browser storage.
- The local store uses an in-process serialized write queue and atomic file replacement. Use PostgreSQL when multiple server instances or concurrent production writers are required.

### Agent lifecycle and safety

The agent records all 12 stages. It uses read-only registered tools for investigation, validates tool inputs with Zod, has a 12-call per-task ceiling, supports cancellation, pause/resume, and retry as a new task, and stops at human review. The optional OpenAI-compatible provider is configured with AI_API_URL, AI_API_KEY, and AI_MODEL; when unset, the deterministic rules engine is active. Provider output is schema-validated and only the concise summary is shown.

Every proposed action has a SHA-256 hash over its type, target, parameters, and verification criteria. The backend rechecks that hash, the action owner, approval state, and expiry immediately before execution. Rejected or changed actions cannot execute. Execution is a separate click after approval. Duplicate execution is rejected.

The Flight Recorder links each event hash to its predecessor. Hashes can help detect edits to the recorded payload; they do not independently prove that an external action occurred.

### AI Friends

Create private AI companions with a name, support need, personality, reply style, and boundaries. Chats are stored per account. When AI_API_URL is configured, replies use that OpenAI-compatible provider; otherwise the app uses clearly labeled local demo replies tailored to the companion setup. Chat content is sent to the configured provider when one is enabled. Companions identify themselves as AI and are not presented as human or professional care providers.

### Authentication and security

- Passwords are stored as Node scrypt hashes; session tokens are cryptographically random, stored by SHA-256 digest, and delivered in HttpOnly cookies.
- Cookies use SameSite=Lax; production cookies use Secure.
- The API applies basic security headers, request-size limits, login/registration rate limits, Zod validation, and record ownership checks.
- Admin telemetry requires the admin role and excludes message bodies.
- The included demo admin account is for local demonstration only. Replace or remove it before any shared deployment.

## PostgreSQL setup

1. Create a PostgreSQL database.
2. Set DATABASE_URL in .env and optionally set PGSSL=true.
3. Run npm run migrate once, or start the application (startup applies pending migrations).
4. Run npm run seed to initialize the JSONB state row if needed.
5. Start with npm run dev or npm start.

PostgreSQL is not required for the hackathon demo. This environment did not include a local PostgreSQL server, so PostgreSQL migrations were not executed here.

## API

The API uses same-origin JSON and the session cookie. Key routes:

| Method | Route | Purpose |
|---|---|---|
| GET | /api/health | Runtime and persistence mode |
| GET | /api/session | Current user and demo credentials |
| POST | /api/login or /api/register | Start a server-managed session |
| POST | /api/logout | Revoke the current session |
| GET | /api/dashboard?days=30,90,180 | Derived metrics, activity, and task summaries |
| GET | /api/opportunities | Search/filter sample sales records |
| GET / POST | /api/tasks | List tasks or submit an investigation |
| GET | /api/tasks/:id | Stages, evidence, tool calls, actions, approvals, execution, verification, events |
| POST | /api/tasks/:id/pause, resume, cancel, retry | Workflow controls |
| GET | /api/approvals | Approval queue and decision history |
| POST | /api/approvals/:id/decision | approve, reject, or cancel |
| POST | /api/actions/:id/execute | Execute a currently approved action once |
| GET | /api/flight-recorder | Search and filter visible event traces |
| GET | /api/flight-recorder/:id | Task trace and chain integrity |
| GET | /api/flight-recorder/:id/export?format=json or report | Download JSON or readable text |
| GET | /api/telemetry | Admin-only aggregate system telemetry |
| GET | /api/tools | Registered tool metadata, permissions, input/output schemas |
| GET / POST | /api/ai-friends | Create and list account-owned AI companions |
| GET / POST | /api/ai-friends/:id/messages | Read private history or request a personalized reply |
| GET / POST | /api/discovery, /api/friend-requests | Opt-in recommendations and demo requests |
| GET / POST | /api/conversations, /api/conversations/:id/messages | Participant-scoped messages |
| GET / POST | /api/communities | Community listing and join/leave |
| GET / PATCH | /api/profile, /api/privacy | Profile and privacy preferences |
| GET / POST | /api/notifications | List and mark notifications read |
| GET | /api/settings | Runtime configuration and tool registry |

Full OpenAPI description: api/openapi.yaml.

## Build and tests

    npm run build
    npm test

The Node test suite covers metric and diagnosis calculations, compatibility weights, tool validation and call logging, event hash integrity, AI friend persona validation and local replies, authentication, record ownership, AI friend chat ownership, approval rejection, parameter binding, duplicate execution, verified/inconclusive/failed outcomes, recovery approval, pause/resume, and persistence after reopening the store.

Latest verified results in this workspace:

- npm run build — passed.
- node --test tests/domain.test.js — 7 tests passed, 0 failed.
- The full HTTP end-to-end test could not connect to its ephemeral loopback server in this restricted workspace (EACCES). Run npm test in a local environment with loopback access.
- PostgreSQL migrations — not run; no local PostgreSQL service was available.

## Known limitations

- All business data and side effects in the demo are sample/sandbox records. No real sales outcomes or live integrations are claimed.
- The PostgreSQL adapter currently stores the complete application state in one JSONB row. The normalized migration tables are present as a foundation and are not yet the runtime write path.
- The optional LLM provider was not configured in this environment. AI Friends use labeled local replies until AI_API_URL, AI_API_KEY, and AI_MODEL are configured.
- Friendship recommendations use seeded profiles and are estimates. Demo friend requests go to a local outbox; they do not notify real users.
- The demo admin credential must be changed/removed for any shared deployment.
