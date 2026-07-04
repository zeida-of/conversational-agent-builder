// Side panel showing the current draft AgentSpec, validation state, git
// checkpoint/deploy sync, and deployment status. Shared by the agent-builder
// page. Everything here renders deterministic plugin state — never LLM output.
import type {
  AgentDeploymentStatus,
  AgentSpec,
  AgentSpecValidationResult,
} from "@openclaw/agent-spec";
import { html, nothing } from "lit";

/** Mirrors GitSyncStatus returned by the agent-builder plugin gateway methods. */
export type AgentBuilderGitStatus = {
  available: boolean;
  error?: string;
  hasCheckpoint: boolean;
  inSync: boolean;
  lastCommit?: { hash: string; subject: string; committedAt: number };
  remote: boolean;
};

export type AgentSpecPanelProps = {
  spec: AgentSpec;
  validation: AgentSpecValidationResult;
  deployment: { status: AgentDeploymentStatus; detail: string };
  git?: AgentBuilderGitStatus | null;
  /** null = never deployed; boolean = draft matches the deployed config. */
  deployedInSync?: boolean | null;
  previewHref: string;
  onDeploy?: () => void;
  deployBusy?: boolean;
  onCheckpoint?: () => void;
  checkpointBusy?: boolean;
  checkpointNotice?: string | null;
  onRestore?: () => void;
  restoreBusy?: boolean;
  /** Two-step confirm for the destructive reset-to-checkpoint action. */
  restoreArmed?: boolean;
  onRestoreArm?: (armed: boolean) => void;
};

function renderField(label: string, value: unknown) {
  return html`
    <div class="agent-panel-field">
      <div class="agent-panel-field__label">${label}</div>
      <div>${value}</div>
    </div>
  `;
}

export function renderStatusPill(status: string) {
  return html`<span class="agent-status-pill agent-status-pill--${status}">${status}</span>`;
}

