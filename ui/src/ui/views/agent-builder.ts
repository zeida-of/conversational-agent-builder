// Agent Builder page: conversational editor for the canonical AgentSpec.
// The chat is a PLACEHOLDER until the builder backend (POST /api/builder/chat)
// lands; it never claims validation or deployment work it did not do.
import {
  createDefaultAgentSpec,
  validateAgentSpec,
  type AgentSpec,
  type AgentSpecValidationResult,
} from "@openclaw/agent-spec";
import { html } from "lit";
import { pathForAgentPreview } from "../navigation.ts";
import { renderAgentChatSurface, type AgentChatMessage } from "./agent-chat-surface.ts";
import { renderAgentSpecPanel } from "./agent-spec-panel.ts";

type AgentBuilderViewState = {
  messages: AgentChatMessage[];
  draft: string;
  spec: AgentSpec;
  validation: AgentSpecValidationResult;
};

let viewState: AgentBuilderViewState | null = null;

export function resetAgentBuilderViewState(): void {
  viewState = null;
}

function ensureViewState(): AgentBuilderViewState {
  if (!viewState) {
    const spec = createDefaultAgentSpec();
    viewState = {
      messages: [],
      draft: "",
      spec,
      validation: validateAgentSpec(spec),
    };
  }
  return viewState;
}

export type AgentBuilderProps = {
  basePath: string;
  requestUpdate?: () => void;
};

export function renderAgentBuilder(props: AgentBuilderProps) {
  const state = ensureViewState();
  const send = () => {
    const text = state.draft.trim();
    if (!text) {
      return;
    }
    state.messages.push({ role: "user", text });
    // Placeholder response until the builder chat backend exists (Milestone 4:
    // POST /api/builder/chat). Do not simulate spec edits or deployments here.
    state.messages.push({
      role: "assistant",
      text: "The builder assistant is not connected yet. This page currently shows the draft AgentSpec and local validation only; conversational editing arrives with the builder backend milestone.",
    });
    state.draft = "";
    props.requestUpdate?.();
  };
  return html`
    <div class="row" style="align-items: stretch; gap: 16px; flex-wrap: wrap;">
      <div style="flex: 2 1 420px; min-width: 320px;">
        ${renderAgentChatSurface({
          title: "Builder chat",
          subtitle: "Describe the agent you want; the builder edits the draft spec.",
          placeholder: "e.g. Build a support agent that answers questions from our docs",
          emptyHint: "No messages yet. Describe the agent you want to build.",
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
        ${renderAgentSpecPanel({
          spec: state.spec,
          validation: state.validation,
          deployment: {
            status: "draft",
            detail: "Not deployed. Kagenti deployment arrives in a later milestone.",
          },
          previewHref: pathForAgentPreview(state.spec.agent.id, props.basePath),
        })}
      </div>
    </div>
  `;
}
