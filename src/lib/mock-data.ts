import type {
  Chat,
  Decision,
  Document,
  MemoryEntry,
  Message,
  Project,
  TimelineEvent,
  Workspace,
} from "./types";

/*
 * Seed data. There is no backend yet, so the whole app runs against this.
 * It follows the PRD's own examples: the workspace tree (Atimo / Inserium /
 * Personal / Research), the per-model chats, and the Postgres -> Supabase
 * migration arc used in the Timeline section.
 */

const d = (day: number) =>
  new Date(Date.UTC(2026, 6, day, 9 + (day % 7), 12)).toISOString();

export const WORKSPACES: Workspace[] = [
  { id: "ws-inserium", name: "Inserium" },
  { id: "ws-personal", name: "Personal" },
];

/*
 * Each project ships with a base context, because that field is the product
 * thesis in one place: the same brief reaches Claude, GPT and Gemini, and none
 * of them had to be told twice. An empty one on first run would leave the whole
 * feature looking like a text box nobody filled in.
 */
export const PROJECTS: Project[] = [
  {
    id: "p-atimo",
    workspaceId: "ws-inserium",
    name: "Atimo",
    description: "ContextOS — the shared knowledge layer across models.",
    instructions: `Atimo is a desktop AI workspace: Tauri 2, React 19, Vite, Tailwind 4, TypeScript. The Rust side owns credentials, SQLite and provider streaming; the webview owns the domain model.

Working agreements for this project:
- Models are interchangeable and knowledge is permanent. Never propose a design that couples project knowledge to one vendor's API.
- One seam per concern. Storage, provider transport and retrieval each have exactly one module that knows the outside world.
- Explain trade-offs before code. A patch with no stated alternative reads as the only option, and it never is.`,
    memoryTokens: 18_420,
  },
  {
    id: "p-inserium",
    workspaceId: "ws-inserium",
    name: "Inserium",
    description: "Agency site, client pipeline, internal tooling.",
    instructions: `Client-facing agency work. Copy is in Brazilian Portuguese unless a page is explicitly for an international client; code and commits stay in English.

Keep proposals costed: every recommendation names roughly how long it takes, because the answer goes into a quote.`,
    memoryTokens: 6_180,
  },
  {
    id: "p-research",
    workspaceId: "ws-inserium",
    name: "Research",
    description: "Embedding benchmarks, retrieval papers, model evals.",
    instructions: `Evaluation work. Numbers carry their method or they do not count: state the dataset, the metric and the sample size next to any figure, and say when a result is a single run rather than a mean.

Prefer being wrong out loud to being vague. If a benchmark does not support a claim, say which one would.`,
    memoryTokens: 9_940,
  },
  {
    id: "p-personal",
    workspaceId: "ws-personal",
    name: "Personal",
    description: "Side projects and reading notes.",
    instructions: "",
    memoryTokens: 2_310,
  },
];

export const CHATS: Chat[] = [
  {
    id: "c-arch",
    projectId: "p-atimo",
    title: "Architecture",
    modelId: "claude-opus-5",
    createdAt: d(1),
    updatedAt: d(12),
  },
  {
    id: "c-backend",
    projectId: "p-atimo",
    title: "Claude Backend",
    modelId: "claude-sonnet-5",
    createdAt: d(2),
    updatedAt: d(11),
  },
  {
    id: "c-frontend",
    projectId: "p-atimo",
    title: "GPT Frontend",
    modelId: "gpt-5.6-sol",
    createdAt: d(3),
    updatedAt: d(10),
  },
  {
    id: "c-security",
    projectId: "p-atimo",
    title: "Security review",
    modelId: "gemini-3.1-pro",
    createdAt: d(8),
    updatedAt: d(9),
  },
  {
    id: "c-perf",
    projectId: "p-atimo",
    title: "Retrieval performance",
    modelId: "deepseek-v4-pro",
    createdAt: d(9),
    updatedAt: d(12),
  },
  {
    id: "c-backend-fork",
    projectId: "p-atimo",
    title: "Claude Backend (fork)",
    modelId: "gpt-5.6-sol",
    createdAt: d(11),
    updatedAt: d(11),
    forkedFrom: { chatId: "c-backend", messageId: "m-backend-2" },
  },
  {
    id: "c-site",
    projectId: "p-inserium",
    title: "Landing copy",
    modelId: "claude-opus-5",
    createdAt: d(4),
    updatedAt: d(7),
  },
  {
    id: "c-embed",
    projectId: "p-research",
    title: "Embedding benchmark",
    modelId: "gemini-3.1-pro",
    createdAt: d(5),
    updatedAt: d(12),
  },
];

