// Agent Builder page: conversational editor for the canonical AgentSpec.
// Chat goes through the normal gateway chat pipeline on a dedicated builder
// session; spec/validation/deployment state comes from the agent-builder
// plugin's gateway methods.
import type {
  AgentDeploymentStatus,
  AgentSpec,
  AgentSpecValidationResult,
} from "@openclaw/agent-spec";
import { html } from "lit";
import { extractText } from "../chat/message-extract.ts";
import type { ChatEventPayload } from "../controllers/chat.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { pathForAgentPreview } from "../navigation.ts";
import {
  pinAgentChatToBottom,
  renderAgentChatSurface,
  type AgentChatMessage,
} from "./agent-chat-surface.ts";
import { renderAgentSpecPanel } from "./agent-spec-panel.ts";

export const AGENT_BUILDER_AGENT_ID = "agent_builder";
export const AGENT_BUILDER_SESSION_KEY = "agent:agent_builder:builder-ui";

/** Mirrors AgentBuilderState returned by the agent-builder plugin gateway methods. */
type AgentBuilderGatewayState = {
  version: number;
  draftSpec: AgentSpec;
  lastDeployedSpec?: AgentSpec;
  deploymentStatus: AgentDeploymentStatus;
  updatedAt: number;
  validation: AgentSpecValidationResult;
};

type AgentBuilderViewState = {
  messages: AgentChatMessage[];
  draft: string;
  busy: boolean;
  streamText: string;
  panel: AgentBuilderGatewayState | null;
  panelLoading: boolean;
  panelError: string | null;
  deployBusy: boolean;
  runtimeMessage: string | null;
};

let viewState: AgentBuilderViewState | null = null;

export function resetAgentBuilderViewState(): void {
  viewState = null;
}

function ensureViewState(): AgentBuilderViewState {
  viewState ??= {
    messages: [],
    draft: "",
    busy: false,
    streamText: "",
    panel: null,
    panelLoading: false,
    panelError: null,
    deployBusy: false,
    runtimeMessage: null,
  };
  return viewState;
}

export function isAgentBuilderSessionKey(sessionKey: string | undefined | null): boolean {
  return sessionKey === AGENT_BUILDER_SESSION_KEY;
}

async function refreshPanel(client: GatewayBrowserClient, requestUpdate?: () => void) {
  const state = ensureViewState();
  state.panelLoading = true;
  state.panelError = null;
  requestUpdate?.();
  try {
    state.panel = await client.request<AgentBuilderGatewayState>("agentBuilder.getState", {});
  } catch (error) {
    state.panelError = error instanceof Error ? error.message : String(error);
  } finally {
    state.panelLoading = false;
    requestUpdate?.();
  }
}

let panelRefreshClient: GatewayBrowserClient | null = null;

/** Handles gateway chat events for the dedicated builder session. */
export function handleAgentBuilderChatEvent(
  payload: ChatEventPayload | undefined,
  requestUpdate?: () => void,
): void {
  if (!payload || !viewState) {
    return;
  }
  const state = viewState;
  if (payload.state === "delta") {
    state.streamText = payload.replace
      ? (payload.deltaText ?? "")
      : state.streamText + (payload.deltaText ?? "");
  } else if (payload.state === "final") {
    const text = extractText(payload.message) ?? state.streamText;
    if (text.trim()) {
      state.messages.push({ role: "assistant", text });
    }
    state.streamText = "";
    state.busy = false;
    // The builder likely changed the spec this turn; refresh the side panel.
    if (panelRefreshClient) {
      void refreshPanel(panelRefreshClient, requestUpdate);
    }
  } else if (payload.state === "error" || payload.state === "aborted") {
    const reason =
      payload.state === "aborted"
        ? "The builder run was interrupted. Please try again."
        : `Something went wrong: ${payload.errorMessage ?? "unknown error"}`;
    state.messages.push({ role: "assistant", text: reason });
    state.streamText = "";
    state.busy = false;
  }
  requestUpdate?.();
  pinAgentChatToBottom(document);
}

