// Draft AgentSpec store on plugin KV. One active draft for the MVP; the
// record keeps the last deployed spec + status so the UI side panel and the
// deploy adapter (later milestone) share a single source of truth.
import {
  createDefaultAgentSpec,
  validateAgentSpec,
  type AgentDeploymentStatus,
  type AgentSpec,
  type AgentSpecValidationResult,
} from "@openclaw/agent-spec";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export type AgentBuilderDraftRecord = {
  version: number;
  draftSpec: AgentSpec;
  lastDeployedSpec?: AgentSpec;
  deploymentStatus: AgentDeploymentStatus;
  createdAt: number;
  updatedAt: number;
};

export type AgentBuilderState = AgentBuilderDraftRecord & {
  validation: AgentSpecValidationResult;
};

const NAMESPACE = "agent-builder-drafts";
const LEARNING_NAMESPACE = "agent-builder-learning";
const MAX_ENTRIES = 64;
// Single-draft MVP: the builder chat always edits the active draft.
const ACTIVE_DRAFT_KEY = "active-draft";
const LEARNING_LOG_KEY = "active-log";
// The learning log lives in one KV value (64KB budget); cap count and text
// size so long test sessions cannot push it over the limit.
const MAX_LEARNING_EXCHANGES = 15;
const MAX_LEARNING_USER_CHARS = 1500;
const MAX_LEARNING_AGENT_CHARS = 3000;

export type LearningExchange = {
  at: number;
  user: string;
  agent: string;
  /** A2A task state of the reply ("completed" | "failed"). */
  state: string;
};

export type LearningLogRecord = {
  agentId: string;
  exchanges: LearningExchange[];
  updatedAt: number;
};

export type AgentBuilderStore = {
  getState(): Promise<AgentBuilderState>;
  saveDraft(spec: AgentSpec): Promise<AgentBuilderState>;
  reset(overrides?: { id?: string; name?: string }): Promise<AgentBuilderState>;
  setDeployment(params: {
    status: AgentDeploymentStatus;
    deployedSpec?: AgentSpec;
  }): Promise<AgentBuilderState>;
  appendLearningExchange(entry: {
    agentId: string;
    user: string;
    agent: string;
    state: string;
  }): Promise<LearningLogRecord>;
  getLearningLog(): Promise<LearningLogRecord | undefined>;
  clearLearningLog(): Promise<void>;
};

type OpenKeyedStore = <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;

function freshRecord(overrides?: { id?: string; name?: string }): AgentBuilderDraftRecord {
  const now = Date.now();
  return {
    version: 1,
    draftSpec: createDefaultAgentSpec(overrides),
    deploymentStatus: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

function withValidation(record: AgentBuilderDraftRecord): AgentBuilderState {
  const validation = validateAgentSpec(record.draftSpec);
  // Reading re-parses through the schema so stored drafts from older spec
  // versions pick up new defaulted fields before anything consumes them. The
  // deployed snapshot gets the same treatment, otherwise a new defaulted field
  // makes draft-vs-deployed comparisons report a phantom difference.
  const deployedValidation = record.lastDeployedSpec
    ? validateAgentSpec(record.lastDeployedSpec)
    : undefined;
  return {
    ...record,
    draftSpec: validation.ok ? validation.spec : record.draftSpec,
    ...(deployedValidation?.ok ? { lastDeployedSpec: deployedValidation.spec } : {}),
    validation,
  };
}

export function createAgentBuilderStore(openKeyedStore: OpenKeyedStore): AgentBuilderStore {
  const store = () =>
    openKeyedStore<AgentBuilderDraftRecord>({ namespace: NAMESPACE, maxEntries: MAX_ENTRIES });
  const learningStore = () =>
    openKeyedStore<LearningLogRecord>({ namespace: LEARNING_NAMESPACE, maxEntries: MAX_ENTRIES });

  async function readOrCreate(): Promise<AgentBuilderDraftRecord> {
    const existing = await store().lookup(ACTIVE_DRAFT_KEY);
    if (existing) {
      return existing;
    }
    const record = freshRecord();
    await store().register(ACTIVE_DRAFT_KEY, record);
    return record;
  }

  async function write(record: AgentBuilderDraftRecord): Promise<AgentBuilderState> {
    await store().register(ACTIVE_DRAFT_KEY, record);
    return withValidation(record);
  }

  return {
    async getState() {
      return withValidation(await readOrCreate());
    },
    async saveDraft(spec) {
      const current = await readOrCreate();
      return write({
        ...current,
        draftSpec: spec,
        version: current.version + 1,
        updatedAt: Date.now(),
      });
    },
    async reset(overrides) {
      // A fresh draft is a different agent; stale test observations would
      // mislead the builder, so the learning log resets with it.
      await learningStore().delete(LEARNING_LOG_KEY);
      return write(freshRecord(overrides));
    },
    async setDeployment({ status, deployedSpec }) {
      const current = await readOrCreate();
      return write({
        ...current,
        deploymentStatus: status,
        ...(deployedSpec ? { lastDeployedSpec: deployedSpec } : {}),
        updatedAt: Date.now(),
      });
    },
    async appendLearningExchange(entry) {
      const existing = await learningStore().lookup(LEARNING_LOG_KEY);
      // Observations follow the agent under test: switching agents starts a
      // fresh log instead of mixing transcripts from different agents.
      const base =
        existing && existing.agentId === entry.agentId
          ? existing
          : { agentId: entry.agentId, exchanges: [], updatedAt: 0 };
      const record: LearningLogRecord = {
        agentId: entry.agentId,
        exchanges: [
          ...base.exchanges,
          {
            at: Date.now(),
            user: entry.user.slice(0, MAX_LEARNING_USER_CHARS),
            agent: entry.agent.slice(0, MAX_LEARNING_AGENT_CHARS),
            state: entry.state,
          },
        ].slice(-MAX_LEARNING_EXCHANGES),
        updatedAt: Date.now(),
      };
      await learningStore().register(LEARNING_LOG_KEY, record);
      return record;
    },
    async getLearningLog() {
      return await learningStore().lookup(LEARNING_LOG_KEY);
    },
    async clearLearningLog() {
      await learningStore().delete(LEARNING_LOG_KEY);
    },
  };
}