export const MESSAGES: Message[] = [
  {
    id: "m-arch-1",
    chatId: "c-arch",
    role: "user",
    content:
      "We need to pick the storage layer for the context engine. Requirements: vector search, relational joins for the knowledge graph, and something we can self-host later.",
    createdAt: d(1),
  },
  {
    id: "m-arch-2",
    chatId: "c-arch",
    role: "assistant",
    modelId: "claude-opus-5",
    createdAt: d(1),
    usage: { in: 1_240, out: 880, latencyMs: 4_120 },
    content: `Use **PostgreSQL with pgvector** for the MVP.

The requirements pull in opposite directions — a dedicated vector DB gives you
better ANN performance, a relational DB gives you the joins the knowledge graph
needs. Postgres with pgvector is the only option that does both without a second
system to operate.

- \`chunks\` table holds embeddings, HNSW index on the vector column
- entity/edge tables model the graph, joined against chunks by \`project_id\`
- migrate to Qdrant only when recall@10 degrades past ~2M chunks per project

The cost of being wrong here is low: the retrieval layer sits behind an
interface, so swapping the backing store later is a contained change.`,
  },
  {
    id: "m-backend-1",
    chatId: "c-backend",
    role: "user",
    content:
      "Design the reference resolver. It has to expand @chat(), @document() and @decision() into actual context before the prompt hits the model.",
    createdAt: d(2),
  },
  {
    id: "m-backend-2",
    chatId: "c-backend",
    role: "assistant",
    modelId: "claude-sonnet-5",
    createdAt: d(2),
    usage: { in: 2_100, out: 1_340, latencyMs: 5_600 },
    content: `Resolve in four passes, each one cheap enough to run on every keystroke
except the last.

1. **Parse** — regex over the raw prompt produces \`{kind, target, span}\`.
2. **Bind** — match each target against the project index. Unbound references
   stay in the prompt as literal text; never silently drop one.
3. **Fetch** — pull the underlying rows. \`@chat()\` returns the rolling summary,
   not the transcript. That single choice is where most of the token savings
   come from.
4. **Dedupe** — hash the fetched chunks; two references to the same decision
   collapse into one.

The resolver returns chunks rather than a string, so the token optimizer
downstream can drop individual chunks by score.`,
  },
  {
    id: "m-frontend-1",
    chatId: "c-frontend",
    role: "user",
    content:
      "How should the composer render references inline? Notion-style pills, or leave the raw @chat(\"…\") text visible?",
    createdAt: d(3),
  },
  {
    id: "m-frontend-2",
    chatId: "c-frontend",
    role: "assistant",
    modelId: "gpt-5.6-sol",
    createdAt: d(3),
    usage: { in: 940, out: 620, latencyMs: 2_800 },
    content: `Keep the raw text, style it in place.

Pills are the obvious move but they fight the editor: you need custom
selection handling, backspace becomes ambiguous, and copy/paste loses the
reference. Since the syntax is already readable, syntax-highlighting it gives
you 90% of the affordance for none of the complexity.

Show resolution state through color: bound references get the accent, unbound
ones stay default-colored with a dim underline. The user finds out about a typo
before sending, not after.`,
  },
  {
    id: "m-security-1",
    chatId: "c-security",
    role: "user",
    content:
      "Review the auth model. Workspaces are shared, but project memory can contain secrets pulled from chats.",
    createdAt: d(8),
  },
  {
    id: "m-security-2",
    chatId: "c-security",
    role: "assistant",
    modelId: "gemini-3.1-pro",
    createdAt: d(8),
    usage: { in: 3_400, out: 1_100, latencyMs: 3_900 },
    content: `Auth needs a redesign before team collaboration ships.

The current model authorizes at the workspace boundary, but retrieval happens at
the project boundary — a member of the workspace can pull project memory they
were never granted. Fix the direction of the check: scope every retrieval query
by the caller's project grants, in SQL, not in application code.

Secondary: memory entries distilled from chats inherit no redaction. Anything a
model saw, memory can replay into another model's prompt. Add a redaction pass
between distillation and storage.`,
  },
];

