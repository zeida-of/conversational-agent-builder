// Default draft spec used when a builder session starts with no stored agent.
// Namespace matches the existing generated-agent contract in k8s/openclaw.
import { AGENT_SPEC_VERSION, type AgentSpec } from "./schema.ts";

export function createDefaultAgentSpec(overrides?: { id?: string; name?: string }): AgentSpec {
  return {
    specVersion: AGENT_SPEC_VERSION,
    agent: {
      id: overrides?.id ?? "my-agent",
      name: overrides?.name ?? "My Agent",
      description: "Draft agent created in the OpenClaw agent builder.",
      systemPrompt: "You are a helpful assistant. Answer clearly and concisely.",
      model: {
        provider: "openai",
        name: "gpt-4.1-mini",
        temperature: 0.2,
      },
      tools: [],
      skills: [],
      knowledge: [],
      memory: { enabled: false },
      runtime: { platform: "kagenti", protocol: "a2a" },
      deployment: { namespace: "openclaw", replicas: 1 },
    },
  };
}
