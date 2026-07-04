// Curated capability catalog: MCP tool servers deployable in-cluster and
// knowledge packs baked into deployed agents. serverRef/packRef values in an
// AgentSpec must resolve here — the renderer refuses unknown references so the
// builder can never wire arbitrary endpoints.

export type ToolCatalogEntry = {
  serverRef: string;
  description: string;
  /** In-cluster MCP endpoint the runtime connects to. */
  url: string;
  tools: string[];
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    serverRef: "web-tools",
    description: "Web browsing: search the web (DuckDuckGo) and fetch/read pages. Read-only.",
    url: "http://web-tools-mcp.openclaw.svc.cluster.local:8000/mcp",
    tools: ["web_search", "fetch_url"],
  },
];

export type KnowledgePack = {
  packRef: string;
  title: string;
  description: string;
  content: string;
};

export const KNOWLEDGE_PACKS: KnowledgePack[] = [
  {
    packRef: "kagenti-platform",
    title: "Kagenti agent platform",
    description: "What Kagenti is and how agents run on it (operator, A2A, MCP).",
    content: `# Kagenti agent platform

Kagenti is a Kubernetes-native platform for running AI agents, incubated under
the Cloud Native Computing Foundation ecosystem by IBM Research. It treats
agents as ordinary Kubernetes workloads with a thin control plane on top.

Key concepts:

- Agents and tools are plain Kubernetes Deployments plus Services. Kagenti
  discovers them through labels: \`kagenti.io/type: agent\` or
  \`kagenti.io/type: tool\`, and a protocol label such as
  \`protocol.kagenti.io/a2a\` (agents) or \`protocol.kagenti.io/mcp\` (tools).
- The kagenti-operator adds an \`AgentRuntime\` custom resource that points at
  the backing Deployment (\`targetRef\`) and manages runtime concerns such as
  identity, mTLS modes, and agent card discovery.
- Agents speak A2A (Agent-to-Agent protocol): they publish a card at
  \`/.well-known/agent-card.json\` describing name, skills, and capabilities,
  and accept JSON-RPC 2.0 requests (method \`message/send\`) where the message
  has \`role\`, \`parts\` (text parts have \`kind: "text"\`), and an optional
  \`contextId\` that keeps multi-turn conversations together.
- Tools speak MCP (Model Context Protocol): JSON-RPC over streamable HTTP at
  a \`/mcp\` path. Agents call \`tools/list\` to discover tools and
  \`tools/call\` to invoke them.
- Inside the cluster an agent is reachable at
  \`http://<service>.<namespace>.svc.cluster.local:<port>\`.

Typical lifecycle: define the agent workload, label it for discovery, create an
AgentRuntime pointing at it, then chat with the service endpoint over A2A.`,
  },
  {
    packRef: "kind-kubernetes-troubleshooting",
    title: "Kubernetes troubleshooting basics (kind clusters)",
    description: "Common failure patterns and diagnosis steps for pods in local kind clusters.",
    content: `# Kubernetes troubleshooting basics (kind clusters)

kind ("Kubernetes in Docker") runs each cluster node as a Docker container, so
local clusters behave like real Kubernetes with a few quirks.

Common pod failure patterns:

- CrashLoopBackOff: the container starts and exits repeatedly. Check
  \`kubectl logs <pod> --previous\` for the crash output. Usual causes: bad
  configuration or env vars, missing secrets, a failing readiness dependency,
  or the process exiting on startup error.
- ImagePullBackOff / ErrImagePull: the node cannot pull the image. In kind,
  locally built images must be loaded into the cluster with
  \`kind load docker-image <image> --name <cluster>\`; otherwise set
  \`imagePullPolicy: Never\` only for images that are already loaded.
- Pending: no node can schedule the pod. Check \`kubectl describe pod\` events
  for insufficient CPU/memory or unbound PersistentVolumeClaims.
- OOMKilled (exit code 137): the container exceeded its memory limit. Raise
  \`resources.limits.memory\` or reduce the workload.
- CreateContainerConfigError: referenced ConfigMap or Secret key is missing.

Diagnosis order:

1. \`kubectl get pods -n <ns>\` — status, restarts, age.
2. \`kubectl describe pod <pod> -n <ns>\` — events at the bottom explain
   scheduling, pulling, and probe failures.
3. \`kubectl logs <pod> -n <ns> [-c <container>] [--previous]\` — application
   output; \`--previous\` shows the crashed attempt.
4. \`kubectl get events -n <ns> --sort-by=.lastTimestamp\` — cluster events.
5. For services: check \`kubectl get endpoints <svc>\` — an empty endpoint list
   means the selector matches no ready pods.

Probes: liveness probe failures restart the container; readiness probe
failures remove the pod from service endpoints without restarting it. A pod
that is Running but not Ready usually has a failing readiness probe.`,
  },
];

export function findToolCatalogEntry(serverRef: string): ToolCatalogEntry | undefined {
  return TOOL_CATALOG.find((entry) => entry.serverRef === serverRef);
}

export function findKnowledgePack(packRef: string): KnowledgePack | undefined {
  return KNOWLEDGE_PACKS.find((pack) => pack.packRef === packRef);
}
