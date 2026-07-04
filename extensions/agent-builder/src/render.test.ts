import { createDefaultAgentSpec } from "@openclaw/agent-spec";
import { describe, expect, it } from "vitest";
import type { ToolCatalogEntry } from "./catalog.ts";
import {
  agentTargetFromSpec,
  deployAgentSpec,
  getAgentRuntimeStatus,
  type KubectlRunner,
} from "./deploy.ts";
import { renderAgentResources } from "./render.ts";

const TEST_CATALOG: ToolCatalogEntry[] = [
  {
    serverRef: "web-tools",
    description: "web",
    url: "http://web-tools-mcp.openclaw.svc.cluster.local:8000/mcp",
    tools: [],
  },
];
const SERVICES_JSON = JSON.stringify({
  items: [
    {
      metadata: {
        name: "web-tools-mcp",
        labels: { "app.kubernetes.io/name": "web-tools" },
        annotations: { "agent-builder.openclaw.dev/description": "web" },
      },
      spec: { ports: [{ port: 8000 }] },
    },
  ],
});

function specWithCapabilities() {
  const spec = createDefaultAgentSpec({ id: "kagenti-helper", name: "Kagenti Helper" });
  spec.agent.tools = [
    { name: "web", type: "mcp", serverRef: "web-tools", permissions: { mode: "read-only" } },
  ];
  spec.agent.skills = [
    { name: "greeting", description: "How to greet.", instructions: "Greet formally." },
  ];
  spec.agent.knowledge = [{ packRef: "kagenti-platform" }];
  spec.agent.memory = { enabled: true };
  return spec;
}

describe("renderAgentResources", () => {
  it("renders configmap, deployment, service, and agentruntime", () => {
    const result = renderAgentResources(specWithCapabilities(), TEST_CATALOG);
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
    expect((configMap.data as Record<string, string>)["skill-greeting.md"]).toContain(
      "Greet formally.",
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
    const result = renderAgentResources(spec, TEST_CATALOG);
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
      if (args[0] === "get") {
        return { code: 0, stdout: SERVICES_JSON, stderr: "" };
      }
      expect(stdin).toContain('"kind":"List"');
      return { code: 0, stdout: "deployment.apps/my-agent created\n", stderr: "" };
    };
    const outcome = await deployAgentSpec(createDefaultAgentSpec(), kubectl);
    expect(outcome).toMatchObject({ ok: true, status: "deploying" });
    expect(calls.at(-1)).toEqual(["apply", "-n", "openclaw", "-f", "-"]);
  });

  it("maps deployment readiness to running status", async () => {
    const kubectl: KubectlRunner = async () => ({
      code: 0,
      stdout: JSON.stringify({ status: { readyReplicas: 1 } }),
      stderr: "",
    });
    const status = await getAgentRuntimeStatus(
      agentTargetFromSpec(createDefaultAgentSpec()),
      kubectl,
    );
    expect(status.status).toBe("running");
    expect(status.endpoint).toContain("my-agent.openclaw.svc.cluster.local");
  });

  it("maps missing deployment to draft and kubectl failure to failed", async () => {
    const notFound: KubectlRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: 'Error from server (NotFound): deployments.apps "my-agent" not found',
    });
    expect(
      (await getAgentRuntimeStatus(agentTargetFromSpec(createDefaultAgentSpec()), notFound)).status,
    ).toBe("draft");
    const failed: KubectlRunner = async () => ({ code: 1, stdout: "", stderr: "forbidden" });
    expect(
      (await getAgentRuntimeStatus(agentTargetFromSpec(createDefaultAgentSpec()), failed)).status,
    ).toBe("failed");
  });
});

describe("connector discovery", () => {
  it("maps labeled services to catalog entries", async () => {
    const kubectl: KubectlRunner = async () => ({ code: 0, stdout: SERVICES_JSON, stderr: "" });
    const { listToolServices } = await import("./catalog.ts");
    const entries = await listToolServices(kubectl);
    expect(entries).toEqual([
      {
        serverRef: "web-tools",
        description: "web",
        url: "http://web-tools-mcp.openclaw.svc.cluster.local:8000/mcp",
        tools: [],
      },
    ]);
  });

  it("render rejects connectors that are not discovered", () => {
    const spec = specWithCapabilities();
    spec.agent.tools = [
      { name: "x", type: "mcp", serverRef: "store-api", permissions: { mode: "read-only" } },
    ];
    const result = renderAgentResources(spec, TEST_CATALOG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("available: web-tools");
    }
  });
});
