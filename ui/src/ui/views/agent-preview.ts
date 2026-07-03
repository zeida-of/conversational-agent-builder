// Agent Preview page: chat with the live Kagenti-hosted agent.
// The proxy to the deployed runtime (POST /api/agents/:agentId/chat) is a
// later milestone; until then this surface is an explicit placeholder that
// never fabricates runtime responses.
import { html } from "lit";
import { pathForTab } from "../navigation.ts";
import { renderAgentChatSurface, type AgentChatMessage } from "./agent-chat-surface.ts";

type AgentPreviewViewState = {
  agentId: string;
  messages: AgentChatMessage[];
  draft: string;
};

let viewState: AgentPreviewViewState | null = null;

export function resetAgentPreviewViewState(): void {
  viewState = null;
}

function ensureViewState(agentId: string): AgentPreviewViewState {
  if (!viewState || viewState.agentId !== agentId) {
    viewState = { agentId, messages: [], draft: "" };
  }
  return viewState;
}

export type AgentPreviewProps = {
  agentId: string | null;
  basePath: string;
  requestUpdate?: () => void;
};

function renderSidePanel(props: AgentPreviewProps, onReset: () => void) {
  return html`
    <section class="card">
      <div class="card-title">Deployment</div>
      <div class="card-sub">Runtime state of the previewed agent.</div>
      <div style="margin-top: 10px;">
        <div class="muted" style="font-size: 12px;">Agent ID</div>
        <div class="mono">${props.agentId ?? "—"}</div>
      </div>
      <div style="margin-top: 10px;">
        <div class="muted" style="font-size: 12px;">Deployed version</div>
        <div class="muted">Unknown — deployment status API not wired yet.</div>
      </div>
      <div style="margin-top: 10px;">
        <div class="muted" style="font-size: 12px;">Runtime status</div>
        <div><span class="pill">not connected</span></div>
      </div>
      <div class="row" style="margin-top: 14px; gap: 8px; flex-wrap: wrap;">
        <button class="btn" @click=${onReset}>Reset conversation</button>
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
  const send = () => {
    const text = state.draft.trim();
    if (!text) {
      return;
    }
    state.messages.push({ role: "user", text });
    // Placeholder until the preview proxy (POST /api/agents/:agentId/chat)
    // exists. Responses must come from the Kagenti runtime, never be mocked
    // as if the agent had answered.
    state.messages.push({
      role: "assistant",
      text: `The preview proxy is not connected yet, so "${props.agentId}" cannot answer. Live runtime chat arrives with the Kagenti preview milestone.`,
    });
    state.draft = "";
    props.requestUpdate?.();
  };
  return html`
    <div class="row" style="align-items: stretch; gap: 16px; flex-wrap: wrap;">
      <div style="flex: 2 1 420px; min-width: 320px;">
        ${renderAgentChatSurface({
          title: `Preview: ${props.agentId}`,
          subtitle: "Messages go to the deployed Kagenti agent.",
          placeholder: "Ask the deployed agent something",
          emptyHint: "No messages yet. Test the deployed agent here.",
          messages: state.messages,
          draft: state.draft,
          onDraftChange: (next) => {
            state.draft = next;
            props.requestUpdate?.();
          },
          onSend: send,
        })}
      </div>
      <div style="flex: 1 1 280px; min-width: 260px;">
        ${renderSidePanel(props, () => {
          state.messages = [];
          props.requestUpdate?.();
        })}
      </div>
    </div>
  `;
}
