// Shared chat surface used by the agent-builder and agent-preview pages.
// Deliberately independent from the gateway chat view: these pages talk to the
// builder/preview HTTP APIs (future milestones), not to gateway sessions.
import { html, nothing } from "lit";

export type AgentChatMessage = {
  role: "user" | "assistant";
  text: string;
};

export type AgentChatSurfaceProps = {
  title: string;
  subtitle: string;
  placeholder: string;
  emptyHint: string;
  messages: AgentChatMessage[];
  draft: string;
  sendDisabled?: boolean;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

function renderMessage(message: AgentChatMessage) {
  const roleLabel = message.role === "user" ? "You" : "Assistant";
  return html`
    <div class="agent-chat-message" style="margin-bottom: 12px;">
      <div class="muted" style="font-size: 12px; margin-bottom: 2px;">${roleLabel}</div>
      <div style="white-space: pre-wrap;">${message.text}</div>
    </div>
  `;
}

export function renderAgentChatSurface(props: AgentChatSurfaceProps) {
  const canSend = !props.sendDisabled && props.draft.trim().length > 0;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (canSend) {
        props.onSend();
      }
    }
  };
  return html`
    <section class="card" style="display: flex; flex-direction: column; min-height: 360px;">
      <div>
        <div class="card-title">${props.title}</div>
        <div class="card-sub">${props.subtitle}</div>
      </div>
      <div class="list" style="flex: 1; margin-top: 16px; overflow-y: auto;">
        ${props.messages.length === 0
          ? html`<div class="muted">${props.emptyHint}</div>`
          : props.messages.map(renderMessage)}
      </div>
      <div class="row" style="margin-top: 12px; gap: 8px; align-items: flex-end;">
        <textarea
          class="input"
          style="flex: 1; resize: vertical; min-height: 44px;"
          rows="2"
          placeholder=${props.placeholder}
          .value=${props.draft}
          @keydown=${onKeyDown}
          @input=${(event: Event) =>
            props.onDraftChange((event.target as HTMLTextAreaElement).value)}
        ></textarea>
        <button class="btn primary" ?disabled=${!canSend} @click=${props.onSend}>Send</button>
      </div>
      ${props.sendDisabled
        ? html`<div class="muted" style="margin-top: 6px;">Sending…</div>`
        : nothing}
    </section>
  `;
}
