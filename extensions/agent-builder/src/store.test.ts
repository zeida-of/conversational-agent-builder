import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { createAgentGitOps } from "./gitops.ts";
import { createAgentBuilderStore } from "./store.ts";
import { createAgentBuilderTools } from "./tools.ts";

function createMemoryKeyedStore(): <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T> {
  const namespaces = new Map<string, Map<string, unknown>>();
  return <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
    const entries =
      namespaces.get(options.namespace) ??
      namespaces.set(options.namespace, new Map()).get(options.namespace)!;
    return {
      async register(key, value) {
        entries.set(key, value);
      },
      async registerIfAbsent(key, value) {
        if (entries.has(key)) {
          return false;
        }
        entries.set(key, value);
        return true;
      },
      async lookup(key) {
        return entries.get(key) as T | undefined;
      },
      async consume(key) {
        const value = entries.get(key) as T | undefined;
        entries.delete(key);
        return value;
      },
      async delete(key) {
        return entries.delete(key);
      },
      async entries() {
        return [...entries.entries()].map(([key, value]) => ({
          key,
          value: value as T,
          createdAt: 0,
        }));
      },
      async clear() {
        entries.clear();
      },
    };
  };
}

describe("agent-builder store", () => {
  it("creates a valid default draft on first read", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const state = await store.getState();
    expect(state.version).toBe(1);
    expect(state.deploymentStatus).toBe("draft");
    expect(state.validation.ok).toBe(true);
  });

  it("bumps the version on save and persists the draft", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const initial = await store.getState();
    const edited = structuredClone(initial.draftSpec);
    edited.agent.name = "Support Agent";
    const saved = await store.saveDraft(edited);
    expect(saved.version).toBe(2);
    const reread = await store.getState();
    expect(reread.draftSpec.agent.name).toBe("Support Agent");
  });

  it("reset produces a fresh draft with overrides", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    await store.getState();
    const state = await store.reset({ id: "support-agent", name: "Support Agent" });
    expect(state.version).toBe(1);
    expect(state.draftSpec.agent.id).toBe("support-agent");
    expect(state.validation.ok).toBe(true);
  });

  it("normalizes stored drafts from older schema versions on read", async () => {
    const openKeyedStore = createMemoryKeyedStore();
    const seeded = createAgentBuilderStore(openKeyedStore);
    const initial = await seeded.getState();
    // Simulate an M2-era record persisted before the knowledge field existed.
    const stale = structuredClone(initial.draftSpec) as { agent: { knowledge?: unknown } };
    delete stale.agent.knowledge;
    await openKeyedStore<Record<string, unknown>>({
      namespace: "agent-builder-drafts",
      maxEntries: 64,
    }).register("active-draft", {
      version: 3,
      draftSpec: stale,
      deploymentStatus: "draft",
      createdAt: 0,
      updatedAt: 0,
    });
    const state = await createAgentBuilderStore(openKeyedStore).getState();
    expect(state.validation.ok).toBe(true);
    expect(state.draftSpec.agent.knowledge).toEqual([]);
  });

  it("tracks deployment status and last deployed spec", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const { draftSpec } = await store.getState();
    const state = await store.setDeployment({ status: "running", deployedSpec: draftSpec });
    expect(state.deploymentStatus).toBe("running");
    expect(state.lastDeployedSpec?.agent.id).toBe(draftSpec.agent.id);
  });

  it("defaults skills for drafts stored before the field existed", async () => {
    const openKeyedStore = createMemoryKeyedStore();
    const initial = await createAgentBuilderStore(openKeyedStore).getState();
    const stale = structuredClone(initial.draftSpec) as { agent: { skills?: unknown } };
    delete stale.agent.skills;
    await openKeyedStore<Record<string, unknown>>({
      namespace: "agent-builder-drafts",
      maxEntries: 64,
    }).register("active-draft", {
      version: 2,
      draftSpec: stale,
      deploymentStatus: "draft",
      createdAt: 0,
      updatedAt: 0,
    });
    const state = await createAgentBuilderStore(openKeyedStore).getState();
    expect(state.validation.ok).toBe(true);
    expect(state.draftSpec.agent.skills).toEqual([]);
  });
});

