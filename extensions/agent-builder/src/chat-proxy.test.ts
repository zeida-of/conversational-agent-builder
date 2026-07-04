import { describe, expect, it } from "vitest";
import { previewEndpointForAgent, sendPreviewMessage, type FetchLike } from "./chat-proxy.ts";

function fetchReturning(payload: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => payload });
}

describe("preview chat proxy", () => {
  it("builds in-cluster endpoints only for valid agent ids", () => {
    expect(previewEndpointForAgent("kagenti-helper")).toBe(
      "http://kagenti-helper.openclaw.svc.cluster.local:8000",
    );
    expect(() => previewEndpointForAgent("Bad Id!")).toThrow(/invalid agent id/);
    expect(() => previewEndpointForAgent("evil.example.com")).toThrow(/invalid agent id/);
  });

  it("sends message/send and extracts the task reply with contextId adoption", async () => {
    let requestBody = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      requestBody = init.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            contextId: "ctx-from-agent",
            status: {
              state: "completed",
              message: { parts: [{ kind: "text", text: "hello back" }] },
            },
          },
        }),
      };
    };
    const result = await sendPreviewMessage({ agentId: "my-agent", message: "hi" }, fetchImpl);
    expect(result).toEqual({ text: "hello back", contextId: "ctx-from-agent", state: "completed" });
    const parsed = JSON.parse(requestBody) as {
      method: string;
      params: { message: { parts: { text: string }[] } };
    };
    expect(parsed.method).toBe("message/send");
    expect(parsed.params.message.parts[0]?.text).toBe("hi");
  });

  it("keeps the caller contextId on later turns", async () => {
    const result = await sendPreviewMessage(
      { agentId: "my-agent", message: "again", contextId: "ctx-mine" },
      fetchReturning({ result: { status: { state: "completed", message: { parts: [] } } } }),
    );
    expect(result.contextId).toBe("ctx-mine");
    expect(result.text).toContain("empty reply");
  });

  it("surfaces runtime errors and HTTP failures", async () => {
    await expect(
      sendPreviewMessage(
        { agentId: "my-agent", message: "x" },
        fetchReturning({ error: { message: "boom" } }),
      ),
    ).rejects.toThrow(/agent runtime error: boom/);
    await expect(
      sendPreviewMessage({ agentId: "my-agent", message: "x" }, fetchReturning({}, false, 503)),
    ).rejects.toThrow(/HTTP 503/);
    const failing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      sendPreviewMessage({ agentId: "my-agent", message: "x" }, failing),
    ).rejects.toThrow(/could not reach the deployed agent/);
  });
});