export const MEMORY: MemoryEntry[] = [
  {
    id: "mem-1",
    projectId: "p-atimo",
    kind: "architecture",
    title: "Postgres + pgvector for MVP retrieval",
    body: "Single store for embeddings and graph edges. HNSW index on chunks.vector. Qdrant deferred until recall degrades past ~2M chunks/project.",
    sourceChatId: "c-arch",
    createdAt: d(1),
    hits: 34,
  },
  {
    id: "mem-2",
    projectId: "p-atimo",
    kind: "architecture",
    title: "@chat() resolves to summary, not transcript",
    body: "The reference resolver fetches the rolling summary for chat references. Full transcripts only on explicit @message().",
    sourceChatId: "c-backend",
    createdAt: d(2),
    hits: 61,
  },
  {
    id: "mem-3",
    projectId: "p-atimo",
    kind: "standard",
    title: "Retrieval scoped in SQL, never in app code",
    body: "Every retrieval query filters by the caller's project grants at the database layer. Application-level filtering is treated as a bug.",
    sourceChatId: "c-security",
    createdAt: d(8),
    hits: 12,
  },
  {
    id: "mem-4",
    projectId: "p-atimo",
    kind: "library",
    title: "Voyage AI for embeddings",
    body: "voyage-3 for code and prose. Reranking with voyage-rerank-2 before the token optimizer runs.",
    sourceChatId: "c-embed",
    createdAt: d(5),
    hits: 22,
  },
  {
    id: "mem-5",
    projectId: "p-atimo",
    kind: "glossary",
    title: "Chunk vs. Reference vs. Injection",
    body: "Chunk = a retrievable unit. Reference = an @-expression in a prompt. Injection = a chunk that survived the optimizer and reached the model.",
    createdAt: d(6),
    hits: 8,
  },
  {
    id: "mem-6",
    projectId: "p-atimo",
    kind: "business-rule",
    title: "Token budget is 30% of the model context window",
    body: "The optimizer never fills more than 30% of the target model's window with injected context, leaving room for the conversation itself.",
    sourceChatId: "c-perf",
    createdAt: d(9),
    hits: 47,
  },
  {
    id: "mem-7",
    projectId: "p-atimo",
    kind: "api",
    title: "POST /v1/compose",
    body: "Takes {prompt, projectId, modelId}, returns {finalPrompt, chunks[], tokens}. The pipeline is never exposed to the client as separate calls.",
    sourceChatId: "c-backend",
    createdAt: d(3),
    hits: 19,
  },
];

