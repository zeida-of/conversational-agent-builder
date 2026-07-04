// Gateway methods backing the /agent-builder UI side panel.
import type { OpenClawPluginApi } from "../api.ts";
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
}) {
  const { api, store } = params;

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
