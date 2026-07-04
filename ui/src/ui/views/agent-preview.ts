// Agent Preview page: live chat with the deployed Kagenti-hosted agent via the
// agentBuilder.previewSend proxy. Responses come from the real runtime; errors
// are surfaced as error bubbles, never faked.
import { html } from "lit";
import type { GatewayBrowserClient } from "../gateway.ts";
import { pathForTab } from "../navigation.ts";
import {
  pinAgentChatToBottom,
  renderAgentChatSurface,
  type AgentChatMessage,
} from "./agent-chat-surface.ts";
import { renderStatusPill } from "./agent-spec-panel.ts";

type PreviewRuntime = {
  status: string;
  message: string;
  readyReplicas: number;
  endpoint?: string;
};

type AgentPreviewViewState = {
  agentId: string;
  messages: AgentChatMessage[];
  draft: string;
  busy: boolean;
  contextId: string | null;
  runtime: PreviewRuntime | null;
  version: number | null;
  statusLoading: boolean;
};

let viewState: AgentPreviewViewState | null = null;

export function resetAgentPreviewViewState(): void {
  viewState = null;
}

function ensureViewState(agentId: string): AgentPreviewViewState {
  if (!viewState || viewState.agentId !== agentId) {
    viewState = {
      agentId,
      messages: [],
      draft: "",
      busy: false,
      contextId: null,
      runtime: null,
      version: null,
      statusLoading: false,
    };
  }
  return viewState;
}

async function refreshRuntimeStatus(client: GatewayBrowserClient, requestUpdate?: () => void) {
  const state = viewState;
  if (!state || state.statusLoading) {
    return;
  }
  state.statusLoading = true;
  try {
    const response = await client.request<{ runtime: PreviewRuntime; version: number | null }>(
      "agentBuilder.previewStatus",
      { agentId: state.agentId },
    );
    state.runtime = response.runtime;
    state.version = response.version;
  } catch (error) {
    state.runtime = {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      readyReplicas: 0,
    };
  } finally {
    state.statusLoading = false;
    requestUpdate?.();
  }
}

async function sendPreview(client: GatewayBrowserClient, text: string, requestUpdate?: () => void) {
  const state = viewState;
  if (!state) {
    return;
  }
  state.messages.push({ role: "user", text });
  state.busy = true;
  requestUpdate?.();
  pinAgentChatToBottom(document);
  try {
    const result = await client.request<{ text: string; contextId: string; state: string }>(
      "agentBuilder.previewSend",
      {
        agentId: state.agentId,
        message: text,
        ...(state.contextId ? { contextId: state.contextId } : {}),
      },
    );
    state.contextId = result.contextId;
    state.messages.push({
      role: "assistant",
      text: result.text,
      ...(result.state === "failed" ? { error: true } : {}),
    });
  } catch (error) {
    state.messages.push({
      role: "assistant",
      text: error instanceof Error ? error.message : String(error),
      error: true,
    });
  } finally {
    state.busy = false;
    requestUpdate?.();
    pinAgentChatToBottom(document);
  }
}

export type AgentPreviewProps = {
  agentId: string | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
  basePath: string;
  requestUpdate?: () => void;
};

function renderSidePanel(props: AgentPreviewProps, state: AgentPreviewViewState) {
  const runtime = state.runtime;
  return html`
    <section class="card">
      <div class="card-title">Deployment</div>
      <div class="card-sub">Runtime state of the previewed agent.</div>
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Agent ID</div>
        <div class="mono">${state.agentId}</div>
      </div>
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Runtime status</div>
        <div>${renderStatusPill(runtime?.status ?? "unknown")}</div>
        ${runtime?.message
          ? html`<div class="muted" style="margin-top: 6px;">${runtime.message}</div>`
          : ""}
      </div>
      ${state.version !== null
        ? html`
            <div class="agent-panel-field">
              <div class="agent-panel-field__label">Deployed spec version</div>
              <div>v${state.version}</div>
            </div>
          `
        : ""}
      ${runtime?.endpoint
        ? html`
            <div class="agent-panel-field">
              <div class="agent-panel-field__label">In-cluster endpoint</div>
              <div class="mono" style="font-size: 12px;">${runtime.endpoint}</div>
            </div>
          `
        : ""}
      <div class="row" style="margin-top: 16px; gap: 8px; flex-wrap: wrap;">
        <button
          class="btn"
          @click=${() => {
            state.messages = [];
            state.contextId = null;
            props.requestUpdate?.();
          }}
        >
          Reset conversation
        </button>
        <button
          class="btn"
          ?disabled=${state.statusLoading || !props.client}
          @click=${() =>
            props.client && void refreshRuntimeStatus(props.client, props.requestUpdate)}
        >
          ${state.statusLoading ? "Checking…" : "Refresh status"}
        </button>
        <a class="btn" href=${pathForTab("agentBuilder", props.basePath)}>Back to builder</a>
      </div>
    </section>
  `;
}

export function renderAgentPreview(props: AgentPreviewProps) {
  if (!props.agentId) {
    return html`
      <section class="card">
        <div class="card-title">Agent preview</div>
        <div class="card-sub">No agent selected.</div>
        <div class="callout info" style="margin-top: 12px;">
          Open a preview from the builder page, or use a link of the form
          <span class="mono">/agent-preview/&lt;agent-id&gt;</span>.
        </div>
        <div style="margin-top: 14px;">
          <a class="btn" href=${pathForTab("agentBuilder", props.basePath)}>Back to builder</a>
        </div>
      </section>
    `;
  }
  const state = ensureViewState(props.agentId);
  if (props.client && props.connected && !state.runtime && !state.statusLoading) {
    void refreshRuntimeStatus(props.client, props.requestUpdate);
  }
  const notRunning = state.runtime !== null && state.runtime.status !== "running";
  return html`
    <div class="agent-builder-layout">
      <div class="agent-builder-layout__chat">
        ${renderAgentChatSurface({
          title: `Preview: ${props.agentId}`,
          subtitle: "Live chat with the deployed agent running in Kagenti.",
          placeholder: "Ask the deployed agent something",
          emptyHint: notRunning
            ? "The agent is not running yet. Deploy it from the builder, then chat here."
            : "Say hello — replies come from the live agent, not a simulation.",
          messages: state.messages,
          draft: state.draft,
          busy: state.busy,
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
            void sendPreview(props.client, text, props.requestUpdate);
          },
        })}
      </div>
      <div class="agent-builder-layout__panel">${renderSidePanel(props, state)}</div>
    </div>
  `;
}