export const DECISIONS: Decision[] = [
  {
    id: "dec-1",
    projectId: "p-atimo",
    title: "Use PostgreSQL with pgvector",
    reason:
      "Only option satisfying vector search and relational graph joins without operating a second datastore.",
    alternatives: ["Qdrant + Postgres", "Pinecone", "SQLite + sqlite-vec"],
    date: d(1),
    participants: ["claude-opus-5", "Antonio"],
    affectedFiles: ["packages/db/schema.ts", "services/retrieval/index.ts"],
    sourceChatId: "c-arch",
  },
  {
    id: "dec-2",
    projectId: "p-atimo",
    title: "Move Postgres to Supabase",
    reason:
      "Managed pgvector, auth primitives, and storage in one vendor. Removes two weeks of infra work from the MVP.",
    alternatives: ["Self-hosted on Fly.io", "Neon + Clerk", "Railway"],
    date: d(5),
    participants: ["gpt-5.6-sol", "Antonio"],
    affectedFiles: ["infra/", "packages/db/client.ts", ".env.example"],
    sourceChatId: "c-arch",
    supersedes: "dec-1",
  },
  {
    id: "dec-3",
    projectId: "p-atimo",
    title: "Scope retrieval by project grants in SQL",
    reason:
      "Workspace-level authorization let members read project memory they were never granted. The check has to live where the query runs.",
    alternatives: ["Middleware filter", "Row-level security policies only"],
    date: d(8),
    participants: ["gemini-3.1-pro", "Antonio"],
    affectedFiles: ["services/retrieval/query.ts", "packages/db/policies.sql"],
    sourceChatId: "c-security",
  },
  {
    id: "dec-4",
    projectId: "p-atimo",
    title: "References render as highlighted text, not pills",
    reason:
      "Pills require custom selection and break copy/paste. Highlighting the existing syntax gives the same affordance with no editor complexity.",
    alternatives: ["Notion-style inline pills", "Sidebar chip list"],
    date: d(3),
    participants: ["gpt-5.6-sol", "Antonio"],
    affectedFiles: ["src/components/chat/Composer.tsx"],
    sourceChatId: "c-frontend",
  },
];

export const TIMELINE: TimelineEvent[] = [
  {
    id: "t-1",
    projectId: "p-atimo",
    date: d(1),
    modelId: "claude-opus-5",
    summary: "Use PostgreSQL",
    kind: "decision",
    refId: "dec-1",
  },
  {
    id: "t-2",
    projectId: "p-atimo",
    date: d(2),
    modelId: "claude-sonnet-5",
    summary: "Reference resolver designed — four passes, chunk output",
    kind: "chat",
    refId: "c-backend",
  },
  {
    id: "t-3",
    projectId: "p-atimo",
    date: d(3),
    modelId: "gpt-5.6-sol",
    summary: "References render as highlighted text",
    kind: "decision",
    refId: "dec-4",
  },
  {
    id: "t-4",
    projectId: "p-atimo",
    date: d(5),
    modelId: "gpt-5.6-sol",
    summary: "Move to Supabase",
    kind: "decision",
    refId: "dec-2",
  },
  {
    id: "t-5",
    projectId: "p-atimo",
    date: d(8),
    modelId: "gemini-3.1-pro",
    summary: "Auth needs redesign",
    kind: "decision",
    refId: "dec-3",
  },
  {
    id: "t-6",
    projectId: "p-atimo",
    date: d(11),
    modelId: "gpt-5.6-sol",
    summary: "Forked Claude Backend to compare resolver strategies",
    kind: "fork",
    refId: "c-backend-fork",
  },
  {
    id: "t-7",
    projectId: "p-atimo",
    date: d(12),
    modelId: "claude-opus-5",
    summary: "Migration completed",
    kind: "chat",
    refId: "c-arch",
  },
];

export const DOCUMENTS: Document[] = [
  {
    id: "doc-1",
    projectId: "p-atimo",
    name: "Requirements",
    kind: "markdown",
    tokens: 4_200,
    updatedAt: d(2),
    excerpt:
      "Functional requirements for the context engine, retrieval SLOs, and the reference grammar.",
  },
  {
    id: "doc-2",
    projectId: "p-atimo",
    name: "PRD",
    kind: "markdown",
    tokens: 6_800,
    updatedAt: d(1),
    excerpt:
      "One workspace. Every AI. Shared intelligence. Vision, scope, and MVP boundary.",
  },
  {
    id: "doc-3",
    projectId: "p-atimo",
    name: "schema.sql",
    kind: "code",
    tokens: 2_100,
    updatedAt: d(9),
    excerpt: "chunks, entities, edges, memory_entries, decisions.",
  },
  {
    id: "doc-4",
    projectId: "p-research",
    name: "Embedding eval",
    kind: "markdown",
    tokens: 3_400,
    updatedAt: d(12),
    excerpt: "recall@10 across voyage-3, text-embedding-3-large, and gemini-embed.",
  },
];
