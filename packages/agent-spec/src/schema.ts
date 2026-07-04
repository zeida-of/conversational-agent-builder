// Canonical AgentSpec schema: the single agent representation the builder chat
// edits and the Kagenti adapter renders into runtime resources. The builder
// never mutates Kubernetes YAML directly; it only patches objects of this shape.
import { z } from "zod";

export const AGENT_SPEC_VERSION = 1;

// Agent ids and namespaces become Kubernetes resource names, so they must be
// valid DNS-1123 labels or the Kagenti adapter cannot render them.
const DNS1123_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS1123_MESSAGE =
  "must be a lowercase DNS-1123 label (alphanumeric or '-', max 63 chars, alphanumeric at both ends)";

export const agentSpecToolSchema = z.object({
  name: z.string().min(1),
  type: z.literal("mcp"),
  serverRef: z.string().min(1),
  permissions: z
    .object({
      mode: z.enum(["read-only", "read-write"]),
    })
    .default({ mode: "read-only" }),
});

export const agentSpecSchema = z.object({
  specVersion: z.literal(AGENT_SPEC_VERSION).default(AGENT_SPEC_VERSION),
  agent: z.object({
    id: z.string().regex(DNS1123_LABEL, DNS1123_MESSAGE),
    name: z.string().min(1),
    description: z.string().min(1),
    systemPrompt: z.string().min(1),
    model: z.object({
      provider: z.string().min(1),
      name: z.string().min(1),
      temperature: z.number().min(0).max(2).optional(),
    }),
    tools: z.array(agentSpecToolSchema).default([]),
    // Knowledge packs are curated documents baked into the deployed agent's
    // context; packRef must resolve against the builder's pack registry.
    knowledge: z.array(z.object({ packRef: z.string().min(1) })).default([]),
    memory: z.object({ enabled: z.boolean() }).default({ enabled: false }),
    runtime: z.object({
      platform: z.literal("kagenti"),
      protocol: z.literal("a2a"),
    }),
    deployment: z.object({
      namespace: z.string().regex(DNS1123_LABEL, DNS1123_MESSAGE),
      image: z.string().min(1).optional(),
      replicas: z.number().int().min(1),
    }),
  }),
});

export type AgentSpec = z.infer<typeof agentSpecSchema>;
export type AgentSpecTool = z.infer<typeof agentSpecToolSchema>;

export const AGENT_DEPLOYMENT_STATUSES = [
  "draft",
  "validating",
  "valid",
  "invalid",
  "deploying",
  "running",
  "failed",
  "deleting",
  "deleted",
] as const;

export type AgentDeploymentStatus = (typeof AGENT_DEPLOYMENT_STATUSES)[number];
