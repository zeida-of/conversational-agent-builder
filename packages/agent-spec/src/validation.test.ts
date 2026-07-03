import { describe, expect, it } from "vitest";
import { createDefaultAgentSpec } from "./defaults.ts";
import { validateAgentSpec } from "./validation.ts";

describe("validateAgentSpec", () => {
  it("accepts the default draft spec", () => {
    const result = validateAgentSpec(createDefaultAgentSpec());
    expect(result.ok).toBe(true);
  });

  it("fills defaults for optional collections", () => {
    const spec = createDefaultAgentSpec();
    const bare = {
      agent: {
        ...spec.agent,
        tools: undefined,
        memory: undefined,
      },
    };
    const result = validateAgentSpec(bare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.specVersion).toBe(1);
      expect(result.spec.agent.tools).toEqual([]);
      expect(result.spec.agent.memory).toEqual({ enabled: false });
    }
  });

  it("rejects non-object input with structured errors", () => {
    const result = validateAgentSpec("not a spec");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects an id that is not a DNS-1123 label", () => {
    const spec = createDefaultAgentSpec({ id: "My Agent!" });
    const result = validateAgentSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((issue) => issue.path)).toContain("/agent/id");
    }
  });

  it("rejects missing required fields with pointer paths", () => {
    const spec = createDefaultAgentSpec();
    const broken = {
      specVersion: spec.specVersion,
      agent: { ...spec.agent, systemPrompt: "", model: { provider: "", name: "x" } },
    };
    const result = validateAgentSpec(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((issue) => issue.path);
      expect(paths).toContain("/agent/systemPrompt");
      expect(paths).toContain("/agent/model/provider");
    }
  });

  it("rejects invalid runtime platform and protocol", () => {
    const spec = createDefaultAgentSpec();
    const broken = {
      ...spec,
      agent: { ...spec.agent, runtime: { platform: "docker", protocol: "http" } },
    };
    const result = validateAgentSpec(broken);
    expect(result.ok).toBe(false);
  });

  it("rejects zero replicas", () => {
    const spec = createDefaultAgentSpec();
    const broken = {
      ...spec,
      agent: { ...spec.agent, deployment: { ...spec.agent.deployment, replicas: 0 } },
    };
    const result = validateAgentSpec(broken);
    expect(result.ok).toBe(false);
  });

  it("warns on short system prompts and multi-replica deployments", () => {
    const spec = createDefaultAgentSpec();
    const noisy = {
      ...spec,
      agent: {
        ...spec.agent,
        systemPrompt: "Hi.",
        deployment: { ...spec.agent.deployment, replicas: 3 },
      },
    };
    const result = validateAgentSpec(noisy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((issue) => issue.path)).toEqual([
        "/agent/systemPrompt",
        "/agent/deployment/replicas",
      ]);
    }
  });

  it("accepts an mcp tool and defaults its permissions to read-only", () => {
    const spec = createDefaultAgentSpec();
    const withTool = {
      ...spec,
      agent: {
        ...spec.agent,
        tools: [{ name: "knowledge_search", type: "mcp", serverRef: "support-kb" }],
      },
    };
    const result = validateAgentSpec(withTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.agent.tools[0]?.permissions).toEqual({ mode: "read-only" });
    }
  });
});
