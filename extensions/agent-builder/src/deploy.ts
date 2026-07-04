// Deploy adapter: applies rendered resources with kubectl (in-cluster service
// account) and derives deployment status from the live Deployment. The
// builder LLM never runs kubectl; only this adapter does, on rendered
// templates from render.ts.
import { spawn } from "node:child_process";
import type { AgentDeploymentStatus, AgentSpec } from "@openclaw/agent-spec";
import { agentEndpointUrl, renderAgentResources, type KubernetesResource } from "./render.ts";

export type KubectlRunner = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runKubectl: KubectlRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });

function toManifestYaml(resources: KubernetesResource[]): string {
  // kubectl accepts a JSON stream of List items; avoid a YAML dependency.
  return JSON.stringify({ apiVersion: "v1", kind: "List", items: resources });
}

export type DeployOutcome =
  | { ok: true; status: AgentDeploymentStatus; endpoint: string; applied: string[] }
  | { ok: false; errors: string[] };

export async function deployAgentSpec(
  spec: AgentSpec,
  kubectl: KubectlRunner = runKubectl,
): Promise<DeployOutcome> {
  const rendered = renderAgentResources(spec);
  if (!rendered.ok) {
    return { ok: false, errors: rendered.errors };
  }
  const namespace = spec.agent.deployment.namespace;
  const result = await kubectl(
    ["apply", "-n", namespace, "-f", "-"],
    toManifestYaml(rendered.resources),
  );
  if (result.code !== 0) {
    return { ok: false, errors: [result.stderr.trim() || "kubectl apply failed"] };
  }
  return {
    ok: true,
    status: "deploying",
    endpoint: agentEndpointUrl(spec),
    applied: result.stdout.trim().split("\n").filter(Boolean),
  };
}

export type RuntimeStatus = {
  status: AgentDeploymentStatus;
  message: string;
  readyReplicas: number;
  endpoint?: string;
};

type DeploymentJson = {
  status?: {
    readyReplicas?: number;
    conditions?: { type?: string; status?: string; message?: string }[];
  };
};

export async function getAgentRuntimeStatus(
  spec: AgentSpec,
  kubectl: KubectlRunner = runKubectl,
): Promise<RuntimeStatus> {
  const namespace = spec.agent.deployment.namespace;
  const result = await kubectl(["get", "deployment", spec.agent.id, "-n", namespace, "-o", "json"]);
  if (result.code !== 0) {
    if (/notfound/i.test(result.stderr.replaceAll(" ", ""))) {
      return { status: "draft", message: "Not deployed.", readyReplicas: 0 };
    }
    return {
      status: "failed",
      message: result.stderr.trim() || "kubectl get failed",
      readyReplicas: 0,
    };
  }
  let parsed: DeploymentJson;
  try {
    parsed = JSON.parse(result.stdout) as DeploymentJson;
  } catch {
    return { status: "failed", message: "unreadable deployment status", readyReplicas: 0 };
  }
  const readyReplicas = parsed.status?.readyReplicas ?? 0;
  if (readyReplicas >= 1) {
    return {
      status: "running",
      message: "Agent is running.",
      readyReplicas,
      endpoint: agentEndpointUrl(spec),
    };
  }
  const conditions = parsed.status?.conditions ?? [];
  const failing = conditions.find(
    (condition) =>
      (condition.type === "Progressing" && condition.status === "False") ||
      (condition.type === "ReplicaFailure" && condition.status === "True"),
  );
  if (failing) {
    return {
      status: "failed",
      message: failing.message ?? "Deployment is not progressing.",
      readyReplicas,
    };
  }
  return { status: "deploying", message: "Waiting for the agent to become ready.", readyReplicas };
}
