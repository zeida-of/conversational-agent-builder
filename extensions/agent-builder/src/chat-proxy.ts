// Preview chat proxy: forwards messages to a deployed agent's in-cluster A2A
// endpoint (JSON-RPC message/send with contextId session continuity). Targets
// are constrained to DNS-label agent ids in the managed namespace, so the UI
// can never point this at arbitrary hosts.
import { randomUUID } from "node:crypto";

const AGENT_ID_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MANAGED_NAMESPACE = "openclaw";
const AGENT_PORT = 8000;
const SEND_TIMEOUT_MS = 150_000;

export type PreviewSendResult = {
  text: string;
  contextId: string;
  /** A2A task state reported by the runtime (completed/failed/...). */
  state: string;
};

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function previewEndpointForAgent(agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`invalid agent id: ${JSON.stringify(agentId)}`);
  }
  return `http://${agentId}.${MANAGED_NAMESPACE}.svc.cluster.local:${AGENT_PORT}`;
}

type A2aResponse = {
  error?: { message?: string };
  result?: {
    contextId?: string;
    status?: {
      state?: string;
      message?: { parts?: { kind?: string; type?: string; text?: string }[] };
    };
    parts?: { kind?: string; type?: string; text?: string }[];
  };
};

function extractText(result: A2aResponse["result"]): string {
  const parts = result?.status?.message?.parts ?? result?.parts ?? [];
  return parts
    .filter((part) => part.kind === "text" || part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

export async function sendPreviewMessage(
  params: { agentId: string; message: string; contextId?: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<PreviewSendResult> {
  const endpoint = previewEndpointForAgent(params.agentId);
  const contextId = params.contextId?.trim() || randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text: params.message }],
            messageId: randomUUID(),
            contextId,
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = controller.signal.aborted
      ? "the agent took too long to answer"
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`could not reach the deployed agent: ${reason}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`the agent runtime answered HTTP ${response.status}`);
  }
  const payload = (await response.json()) as A2aResponse;
  if (payload.error) {
    throw new Error(`agent runtime error: ${payload.error.message ?? "unknown"}`);
  }
  return {
    text: extractText(payload.result) || "(the agent returned an empty reply)",
    // First turn adopts the runtime-assigned contextId, later turns keep ours.
    contextId: payload.result?.contextId ?? contextId,
    state: payload.result?.status?.state ?? "completed",
  };
}
