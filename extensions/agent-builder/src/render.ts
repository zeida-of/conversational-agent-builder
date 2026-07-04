// Renders a validated AgentSpec into Kagenti-compatible Kubernetes resources.
// This is the only place specs become cluster objects: fixed safe templates,
// catalog-checked references, namespace allowlist, no privileged settings.
import type { AgentSpec } from "@openclaw/agent-spec";
import { findKnowledgePack, type ToolCatalogEntry } from "./catalog.ts";

export const AGENT_RUNTIME_IMAGE = "agent-builder/agent-runtime:dev";
// Generated agents are confined to the namespace the adapter has RBAC for.
const ALLOWED_NAMESPACES = ["openclaw"];
const AGENT_PORT = 8000;

export type KubernetesResource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  [key: string]: unknown;
};

export type RenderResult =
  | { ok: true; resources: KubernetesResource[] }
  | { ok: false; errors: string[] };

function agentLabels(spec: AgentSpec): Record<string, string> {
  return {
    "app.kubernetes.io/name": spec.agent.id,
    "app.kubernetes.io/part-of": "agent-builder",
    "app.kubernetes.io/managed-by": "openclaw-agent-builder",
    "kagenti.io/type": "agent",
    "protocol.kagenti.io/a2a": "",
    // This install runs the operator without SPIRE/Envoy (helm values disable
    // them); injected authbridge sidecars could never start, so opt out.
    "kagenti.io/envoy-proxy-inject": "false",
    "kagenti.io/spiffe-helper-inject": "false",
  };
}

export function renderAgentResources(
  spec: AgentSpec,
  toolCatalog: ToolCatalogEntry[],
): RenderResult {
  const errors: string[] = [];
  const namespace = spec.agent.deployment.namespace;
  if (!ALLOWED_NAMESPACES.includes(namespace)) {
    errors.push(
      `deployment.namespace "${namespace}" is not allowed (allowed: ${ALLOWED_NAMESPACES.join(", ")})`,
    );
  }
  const mcpServers: { name: string; url: string }[] = [];
  for (const tool of spec.agent.tools) {
    const entry = toolCatalog.find((candidate) => candidate.serverRef === tool.serverRef);
    if (!entry) {
      const available = toolCatalog.map((candidate) => candidate.serverRef).join(", ") || "none";
      errors.push(
        `tool serverRef "${tool.serverRef}" is not an available connector (available: ${available})`,
      );
      continue;
    }
    if (!mcpServers.some((server) => server.name === entry.serverRef)) {
      mcpServers.push({ name: entry.serverRef, url: entry.url });
    }
  }
  const knowledgeFiles: Record<string, string> = {};
  for (const item of spec.agent.knowledge) {
    const pack = findKnowledgePack(item.packRef);
    if (!pack) {
      errors.push(`knowledge packRef "${item.packRef}" is not in the knowledge pack registry`);
      continue;
    }
    knowledgeFiles[`knowledge-${pack.packRef}.md`] = pack.content;
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const name = spec.agent.id;
  const labels = agentLabels(spec);
  const configMap: KubernetesResource = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: `${name}-config`, namespace, labels },
    data: {
      "system-prompt.md": spec.agent.systemPrompt,
      ...knowledgeFiles,
    },
  };
  const deployment: KubernetesResource = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: spec.agent.deployment.replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: "agent",
              image: spec.agent.deployment.image ?? AGENT_RUNTIME_IMAGE,
              // Images are pre-loaded into the kind node by
              // scripts/build-agent-images.sh; there is no registry to pull from.
              imagePullPolicy: "Never",
              ports: [{ name: "http", containerPort: AGENT_PORT }],
              env: [
                { name: "AGENT_NAME", value: spec.agent.name },
                { name: "AGENT_DESCRIPTION", value: spec.agent.description },
                { name: "MODEL_PROVIDER", value: spec.agent.model.provider },
                { name: "MODEL_NAME", value: spec.agent.model.name },
                ...(spec.agent.model.temperature === undefined
                  ? []
                  : [{ name: "MODEL_TEMPERATURE", value: String(spec.agent.model.temperature) }]),
                { name: "SYSTEM_PROMPT_FILE", value: "/config/system-prompt.md" },
                { name: "KNOWLEDGE_DIR", value: "/config" },
                { name: "MEMORY_ENABLED", value: spec.agent.memory.enabled ? "1" : "0" },
                { name: "MCP_SERVERS", value: JSON.stringify(mcpServers) },
                {
                  name: "OPENAI_API_KEY",
                  valueFrom: { secretKeyRef: { name: "openclaw-secrets", key: "OPENAI_API_KEY" } },
                },
              ],
              volumeMounts: [{ name: "config", mountPath: "/config", readOnly: true }],
              readinessProbe: { httpGet: { path: "/healthz", port: "http" } },
              livenessProbe: {
                httpGet: { path: "/healthz", port: "http" },
                initialDelaySeconds: 10,
              },
              resources: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "512Mi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: false,
                runAsNonRoot: true,
                runAsUser: 1000,
              },
            },
          ],
          volumes: [{ name: "config", configMap: { name: `${name}-config` } }],
        },
      },
    },
  };
  const service: KubernetesResource = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [{ name: "http", port: AGENT_PORT, targetPort: "http" }],
    },
  };
  const agentRuntime: KubernetesResource = {
    apiVersion: "agent.kagenti.dev/v1alpha1",
    kind: "AgentRuntime",
    metadata: { name, namespace, labels },
    spec: {
      type: "agent",
      targetRef: { apiVersion: "apps/v1", kind: "Deployment", name },
    },
  };
  return { ok: true, resources: [configMap, deployment, service, agentRuntime] };
}

export function agentEndpointUrl(spec: AgentSpec): string {
  return `http://${spec.agent.id}.${spec.agent.deployment.namespace}.svc.cluster.local:${AGENT_PORT}`;
}
