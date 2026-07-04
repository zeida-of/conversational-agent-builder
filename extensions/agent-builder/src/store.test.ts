import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
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

  it("tracks deployment status and last deployed spec", async () => {
    const store = createAgentBuilderStore(createMemoryKeyedStore());
    const { draftSpec } = await store.getState();
    const state = await store.setDeployment({ status: "running", deployedSpec: draftSpec });
    expect(state.deploymentStatus).toBe("running");
    expect(state.lastDeployedSpec?.agent.id).toBe(draftSpec.agent.id);
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
});