describe("learning log", () => {
  it("appends exchanges, caps the log, and restarts per agent", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    for (let i = 0; i < 20; i += 1) {
      await store.appendLearningExchange({
        agentId: "store-helper",
        user: `question ${i}`,
        agent: `answer ${i}`,
        state: "completed",
      });
    }
    const log = await store.getLearningLog();
    expect(log?.agentId).toBe("store-helper");
    expect(log?.exchanges).toHaveLength(15);
    expect(log?.exchanges.at(-1)?.user).toBe("question 19");

    // A different agent under test starts a fresh log.
    await store.appendLearningExchange({
      agentId: "faq-bot",
      user: "hello",
      agent: "hi",
      state: "completed",
    });
    const switched = await store.getLearningLog();
    expect(switched?.agentId).toBe("faq-bot");
    expect(switched?.exchanges).toHaveLength(1);
  });

  it("clears explicitly and on draft reset", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    await store.appendLearningExchange({
      agentId: "store-helper",
      user: "q",
      agent: "a",
      state: "completed",
    });
    await store.clearLearningLog();
    expect(await store.getLearningLog()).toBeUndefined();

    await store.appendLearningExchange({
      agentId: "store-helper",
      user: "q",
      agent: "a",
      state: "completed",
    });
    await store.reset({ id: "new-agent" });
    expect(await store.getLearningLog()).toBeUndefined();
  });
});

describe("agent-builder tools", () => {
  async function runTool(
    tools: ReturnType<typeof createAgentBuilderTools>,
    name: string,
    params: unknown,
  ) {
    const tool = tools.find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    return await tool!.execute("call-1", params as never, undefined, undefined);
  }

  it("patch_agent_spec applies edits and persists", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const tools = createAgentBuilderTools(store);
    const result = await runTool(tools, "patch_agent_spec", {
      operations: [
        { op: "replace", path: "/agent/systemPrompt", value: "You are a serious support agent." },
      ],
    });
    expect(JSON.stringify(result.content)).toContain("Patch applied");
    const state = await store.getState();
    expect(state.draftSpec.agent.systemPrompt).toBe("You are a serious support agent.");
    expect(state.version).toBe(2);
  });

  it("patch_agent_spec rejects invalid results without changing the draft", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const tools = createAgentBuilderTools(store);
    const before = await store.getState();
    const result = await runTool(tools, "patch_agent_spec", {
      operations: [{ op: "replace", path: "/agent/id", value: "Not Valid!" }],
    });
    expect(JSON.stringify(result.content)).toContain("NOT changed");
    const after = await store.getState();
    expect(after.version).toBe(before.version);
    expect(after.draftSpec.agent.id).toBe(before.draftSpec.agent.id);
  });

  it("get_current_agent_spec reports validation and status", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const tools = createAgentBuilderTools(store);
    const result = await runTool(tools, "get_current_agent_spec", {});
    const text = JSON.stringify(result.content);
    expect(text).toContain("Validation: valid");
    expect(text).toContain("Deployment status: draft");
  });

  it("patch_agent_spec can add a skill and rejects duplicate names", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const tools = createAgentBuilderTools(store);
    const skill = {
      op: "add",
      path: "/agent/skills/-",
      value: { name: "order-lookup", instructions: "Always call the order tool first." },
    };
    const added = await runTool(tools, "patch_agent_spec", { operations: [skill] });
    expect(JSON.stringify(added.content)).toContain("Patch applied");
    expect((await store.getState()).draftSpec.agent.skills).toHaveLength(1);

    const duplicate = await runTool(tools, "patch_agent_spec", { operations: [skill] });
    expect(JSON.stringify(duplicate.content)).toContain("duplicate skill name");
    expect((await store.getState()).draftSpec.agent.skills).toHaveLength(1);
  });

  it("save_checkpoint commits the draft through gitops", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-builder-checkpoint-"));
    try {
      const store = createAgentBuilderStore(createMemoryKeyedStore());
      const tools = createAgentBuilderTools(store, {
        gitops: createAgentGitOps({ repoDir }),
        // Empty connector catalog: the default draft references no tools.
        kubectl: async () => ({ code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" }),
      });
      const result = await runTool(tools, "save_checkpoint", { message: "Initial version" });
      const text = JSON.stringify(result.content);
      expect(text).toContain("Checkpoint saved as commit");

      const unchanged = await runTool(tools, "save_checkpoint", {});
      expect(JSON.stringify(unchanged.content)).toContain("Nothing new to save");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("get_recent_agent_conversation reports the observed transcript", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const tools = createAgentBuilderTools(store);
    const empty = await runTool(tools, "get_recent_agent_conversation", {});
    expect(JSON.stringify(empty.content)).toContain("No test conversation");

    await store.appendLearningExchange({
      agentId: "store-helper",
      user: "What is out of stock?",
      agent: "The USB-C Dock is out of stock.",
      state: "completed",
    });
    const result = await runTool(tools, "get_recent_agent_conversation", {});
    const text = JSON.stringify(result.content);
    expect(text).toContain("store-helper");
    expect(text).toContain("USB-C Dock");
  });
});
