// Gateway methods backing the /agent-builder UI side panel.
import type { OpenClawPluginApi } from "../api.ts";
import { sendPreviewMessage } from "./chat-proxy.ts";
import {
  agentTargetFromSpec,
  deployAgentSpec,
  getAgentRuntimeStatus,
  type KubectlRunner,
} from "./deploy.ts";
import type { AgentBuilderStore } from "./store.ts";

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
  kubectl?: KubectlRunner;
}) {
  const { api, store, kubectl } = params;

  api.registerGatewayMethod(
    "agentBuilder.getState",
    async ({ respond }) => {
      try {
        respond(true, await store.getState());
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
          await store.setDeployment({ status: outcome.status, deployedSpec: state.draftSpec }),
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
        respond(true, { ...saved, runtime: status });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    "agentBuilder.previewSend",
    async ({ params: requestParams, respond }) => {
      try {
        const raw = (requestParams ?? {}) as {
          agentId?: unknown;
          message?: unknown;
          contextId?: unknown;
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
        respond(
          true,
          await sendPreviewMessage({
            agentId,
            message,
            ...(typeof raw.contextId === "string" && raw.contextId
              ? { contextId: raw.contextId }
              : {}),
          }),
        );
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
    "agentBuilder.reset",
    async ({ params: requestParams, respond }) => {
      try {
        const raw = (requestParams ?? {}) as { id?: unknown; name?: unknown };
        respond(
          true,
          await store.reset({
            ...(typeof raw.id === "string" && raw.id.trim() ? { id: raw.id.trim() } : {}),
            ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );
}
