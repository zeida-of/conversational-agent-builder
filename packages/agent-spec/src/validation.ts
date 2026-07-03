// AgentSpec validation returns structured issues (JSON-pointer paths) so the
// builder chat and UI side panel can point at the exact offending field.
import { agentSpecSchema, type AgentSpec } from "./schema.ts";

export type AgentSpecValidationIssue = {
  /** JSON-pointer-style path into the spec, e.g. "/agent/systemPrompt". */
  path: string;
  message: string;
};

export type AgentSpecValidationResult =
  | { ok: true; spec: AgentSpec; warnings: AgentSpecValidationIssue[] }
  | { ok: false; errors: AgentSpecValidationIssue[]; warnings: AgentSpecValidationIssue[] };

function collectWarnings(spec: AgentSpec): AgentSpecValidationIssue[] {
  const warnings: AgentSpecValidationIssue[] = [];
  if (spec.agent.systemPrompt.trim().length < 20) {
    warnings.push({
      path: "/agent/systemPrompt",
      message: "System prompt is very short; the agent may behave generically.",
    });
  }
  if (spec.agent.deployment.replicas > 1) {
    warnings.push({
      path: "/agent/deployment/replicas",
      message: "The MVP runtime targets a single replica; extra replicas are untested.",
    });
  }
  return warnings;
}

export function validateAgentSpec(value: unknown): AgentSpecValidationResult {
  const parsed = agentSpecSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: `/${issue.path.map(String).join("/")}`,
        message: issue.message,
      })),
      warnings: [],
    };
  }
  return { ok: true, spec: parsed.data, warnings: collectWarnings(parsed.data) };
}
