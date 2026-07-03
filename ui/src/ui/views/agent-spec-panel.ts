// Side panel showing the current draft AgentSpec, validation state, and
// deployment status. Shared by the agent-builder page (and later the preview
// page once deployment metadata is live).
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
};

function renderField(label: string, value: string) {
  return html`
    <div style="margin-top: 10px;">
      <div class="muted" style="font-size: 12px;">${label}</div>
      <div>${value}</div>
    </div>
  `;
}

function renderValidation(validation: AgentSpecValidationResult) {
  if (validation.ok) {
    return html`
      <div class="callout success" style="margin-top: 12px;">Spec is valid.</div>
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
      <div class="card-sub">Canonical AgentSpec edited by the builder.</div>
      ${renderField("Name", agent.name)} ${renderField("ID", agent.id)}
      ${renderField("Description", agent.description)} ${renderField("Model", model)}
      <div style="margin-top: 10px;">
        <div class="muted" style="font-size: 12px;">System prompt</div>
        <div style="white-space: pre-wrap; font-size: 13px;">${agent.systemPrompt}</div>
      </div>
      <div style="margin-top: 10px;">
        <div class="muted" style="font-size: 12px;">Tools</div>
        ${agent.tools.length === 0
          ? html`<div class="muted">No tools attached.</div>`
          : agent.tools.map(
              (tool) => html`
                <div>
                  <span class="mono">${tool.name}</span> (${tool.type}:${tool.serverRef},
                  ${tool.permissions.mode})
                </div>
              `,
            )}
      </div>
      ${renderField(
        "Deployment target",
        `${agent.runtime.platform}/${agent.runtime.protocol}, namespace ${agent.deployment.namespace}, ${agent.deployment.replicas} replica(s)`,
      )}
      <div style="margin-top: 14px;">
        <div class="muted" style="font-size: 12px;">Validation</div>
        ${renderValidation(props.validation)}
      </div>
      <div style="margin-top: 14px;">
        <div class="muted" style="font-size: 12px;">Deployment</div>
        <div><span class="pill">${props.deployment.status}</span></div>
        <div class="muted" style="margin-top: 4px;">${props.deployment.detail}</div>
      </div>
      ${props.previewHref
        ? html`
            <div style="margin-top: 14px;">
              <a class="btn" href=${props.previewHref}>Open preview chat</a>
            </div>
          `
        : nothing}
    </section>
  `;
}