async function sendBuilderMessage(
  client: GatewayBrowserClient,
  text: string,
  requestUpdate?: () => void,
) {
  const state = ensureViewState();
  state.messages.push({ role: "user", text });
  state.busy = true;
  state.streamText = "";
  requestUpdate?.();
  pinAgentChatToBottom(document);
  try {
    await client.request("chat.send", {
      sessionKey: AGENT_BUILDER_SESSION_KEY,
      agentId: AGENT_BUILDER_AGENT_ID,
      message: text,
      deliver: false,
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (error) {
    state.busy = false;
    state.messages.push({
      role: "assistant",
      text: `Could not reach the builder: ${error instanceof Error ? error.message : String(error)}`,
    });
    requestUpdate?.();
  }
}

export type AgentBuilderProps = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  basePath: string;
  requestUpdate?: () => void;
};

function deploymentDetail(state: AgentBuilderViewState, panel: AgentBuilderGatewayState): string {
  if (state.runtimeMessage) {
    return state.runtimeMessage;
  }
  if (panel.deploymentStatus === "draft") {
    return "Not deployed yet. Press Deploy when the draft is ready.";
  }
  return `Last update ${new Date(panel.updatedAt).toLocaleString()}.`;
}

type StatusResponse = AgentBuilderGatewayState & {
  runtime?: { status: string; message: string };
};

async function pollDeploymentStatus(client: GatewayBrowserClient, requestUpdate?: () => void) {
  const state = ensureViewState();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });
    try {
      const response = await client.request<StatusResponse>("agentBuilder.status", {});
      state.panel = response;
      state.runtimeMessage = response.runtime?.message ?? null;
      requestUpdate?.();
      if (response.deploymentStatus === "running" || response.deploymentStatus === "failed") {
        break;
      }
    } catch (error) {
      state.runtimeMessage = error instanceof Error ? error.message : String(error);
      requestUpdate?.();
      break;
    }
  }
  state.deployBusy = false;
  requestUpdate?.();
}

async function deployDraft(client: GatewayBrowserClient, requestUpdate?: () => void) {
  const state = ensureViewState();
  state.deployBusy = true;
  state.runtimeMessage = "Deploying…";
  requestUpdate?.();
  try {
    state.panel = await client.request<AgentBuilderGatewayState>("agentBuilder.deploy", {});
    state.runtimeMessage = "Deployment started; waiting for the agent to become ready.";
    requestUpdate?.();
    await pollDeploymentStatus(client, requestUpdate);
  } catch (error) {
    state.deployBusy = false;
    state.runtimeMessage = `Deploy failed: ${error instanceof Error ? error.message : String(error)}`;
    requestUpdate?.();
  }
}

export function renderAgentBuilder(props: AgentBuilderProps) {
  const state = ensureViewState();
  panelRefreshClient = props.client;
  if (props.client && props.connected && !state.panel && !state.panelLoading) {
    void refreshPanel(props.client, props.requestUpdate);
  }
  const messages: AgentChatMessage[] = state.streamText
    ? [...state.messages, { role: "assistant", text: state.streamText }]
    : state.messages;
  return html`
    <div class="agent-builder-layout">
      <div class="agent-builder-layout__chat">
        ${renderAgentChatSurface({
          title: "Builder chat",
          subtitle: "Describe the agent you want; the builder edits the draft spec.",
          placeholder: "e.g. Build a support agent that answers questions from our docs",
          emptyHint: props.connected
            ? "No messages yet. Describe the agent you want to build."
            : "Connect to the gateway to start building.",
          messages,
          draft: state.draft,
          busy: state.busy && !state.streamText,
          sendDisabled: state.busy || !props.connected || !props.client,
          onDraftChange: (next) => {
            state.draft = next;
            props.requestUpdate?.();
          },
          onSend: () => {
            const text = state.draft.trim();
            if (!text || !props.client || state.busy) {
              return;
            }
            state.draft = "";
            void sendBuilderMessage(props.client, text, props.requestUpdate);
          },
        })}
      </div>
      <div class="agent-builder-layout__panel">
        ${state.panel
          ? renderAgentSpecPanel({
              spec: state.panel.draftSpec,
              validation: state.panel.validation,
              deployment: {
                status: state.panel.deploymentStatus,
                detail: deploymentDetail(state, state.panel),
              },
              previewHref: pathForAgentPreview(state.panel.draftSpec.agent.id, props.basePath),
              deployBusy: state.deployBusy,
              onDeploy: () => {
                if (props.client && !state.deployBusy) {
                  void deployDraft(props.client, props.requestUpdate);
                }
              },
            })
          : html`
              <section class="card">
                <div class="card-title">Draft agent</div>
                <div class="card-sub">Canonical AgentSpec edited by the builder.</div>
                ${state.panelError
                  ? html`<div class="callout danger" style="margin-top: 12px;">
                      ${state.panelError}
                    </div>`
                  : html`<div class="muted" style="margin-top: 12px;">
                      ${state.panelLoading ? "Loading draft…" : "Waiting for gateway connection."}
                    </div>`}
              </section>
            `}
      </div>
    </div>
  `;
}
