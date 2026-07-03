import { describe, expect, it } from "vitest";
import { createDefaultAgentSpec } from "./defaults.ts";
import { applyAgentSpecPatch } from "./patch.ts";

describe("applyAgentSpecPatch", () => {
  it("replaces a scalar field without mutating the input", () => {
    const spec = createDefaultAgentSpec();
    const result = applyAgentSpecPatch(spec, [
      { op: "replace", path: "/agent/systemPrompt", value: "You are a concise support agent." },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.agent.systemPrompt).toBe("You are a concise support agent.");
    }
    expect(spec.agent.systemPrompt).not.toBe("You are a concise support agent.");
  });

  it("appends a tool with the '-' array cursor", () => {
    const spec = createDefaultAgentSpec();
    const result = applyAgentSpecPatch(spec, [
      {
        op: "add",
        path: "/agent/tools/-",
        value: { name: "knowledge_search", type: "mcp", serverRef: "support-kb" },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.agent.tools).toHaveLength(1);
      expect(result.spec.agent.tools[0]?.name).toBe("knowledge_search");
    }
  });

  it("removes an array element", () => {
    const spec = createDefaultAgentSpec();
    spec.agent.tools = [
      { name: "a", type: "mcp", serverRef: "s", permissions: { mode: "read-only" } },
      { name: "b", type: "mcp", serverRef: "s", permissions: { mode: "read-only" } },
    ];
    const result = applyAgentSpecPatch(spec, [{ op: "remove", path: "/agent/tools/0" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.agent.tools.map((tool) => tool.name)).toEqual(["b"]);
    }
  });

  it("applies multiple ops in order", () => {
    const spec = createDefaultAgentSpec();
    const result = applyAgentSpecPatch(spec, [
      { op: "replace", path: "/agent/name", value: "Support Agent" },
      { op: "replace", path: "/agent/id", value: "support-agent" },
      { op: "replace", path: "/agent/model/temperature", value: 0.7 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.agent.name).toBe("Support Agent");
      expect(result.spec.agent.id).toBe("support-agent");
      expect(result.spec.agent.model.temperature).toBe(0.7);
    }
  });

  it("fails with reason 'patch' for an unknown path", () => {
    const result = applyAgentSpecPatch(createDefaultAgentSpec(), [
      { op: "replace", path: "/agent/unknown/field", value: 1 },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "patch" });
  });

  it("fails with reason 'patch' for a bad array index", () => {
    const result = applyAgentSpecPatch(createDefaultAgentSpec(), [
      { op: "remove", path: "/agent/tools/5" },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "patch" });
  });

  it("fails with reason 'validation' when the patched spec is invalid", () => {
    const result = applyAgentSpecPatch(createDefaultAgentSpec(), [
      { op: "replace", path: "/agent/id", value: "Not A Valid Id" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "validation") {
      expect(result.validation.errors.map((issue) => issue.path)).toContain("/agent/id");
    } else {
      expect.unreachable("expected a validation failure");
    }
  });

  it("rejects pointers that do not start with '/'", () => {
    const result = applyAgentSpecPatch(createDefaultAgentSpec(), [
      { op: "replace", path: "agent/name", value: "x" },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "patch" });
  });
});
