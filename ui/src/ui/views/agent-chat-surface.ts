// Shared chat surface used by the agent-builder and agent-preview pages.
// Deliberately independent from the gateway chat view: these pages talk to the
// agent-builder plugin APIs, not to gateway sessions.
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown.ts";

export type AgentChatMessage = {
  role: "user" | "assistant";
  text: string;
  /** Marks runtime/transport failures so they render as error bubbles. */
  error?: boolean;
};

export type AgentChatSurfaceProps = {
  title: string;
  subtitle: string;
  placeholder: string;
  emptyHint: string;
  messages: AgentChatMessage[];
  draft: string;
  /** Renders an animated typing indicator while the assistant works. */
  busy?: boolean;
  sendDisabled?: boolean;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

// Keeps the transcript pinned to the newest message across re-renders.
function autoScroll(element: Element | undefined) {
  if (element instanceof HTMLElement) {
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }
}

function renderMessage(message: AgentChatMessage) {
  const roleClass = message.role === "user" ? "agent-chat-bubble--user" : "";
  const errorClass = message.error ? "agent-chat-bubble--error" : "";
  return html`
    <div class="agent-chat-row agent-chat-row--${message.role}">
      <div class="agent-chat-bubble ${roleClass} ${errorClass}">
        ${message.role === "assistant" && !message.error
          ? html`<div class="cm-preview">${unsafeHTML(toSanitizedMarkdownHtml(message.text))}</div>`
          : html`<span style="white-space: pre-wrap;">${message.text}</span>`}
      </div>
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
    <section class="card agent-chat">
      <div class="agent-chat__header">
        <div>
          <div class="card-title">${props.title}</div>
          <div class="card-sub">${props.subtitle}</div>
        </div>
      </div>
      <div class="agent-chat__scroll">
        ${props.messages.length === 0 && !props.busy
          ? html`<div class="agent-chat__empty muted">${props.emptyHint}</div>`
          : props.messages.map(renderMessage)}
        ${props.busy
          ? html`
              <div class="agent-chat-row agent-chat-row--assistant">
                <div class="agent-chat-bubble agent-chat-bubble--typing" aria-label="Thinking">
                  <span></span><span></span><span></span>
                </div>
              </div>
            `
          : nothing}
      </div>
      <div class="agent-chat__composer">
        <textarea
          class="input"
          rows="2"
          placeholder=${props.placeholder}
          .value=${props.draft}
          @keydown=${onKeyDown}
          @input=${(event: Event) =>
            props.onDraftChange((event.target as HTMLTextAreaElement).value)}
        ></textarea>
        <button class="btn primary" ?disabled=${!canSend} @click=${props.onSend}>Send</button>
      </div>
    </section>
  `;
}

/** Views call this after appending messages so the transcript stays pinned. */
export function pinAgentChatToBottom(root: ParentNode | null | undefined) {
  autoScroll(root?.querySelector(".agent-chat__scroll") ?? undefined);
}
