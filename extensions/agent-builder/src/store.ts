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
const MAX_ENTRIES = 64;
// Single-draft MVP: the builder chat always edits the active draft.
const ACTIVE_DRAFT_KEY = "active-draft";

export type AgentBuilderStore = {
  getState(): Promise<AgentBuilderState>;
  saveDraft(spec: AgentSpec): Promise<AgentBuilderState>;
  reset(overrides?: { id?: string; name?: string }): Promise<AgentBuilderState>;
  setDeployment(params: {
    status: AgentDeploymentStatus;
    deployedSpec?: AgentSpec;
  }): Promise<AgentBuilderState>;
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
  return { ...record, validation: validateAgentSpec(record.draftSpec) };
}

export function createAgentBuilderStore(openKeyedStore: OpenKeyedStore): AgentBuilderStore {
  const store = () =>
    openKeyedStore<AgentBuilderDraftRecord>({ namespace: NAMESPACE, maxEntries: MAX_ENTRIES });

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
  };
}
