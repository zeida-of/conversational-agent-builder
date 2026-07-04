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
import { discoverToolServers, KNOWLEDGE_PACKS } from "./catalog.ts";
import {
  agentTargetFromSpec,
  deployAgentSpec,
  getAgentRuntimeStatus,
  renderForCheckpoint,
  runKubectl,
  type KubectlRunner,
} from "./deploy.ts";
import { createAgentGitOps, type AgentGitOps } from "./gitops.ts";
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

const CheckpointParamsSchema = Type.Object({
  message: Type.Optional(
    Type.String({ description: "Short summary of what changed since the last checkpoint." }),
  ),
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

export function createAgentBuilderTools(
  store: AgentBuilderStore,
  options?: { kubectl?: KubectlRunner; gitops?: AgentGitOps },
): AnyAgentTool[] {
  const kubectl = options?.kubectl;
  const gitops = options?.gitops ?? createAgentGitOps();
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

  const listCapabilities: AnyAgentTool = {
    name: "list_capabilities",
    label: "List Capabilities",
    description:
      "List the connectors (tool servers) and knowledge packs that can be attached to the agent (tools[].serverRef and knowledge[].packRef values must come from here). Connectors are discovered live from the platform.",
    parameters: EMPTY_PARAMS,
    execute: async () => {
      const discovered = await discoverToolServers(kubectl ?? runKubectl);
      const capabilities = {
        tools: discovered.map(({ serverRef, description, tools }) => ({
          serverRef,
          description,
          tools,
        })),
        knowledgePacks: KNOWLEDGE_PACKS.map(({ packRef, title, description }) => ({
          packRef,
          title,
          description,
        })),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(capabilities, null, 2) }],
        details: capabilities,
      };
    },
  };

  const deployAgent: AnyAgentTool = {
    name: "deploy_agent",
    label: "Deploy Agent",
    description:
      "Deploy (or redeploy) the current draft to the Kagenti runtime. Only call this when the user explicitly asks to deploy. The draft must be valid.",
    parameters: EMPTY_PARAMS,
    execute: async () => {
      const state = await store.getState();
      if (!state.validation.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot deploy: the draft is invalid. ${describeValidation(state.validation)}`,
            },
          ],
          details: state.validation,
        };
      }
      const outcome = await deployAgentSpec(state.draftSpec, kubectl);
      if (!outcome.ok) {
        await store.setDeployment({ status: "failed" });
        return {
          content: [
            { type: "text" as const, text: `Deployment failed: ${outcome.errors.join("; ")}` },
          ],
          details: outcome,
        };
      }
      await store.setDeployment({ status: outcome.status, deployedSpec: state.draftSpec });
      return {
        content: [
          {
            type: "text" as const,
            text: `Deployment started for "${state.draftSpec.agent.id}". Applied: ${outcome.applied.join(", ")}. Use get_deployment_status to confirm it is running before telling the user it is live.`,
          },
        ],
        details: outcome,
      };
    },
  };

  const deploymentStatus: AnyAgentTool = {
    name: "get_deployment_status",
    label: "Get Deployment Status",
    description:
      "Check the live runtime status of the deployed agent (draft/deploying/running/failed).",
    parameters: EMPTY_PARAMS,
    execute: async () => {
      const state = await store.getState();
      const status = await getAgentRuntimeStatus(
        agentTargetFromSpec(state.lastDeployedSpec ?? state.draftSpec),
        kubectl,
      );
      await store.setDeployment({ status: status.status });
      return {
        content: [{ type: "text" as const, text: `Status: ${status.status}. ${status.message}` }],
        details: status,
      };
    },
  };

  const saveCheckpoint: AnyAgentTool = {
    name: "save_checkpoint",
    label: "Save Checkpoint",
    description:
      "Commit the current draft (spec, skills, rendered manifests) to the platform git repository as a durable version. Use when the user asks to save, or suggest it after meaningful milestones.",
    parameters: CheckpointParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { message?: string };
      const state = await store.getState();
      if (!state.validation.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot save a checkpoint while the draft is invalid. ${describeValidation(state.validation)}`,
            },
          ],
          details: state.validation,
        };
      }
      const rendered = await renderForCheckpoint(state.draftSpec, kubectl);
      const result = await gitops.checkpoint({
        spec: state.draftSpec,
        manifests: rendered.manifests,
        message: params.message,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Checkpoint failed: ${result.error}` }],
          details: result,
        };
      }
      const lines = [
        result.committed
          ? `Checkpoint saved as commit ${result.commit?.hash.slice(0, 7) ?? "?"} ("${result.commit?.subject ?? ""}").`
          : "Nothing new to save — the draft already matches the last checkpoint.",
        result.push === "pushed" ? "Pushed to the configured git remote." : undefined,
        result.push === "push-failed" ? "Warning: the push to the git remote failed." : undefined,
        rendered.warning,
        ...result.warnings,
      ].filter(Boolean);
      return { content: [{ type: "text" as const, text: lines.join(" ") }], details: result };
    },
  };

  const recentConversation: AnyAgentTool = {
    name: "get_recent_agent_conversation",
    label: "Get Recent Agent Conversation",
    description:
      "Read the recent test conversation the user had with the deployed agent (recorded while Learning mode is on). Call this whenever the user gives feedback about how the agent behaved, so you can see the actual exchanges before improving the draft.",
    parameters: EMPTY_PARAMS,
    execute: async () => {
      const log = await store.getLearningLog();
      if (!log || log.exchanges.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No test conversation has been recorded yet. Ask the user to chat with the deployed agent in the Test panel (with Learning mode on) and then share their feedback.",
            },
          ],
          details: { exchanges: [] },
        };
      }
      const transcript = log.exchanges
        .map(
          (exchange, index) =>
            `${index + 1}. User: ${exchange.user}\n   Agent${exchange.state === "failed" ? " (errored)" : ""}: ${exchange.agent}`,
        )
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `Recent test conversation with deployed agent "${log.agentId}" (${log.exchanges.length} exchanges, newest last):\n${transcript}`,
          },
        ],
        details: log,
      };
    },
  };

  return [
    getSpec,
    patchSpec,
    validateSpec,
    resetSpec,
    listCapabilities,
    deployAgent,
    deploymentStatus,
    saveCheckpoint,
    recentConversation,
  ];
}
