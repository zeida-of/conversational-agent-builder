// Agent Builder workspace: builder chat (edits the canonical AgentSpec), test
// chat (talks to the deployed agent), and the spec side panel — one page so
// users can improve the agent while testing it. In Learning mode, test
// exchanges are recorded for the builder agent to read when the user gives
// feedback. Chat goes through the normal gateway chat pipeline on a dedicated
// builder session; spec/validation/deployment/git state comes from the
// agent-builder plugin's gateway methods.
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
import {
  renderAgentSpecPanel,
  renderStatusPill,
  type AgentBuilderGitStatus,
} from "./agent-spec-panel.ts";

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
  git?: AgentBuilderGitStatus;
  deployedInSync?: boolean | null;
};

type CheckpointResponse = AgentBuilderGatewayState & {
  checkpoint?: {
    committed: boolean;
    commit?: { hash: string; subject: string };
    push: "pushed" | "no-remote" | "push-failed";
    warnings: string[];
  };
};

type TestChatState = {
  messages: AgentChatMessage[];
  draft: string;
  busy: boolean;
  contextId: string | null;
  learning: boolean;
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
  test: TestChatState;
  checkpointBusy: boolean;
  checkpointNotice: string | null;
  restoreArmed: boolean;
  restoreBusy: boolean;
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
    test: { messages: [], draft: "", busy: false, contextId: null, learning: true },
    checkpointBusy: false,
    checkpointNotice: null,
    restoreArmed: false,
    restoreBusy: false,
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

async function sendTestMessage(
  client: GatewayBrowserClient,
  agentId: string,
  text: string,
  requestUpdate?: () => void,
) {
  const state = ensureViewState();
  const test = state.test;
  test.messages.push({ role: "user", text });
  test.busy = true;
  requestUpdate?.();
  pinAgentChatToBottom(document);
  try {
    const result = await client.request<{ text: string; contextId: string; state: string }>(
      "agentBuilder.previewSend",
      {
        agentId,
        message: text,
        learning: test.learning,
        ...(test.contextId ? { contextId: test.contextId } : {}),
      },
    );
    test.contextId = result.contextId;
    test.messages.push({
      role: "assistant",
      text: result.text,
      ...(result.state === "failed" ? { error: true } : {}),
    });
  } catch (error) {
    test.messages.push({
      role: "assistant",
      text: error instanceof Error ? error.message : String(error),
      error: true,
    });
  } finally {
    test.busy = false;
    requestUpdate?.();
    pinAgentChatToBottom(document);
  }
}

function resetTestConversation(client: GatewayBrowserClient | null, requestUpdate?: () => void) {
  const state = ensureViewState();
  state.test.messages = [];
  state.test.contextId = null;
  // Also drop the recorded observations so builder feedback starts fresh.
  if (client) {
    client.request("agentBuilder.learningClear", {}).catch(() => undefined);
  }
  requestUpdate?.();
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

async function saveCheckpoint(client: GatewayBrowserClient, requestUpdate?: () => void) {
  const state = ensureViewState();
  state.checkpointBusy = true;
  state.checkpointNotice = null;
  requestUpdate?.();
  try {
    const response = await client.request<CheckpointResponse>("agentBuilder.checkpoint", {});
    state.panel = response;
    const checkpoint = response.checkpoint;
    if (checkpoint) {
      const parts = [
        checkpoint.committed
          ? `Saved ${checkpoint.commit?.hash.slice(0, 7) ?? ""}`.trim()
          : "No changes to save.",
        checkpoint.push === "pushed" ? "pushed to remote" : undefined,
        checkpoint.push === "push-failed" ? "push to remote failed" : undefined,
        ...checkpoint.warnings,
      ].filter(Boolean);
      state.checkpointNotice = parts.join(" · ");
    }
  } catch (error) {
    state.checkpointNotice = `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.checkpointBusy = false;
    requestUpdate?.();
  }
}

async function restoreCheckpoint(client: GatewayBrowserClient, requestUpdate?: () => void) {
  const state = ensureViewState();
  state.restoreBusy = true;
  requestUpdate?.();
  try {
    state.panel = await client.request<AgentBuilderGatewayState>(
      "agentBuilder.restoreCheckpoint",
      {},
    );
    state.checkpointNotice = "Draft reset to the last checkpoint.";
  } catch (error) {
    state.checkpointNotice = `Reset failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.restoreBusy = false;
    state.restoreArmed = false;
    requestUpdate?.();
  }
}

function renderTestPane(props: AgentBuilderProps, state: AgentBuilderViewState) {
  const panel = state.panel;
  const deployedAgentId = panel?.lastDeployedSpec?.agent.id ?? null;
  const outOfSync = panel?.deployedInSync === false;
  const headerExtra = html`
    <div class="agent-test-controls">
      ${deployedAgentId ? renderStatusPill(panel?.deploymentStatus ?? "draft") : ""}
      <label
        class="agent-learning-toggle ${state.test.learning ? "agent-learning-toggle--on" : ""}"
        title="Record this conversation so the builder can use your feedback to improve the agent"
      >
        <input
          type="checkbox"
          .checked=${state.test.learning}
          @change=${(event: Event) => {
            state.test.learning = (event.target as HTMLInputElement).checked;
            props.requestUpdate?.();
          }}
        />
        Learning mode
      </label>
      <button
        class="btn btn--small"
        ?disabled=${state.test.messages.length === 0}
        @click=${() => resetTestConversation(props.client, props.requestUpdate)}
      >
        Reset chat
      </button>
    </div>
  `;
  return renderAgentChatSurface({
    title: deployedAgentId ? `Test: ${deployedAgentId}` : "Test your agent",
    subtitle: state.test.learning
      ? "Live chat with the deployed agent. The builder is watching — give it feedback on the left."
      : "Live chat with the deployed agent running in Kagenti.",
    placeholder: deployedAgentId
      ? "Try your agent — replies come from the live deployment"
      : "Deploy the draft first",
    emptyHint: deployedAgentId
      ? "Try the agent, then tell the builder what to improve. Feedback becomes prompt, tool, and skill changes."
      : "No deployed agent yet. Deploy your draft, then test it here without leaving the builder.",
    messages: state.test.messages,
    draft: state.test.draft,
    busy: state.test.busy,
    sendDisabled: state.test.busy || !props.connected || !props.client || !deployedAgentId,
    headerExtra,
    ...(outOfSync
      ? {
          notice: {
            kind: "warning" as const,
            text: "The draft changed since this agent was deployed. Deploy again to test the latest configuration.",
          },
        }
      : {}),
    onDraftChange: (next) => {
      state.test.draft = next;
      props.requestUpdate?.();
    },
    onSend: () => {
      const text = state.test.draft.trim();
      if (!text || !props.client || state.test.busy || !deployedAgentId) {
        return;
      }
      state.test.draft = "";
      void sendTestMessage(props.client, deployedAgentId, text, props.requestUpdate);
    },
  });
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
    <div class="agent-builder-layout agent-builder-layout--workspace">
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
      <div class="agent-builder-layout__chat">${renderTestPane(props, state)}</div>
      <div class="agent-builder-layout__panel">
        ${state.panel
          ? renderAgentSpecPanel({
              spec: state.panel.draftSpec,
              validation: state.panel.validation,
              deployment: {
                status: state.panel.deploymentStatus,
                detail: deploymentDetail(state, state.panel),
              },
              git: state.panel.git ?? null,
              deployedInSync: state.panel.deployedInSync ?? null,
              previewHref: pathForAgentPreview(
                state.panel.lastDeployedSpec?.agent.id ?? state.panel.draftSpec.agent.id,
                props.basePath,
              ),
              deployBusy: state.deployBusy,
              onDeploy: () => {
                if (props.client && !state.deployBusy) {
                  void deployDraft(props.client, props.requestUpdate);
                }
              },
              checkpointBusy: state.checkpointBusy,
              checkpointNotice: state.checkpointNotice,
              onCheckpoint: () => {
                if (props.client && !state.checkpointBusy) {
                  void saveCheckpoint(props.client, props.requestUpdate);
                }
              },
              restoreBusy: state.restoreBusy,
              restoreArmed: state.restoreArmed,
              onRestoreArm: (armed) => {
                state.restoreArmed = armed;
                props.requestUpdate?.();
              },
              onRestore: () => {
                if (props.client && !state.restoreBusy) {
                  void restoreCheckpoint(props.client, props.requestUpdate);
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
