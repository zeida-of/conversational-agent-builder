// Constrained builder tools: the ONLY way the builder agent may change an
// agent. It edits the canonical AgentSpec via JSON Patch; it can never emit
// raw Kubernetes resources (the Kagenti adapter owns rendering/apply).
import {
  applyAgentSpecPatch,
  type AgentSpecPatchOp,
  type AgentSpecValidationResult,
} from "@openclaw/agent-spec";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";
import type { AnyAgentTool } from "../api.ts";
import type { AgentBuilderState, AgentBuilderStore } from "./store.ts";

const PatchOperationSchema = Type.Object({
  op: stringEnum(["add", "replace", "remove"]),
  path: Type.String({
    description: 'JSON pointer into the spec, e.g. "/agent/systemPrompt" or "/agent/tools/-".',
  }),
  value: Type.Optional(Type.Unknown({ description: "New value for add/replace operations." })),
});

const PatchParamsSchema = Type.Object({
  operations: Type.Array(PatchOperationSchema, { minItems: 1 }),
});

const ResetParamsSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Agent id (lowercase letters, digits, hyphens)." })),
  name: Type.Optional(Type.String({ description: "Human-readable agent name." })),
});

const EMPTY_PARAMS = Type.Object({});

function describeValidation(validation: AgentSpecValidationResult): string {
  if (validation.ok) {
    const warnings = validation.warnings.map((w) => `${w.path}: ${w.message}`);
    return warnings.length ? `valid (warnings: ${warnings.join("; ")})` : "valid";
  }
  return `invalid: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`;
}

function stateResult(state: AgentBuilderState, note?: string) {
  const summary = [
    note,
    `Draft v${state.version} for agent "${state.draftSpec.agent.id}".`,
    `Validation: ${describeValidation(state.validation)}.`,
    `Deployment status: ${state.deploymentStatus}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    content: [
      { type: "text" as const, text: `${summary}\n${JSON.stringify(state.draftSpec, null, 2)}` },
    ],
    details: state,
  };
}

export function createAgentBuilderTools(store: AgentBuilderStore): AnyAgentTool[] {
  const getSpec: AnyAgentTool = {
    name: "get_current_agent_spec",
    label: "Get Agent Spec",
    description:
      "Read the current draft AgentSpec, its validation state, and deployment status. Call this before making edits.",
    parameters: EMPTY_PARAMS,
    execute: async () => stateResult(await store.getState()),
  };

  const patchSpec: AnyAgentTool = {
    name: "patch_agent_spec",
    label: "Patch Agent Spec",
    description:
      "Edit the draft AgentSpec with JSON Patch operations (add/replace/remove). The patch is rejected if the result would be structurally invalid; fix and retry. This edits the draft only — it never deploys.",
    parameters: PatchParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { operations: AgentSpecPatchOp[] };
      const state = await store.getState();
      const result = applyAgentSpecPatch(state.draftSpec, params.operations);
      if (!result.ok) {
        const reason =
          result.reason === "patch"
            ? `Patch failed: ${result.error}`
            : `Patch produced an invalid spec: ${describeValidation(result.validation)}`;
        return {
          content: [{ type: "text" as const, text: `${reason}\nThe draft was NOT changed.` }],
          details: result,
        };
      }
      const saved = await store.saveDraft(result.spec);
      return stateResult(saved, "Patch applied.");
    },
  };

  const validateSpec: AnyAgentTool = {
    name: "validate_agent_spec",
    label: "Validate Agent Spec",
    description:
      "Validate the current draft AgentSpec and return structured errors/warnings. Always validate before proposing deployment.",
    parameters: EMPTY_PARAMS,
    execute: async () => {
      const state = await store.getState();
      return {
        content: [
          { type: "text" as const, text: `Validation: ${describeValidation(state.validation)}` },
        ],
        details: state.validation,
      };
    },
  };

  const resetSpec: AnyAgentTool = {
    name: "reset_agent_spec",
    label: "Reset Agent Spec",
    description:
      "Discard the current draft and start a fresh AgentSpec, optionally with a new agent id/name. Use only when the user asks to start over or build a new agent.",
    parameters: ResetParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { id?: string; name?: string };
      const state = await store.reset(params);
      return stateResult(state, "Draft reset.");
    },
  };

  return [getSpec, patchSpec, validateSpec, resetSpec];
}
