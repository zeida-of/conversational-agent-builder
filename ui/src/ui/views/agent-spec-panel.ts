// Side panel showing the current draft AgentSpec, validation state, and
// deployment status. Shared by the agent-builder page.
import type {
  AgentDeploymentStatus,
  AgentSpec,
  AgentSpecValidationResult,
} from "@openclaw/agent-spec";
import { html, nothing } from "lit";

export type AgentSpecPanelProps = {
  spec: AgentSpec;
  validation: AgentSpecValidationResult;
  deployment: { status: AgentDeploymentStatus; detail: string };
  previewHref: string;
  onDeploy?: () => void;
  deployBusy?: boolean;
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

export function renderAgentSpecPanel(props: AgentSpecPanelProps) {
  const { agent } = props.spec;
  const temperature = agent.model.temperature;
  const model = `${agent.model.provider} / ${agent.model.name}${
    temperature === undefined ? "" : ` (temp ${temperature})`
  }`;
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
      <div class="agent-panel-field">
        <div class="agent-panel-field__label">Deployment</div>
        <div>${renderStatusPill(props.deployment.status)}</div>
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
          ? html`<a class="btn" href=${props.previewHref}>Open preview chat</a>`
          : nothing}
      </div>
    </section>
  `;
}