function renderSyncPill(kind: "ok" | "warn" | "muted", label: string) {
  return html`<span class="agent-sync-pill agent-sync-pill--${kind}">${label}</span>`;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderValidation(validation: AgentSpecValidationResult) {
  if (validation.ok) {
    return html`
      <div class="callout success" style="margin-top: 8px;">Spec is valid.</div>
      ${validation.warnings.map(
        (warning) => html`
          <div class="callout warning" style="margin-top: 8px;">
            <span class="mono">${warning.path}</span> — ${warning.message}
          </div>
        `,
      )}
    `;
  }
  return html`
    ${validation.errors.map(
      (error) => html`
        <div class="callout danger" style="margin-top: 8px;">
          <span class="mono">${error.path}</span> — ${error.message}
        </div>
      `,
    )}
  `;
}

function renderVersionControl(props: AgentSpecPanelProps) {
  const git = props.git;
  if (!git) {
    return nothing;
  }
  if (!git.available) {
    return renderField(
      "Saved versions",
      html`<div class="muted">Version history unavailable: ${git.error ?? "git error"}</div>`,
    );
  }
  const syncPill = git.hasCheckpoint
    ? git.inSync
      ? renderSyncPill("ok", "Checkpoint saved")
      : renderSyncPill("warn", "Unsaved changes")
    : renderSyncPill("muted", "Never saved");
  return html`
    <div class="agent-panel-field">
      <div class="agent-panel-field__label">Saved versions</div>
      <div>${syncPill}</div>
      ${git.lastCommit
        ? html`<div class="muted agent-panel-commit">
            <span class="mono">${git.lastCommit.hash.slice(0, 7)}</span>
            · ${git.lastCommit.subject} · ${timeAgo(git.lastCommit.committedAt)}
            ${git.remote ? " · synced to git remote" : ""}
          </div>`
        : html`<div class="muted agent-panel-commit">
            Save a checkpoint to keep this configuration in version control.
          </div>`}
      ${props.checkpointNotice
        ? html`<div class="muted agent-panel-commit">${props.checkpointNotice}</div>`
        : nothing}
      <div class="row" style="margin-top: 8px; gap: 8px; flex-wrap: wrap;">
        ${props.onCheckpoint
          ? html`
              <button
                class="btn"
                ?disabled=${props.checkpointBusy ||
                !props.validation.ok ||
                (git.hasCheckpoint && git.inSync)}
                @click=${props.onCheckpoint}
              >
                ${props.checkpointBusy ? "Saving…" : "Save checkpoint"}
              </button>
            `
          : nothing}
        ${props.onRestore && git.hasCheckpoint
          ? props.restoreArmed
            ? html`
                <button class="btn danger" ?disabled=${props.restoreBusy} @click=${props.onRestore}>
                  ${props.restoreBusy ? "Resetting…" : "Confirm reset"}
                </button>
                <button class="btn" @click=${() => props.onRestoreArm?.(false)}>Cancel</button>
              `
            : html`
                <button
                  class="btn"
                  ?disabled=${git.inSync || props.restoreBusy}
                  title="Discard draft changes and go back to the last checkpoint"
                  @click=${() => props.onRestoreArm?.(true)}
                >
                  Reset to checkpoint
                </button>
              `
          : nothing}
      </div>
    </div>
  `;
}

export function renderAgentSpecPanel(props: AgentSpecPanelProps) {
  const { agent } = props.spec;
  const temperature = agent.model.temperature;
  const model = `${agent.model.provider} / ${agent.model.name}${
    temperature === undefined ? "" : ` (temp ${temperature})`
  }`;
  const deploySync =
    props.deployedInSync === undefined || props.deployedInSync === null
      ? nothing
      : props.deployedInSync
        ? renderSyncPill("ok", "Deployed config matches draft")
        : renderSyncPill("warn", "Deployed config is out of date");
  return html`
    <section class="card">
      <div class="card-title">Draft agent</div>
      <div class="card-sub">Everything the builder has configured so far.</div>
      ${renderField("Name", agent.name)}
      ${renderField("ID", html`<span class="mono">${agent.id}</span>`)}
      ${renderField("Description", agent.description)} ${renderField("Model", model)}
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">System prompt</div>
        <div style="white-space: pre-wrap; font-size: 13px;">${agent.systemPrompt}</div>
      </div>
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Tools</div>
        ${agent.tools.length === 0
          ? html`<div class="muted">No tools attached.</div>`
          : agent.tools.map(
              (tool) => html`
                <div>
                  <span class="mono">${tool.serverRef}</span>
                  <span class="muted"> · ${tool.permissions.mode}</span>
                </div>
              `,
            )}
      </div>
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Skills</div>
        ${agent.skills.length === 0
          ? html`<div class="muted">
              No skills yet. Test the agent and give feedback — the builder can turn workflows into
              skills.
            </div>`
          : agent.skills.map(
              (skill) => html`
                <div>
                  <span class="mono">${skill.name}</span>
                  ${skill.description
                    ? html`<span class="muted"> · ${skill.description}</span>`
                    : nothing}
                </div>
              `,
            )}
      </div>
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Knowledge</div>
        ${agent.knowledge.length === 0
          ? html`<div class="muted">No knowledge packs attached.</div>`
          : agent.knowledge.map((item) => html`<div class="mono">${item.packRef}</div>`)}
      </div>
      ${renderField("Memory", agent.memory.enabled ? "Remembers conversations" : "Off")}
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Validation</div>
        ${renderValidation(props.validation)}
      </div>
      ${renderVersionControl(props)}
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Deployment</div>
        <div class="row" style="gap: 8px; flex-wrap: wrap; align-items: center;">
          ${renderStatusPill(props.deployment.status)} ${deploySync}
        </div>
        <div class="muted" style="margin-top: 6px;">${props.deployment.detail}</div>
      </div>
      <div class="row" style="margin-top: 16px; gap: 8px; flex-wrap: wrap;">
        ${props.onDeploy
          ? html`
              <button
                class="btn primary"
                ?disabled=${props.deployBusy || !props.validation.ok}
                @click=${props.onDeploy}
              >
                ${props.deployBusy ? "Deploying…" : "Deploy"}
              </button>
            `
          : nothing}
        ${props.previewHref
          ? html`<a class="btn" href=${props.previewHref}>Open full-page chat</a>`
          : nothing}
      </div>
    </section>
  `;
}
