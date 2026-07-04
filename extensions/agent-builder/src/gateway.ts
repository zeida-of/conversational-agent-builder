// Gateway methods backing the /agent-builder UI side panel.
import { validateAgentSpec } from "@openclaw/agent-spec";
import type { OpenClawPluginApi } from "../api.ts";
import { sendPreviewMessage } from "./chat-proxy.ts";
import {
  agentTargetFromSpec,
  deployAgentSpec,
  getAgentRuntimeStatus,
  renderForCheckpoint,
  type KubectlRunner,
} from "./deploy.ts";
import { specsEqual, type AgentGitOps } from "./gitops.ts";
import type { AgentBuilderState, AgentBuilderStore } from "./store.ts";

type GatewayRespond = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0]["respond"];

function respondError(respond: GatewayRespond, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  respond(false, undefined, { code: "internal_error", message });
}

export function registerAgentBuilderGatewayMethods(params: {
  api: OpenClawPluginApi;
  store: AgentBuilderStore;
  gitops: AgentGitOps;
  kubectl?: KubectlRunner;
}) {
  const { api, store, gitops, kubectl } = params;

  // Every state-shaped response carries the two sync signals the UI tracks:
  // draft vs last git checkpoint, and draft vs what is actually deployed.
  async function withSync(state: AgentBuilderState) {
    const git = await gitops.status({
      agentId: state.draftSpec.agent.id,
      draftSpec: state.draftSpec,
    });
    const deployedInSync = state.lastDeployedSpec
      ? specsEqual(state.draftSpec, state.lastDeployedSpec)
      : null;
    return { ...state, git, deployedInSync };
  }

  api.registerGatewayMethod(
    "agentBuilder.getState",
    async ({ respond }) => {
      try {
        respond(true, await withSync(await store.getState()));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    "agentBuilder.deploy",
    async ({ respond }) => {
      try {
        const state = await store.getState();
        if (!state.validation.ok) {
          respond(false, undefined, {
            code: "invalid_spec",
            message: "The draft is invalid; fix validation errors before deploying.",
          });
          return;
        }
        const outcome = await deployAgentSpec(state.draftSpec, kubectl);
        if (!outcome.ok) {
          await store.setDeployment({ status: "failed" });
          respond(false, undefined, {
            code: "deploy_failed",
            message: outcome.errors.join("; "),
          });
          return;
        }
        respond(
          true,
          await withSync(
            await store.setDeployment({ status: outcome.status, deployedSpec: state.draftSpec }),
          ),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "agentBuilder.status",
    async ({ respond }) => {
      try {
        const state = await store.getState();
        const status = await getAgentRuntimeStatus(
          agentTargetFromSpec(state.lastDeployedSpec ?? state.draftSpec),
          kubectl,
        );
        const saved = await store.setDeployment({ status: status.status });
        respond(true, { ...(await withSync(saved)), runtime: status });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    "agentBuilder.checkpoint",
    async ({ params: requestParams, respond }) => {
      try {
        const raw = (requestParams ?? {}) as { message?: unknown };
        const state = await store.getState();
        if (!state.validation.ok) {
          respond(false, undefined, {
            code: "invalid_spec",
            message: "The draft is invalid; fix validation errors before saving a checkpoint.",
          });
          return;
        }
        const rendered = await renderForCheckpoint(state.draftSpec, kubectl);
        const result = await gitops.checkpoint({
          spec: state.draftSpec,
          manifests: rendered.manifests,
          ...(typeof raw.message === "string" && raw.message.trim()
            ? { message: raw.message.trim() }
            : { message: `Checkpoint ${state.draftSpec.agent.id} v${state.version}` }),
        });
        if (!result.ok) {
          respond(false, undefined, { code: "checkpoint_failed", message: result.error });
          return;
        }
        respond(true, {
          ...(await withSync(state)),
          checkpoint: {
            ...result,
            warnings: [...(rendered.warning ? [rendered.warning] : []), ...result.warnings],
          },
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "agentBuilder.restoreCheckpoint",
    async ({ respond }) => {
      try {
        const state = await store.getState();
        const restored = await gitops.restore(state.draftSpec.agent.id);
        if (!restored.ok) {
          respond(false, undefined, { code: "restore_failed", message: restored.error });
          return;
        }
        const validation = validateAgentSpec(restored.spec);
        if (!validation.ok) {
          respond(false, undefined, {
            code: "restore_failed",
            message: `The checkpointed spec no longer validates: ${validation.errors
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ")}`,
          });
          return;
        }
        respond(true, await withSync(await store.saveDraft(validation.spec)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "agentBuilder.previewSend",
    async ({ params: requestParams, respond }) => {
      try {
        const raw = (requestParams ?? {}) as {
          agentId?: unknown;
          message?: unknown;
          contextId?: unknown;
          learning?: unknown;
        };
        const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : "";
        const message = typeof raw.message === "string" ? raw.message.trim() : "";
        if (!agentId || !message) {
          respond(false, undefined, {
            code: "invalid_params",
            message: "agentId and message are required",
          });
          return;
        }
        const result = await sendPreviewMessage({
          agentId,
          message,
          ...(typeof raw.contextId === "string" && raw.contextId
            ? { contextId: raw.contextId }
            : {}),
        });
        // Learning mode: record the exchange so the builder agent can read the
        // real transcript when the user gives improvement feedback.
        if (raw.learning === true) {
          await store.appendLearningExchange({
            agentId,
            user: message,
            agent: result.text,
            state: result.state,
          });
        }
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "agentBuilder.previewStatus",
    async ({ params: requestParams, respond }) => {
      try {
        const raw = (requestParams ?? {}) as { agentId?: unknown };
        const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : "";
        if (!agentId) {
          respond(false, undefined, { code: "invalid_params", message: "agentId is required" });
          return;
        }
        const state = await store.getState();
        const deployedSpec = state.lastDeployedSpec;
        const runtime = await getAgentRuntimeStatus(
          { id: agentId, namespace: "openclaw" },
          kubectl,
        );
        respond(true, {
          runtime,
          // Version metadata is only known for the agent this builder manages.
          version: deployedSpec?.agent.id === agentId ? state.version : null,
          managed: deployedSpec?.agent.id === agentId || state.draftSpec.agent.id === agentId,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    "agentBuilder.learningClear",
    async ({ respond }) => {
      try {
        await store.clearLearningLog();
        respond(true, { cleared: true });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "agentBuilder.reset",
    async ({ params: requestParams, respond }) => {
      try {
        const raw = (requestParams ?? {}) as { id?: unknown; name?: unknown };
        respond(
          true,
          await withSync(
            await store.reset({
              ...(typeof raw.id === "string" && raw.id.trim() ? { id: raw.id.trim() } : {}),
              ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
            }),
          ),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );
}
