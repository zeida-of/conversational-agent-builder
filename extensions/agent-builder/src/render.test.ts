import { createDefaultAgentSpec } from "@openclaw/agent-spec";
import { describe, expect, it } from "vitest";
import { deployAgentSpec, getAgentRuntimeStatus, type KubectlRunner } from "./deploy.ts";
import { renderAgentResources } from "./render.ts";

function specWithCapabilities() {
  const spec = createDefaultAgentSpec({ id: "kagenti-helper", name: "Kagenti Helper" });
  spec.agent.tools = [
    { name: "web", type: "mcp", serverRef: "web-tools", permissions: { mode: "read-only" } },
  ];
  spec.agent.knowledge = [{ packRef: "kagenti-platform" }];
  spec.agent.memory = { enabled: true };
  return spec;
}

describe("renderAgentResources", () => {
  it("renders configmap, deployment, service, and agentruntime", () => {
    const result = renderAgentResources(specWithCapabilities());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.resources.map((resource) => resource.kind)).toEqual([
      "ConfigMap",
      "Deployment",
      "Service",
      "AgentRuntime",
    ]);
    const [configMap, deployment] = result.resources;
    expect((configMap.data as Record<string, string>)["knowledge-kagenti-platform.md"]).toContain(
      "Kagenti",
    );
    const container = (deployment.spec as { template: { spec: { containers: unknown[] } } })
      .template.spec.containers[0] as { env: { name: string; value?: string }[] };
    const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry.value]));
    expect(env.MCP_SERVERS).toContain("web-tools-mcp.openclaw.svc.cluster.local");
    expect(env.MEMORY_ENABLED).toBe("1");
    expect(deployment.metadata.labels?.["protocol.kagenti.io/a2a"]).toBe("");
    expect(deployment.metadata.labels?.["kagenti.io/type"]).toBe("agent");
  });

  it("rejects unknown catalog references and namespaces", () => {
    const spec = createDefaultAgentSpec();
    spec.agent.tools = [
      { name: "x", type: "mcp", serverRef: "nope", permissions: { mode: "read-only" } },
    ];
    spec.agent.knowledge = [{ packRef: "missing-pack" }];
    spec.agent.deployment.namespace = "kube-system";
    const result = renderAgentResources(spec);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toHaveLength(3);
  });
});

describe("deploy adapter", () => {
  it("applies rendered resources via kubectl and reports deploying", async () => {
    const calls: string[][] = [];
    const kubectl: KubectlRunner = async (args, stdin) => {
      calls.push(args);
      expect(stdin).toContain('"kind":"List"');
      return { code: 0, stdout: "deployment.apps/my-agent created\n", stderr: "" };
    };
    const outcome = await deployAgentSpec(createDefaultAgentSpec(), kubectl);
    expect(outcome).toMatchObject({ ok: true, status: "deploying" });
    expect(calls[0]).toEqual(["apply", "-n", "openclaw", "-f", "-"]);
  });

  it("maps deployment readiness to running status", async () => {
    const kubectl: KubectlRunner = async () => ({
      code: 0,
      stdout: JSON.stringify({ status: { readyReplicas: 1 } }),
      stderr: "",
    });
    const status = await getAgentRuntimeStatus(createDefaultAgentSpec(), kubectl);
    expect(status.status).toBe("running");
    expect(status.endpoint).toContain("my-agent.openclaw.svc.cluster.local");
  });

  it("maps missing deployment to draft and kubectl failure to failed", async () => {
    const notFound: KubectlRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: 'Error from server (NotFound): deployments.apps "my-agent" not found',
    });
    expect((await getAgentRuntimeStatus(createDefaultAgentSpec(), notFound)).status).toBe("draft");
    const failed: KubectlRunner = async () => ({ code: 1, stdout: "", stderr: "forbidden" });
    expect((await getAgentRuntimeStatus(createDefaultAgentSpec(), failed)).status).toBe("failed");
  });
});
