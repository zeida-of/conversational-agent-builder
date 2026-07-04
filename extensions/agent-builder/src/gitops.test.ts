import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultAgentSpec } from "@openclaw/agent-spec";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentGitOps, resolveGitRepoDir, specsEqual, stableSpecJson } from "./gitops.ts";

const tempDirs: string[] = [];

async function tempRepoDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-gitops-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function gitOut(repoDir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function specWithSkill() {
  const spec = createDefaultAgentSpec({ id: "store-helper", name: "Store Helper" });
  spec.agent.skills = [
    {
      name: "order-lookup",
      description: "Deterministic order workflow.",
      instructions: "Always call the order tool before answering.",
    },
  ];
  return spec;
}

describe("agent gitops", () => {
  it("resolves the repo dir from env with the state-dir fallback", () => {
    expect(resolveGitRepoDir({ AGENT_BUILDER_GIT_DIR: "/data/repo" })).toBe("/data/repo");
    expect(resolveGitRepoDir({ OPENCLAW_STATE_DIR: "/home/node/.openclaw" })).toBe(
      "/home/node/.openclaw/generated-agents",
    );
  });

  it("compares specs by shape, not key order", () => {
    expect(specsEqual({ a: 1, b: [{ c: 2, d: 3 }] }, { b: [{ d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(specsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(stableSpecJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it("checkpoints spec, skills, and manifests into a commit", async () => {
    const repoDir = await tempRepoDir();
    const gitops = createAgentGitOps({ repoDir });
    const spec = specWithSkill();
    const result = await gitops.checkpoint({
      spec,
      manifests: { apiVersion: "v1", kind: "List", items: [] },
      message: "First save",
    });
    expect(result).toMatchObject({ ok: true, committed: true, push: "no-remote" });
    if (!result.ok) {
      return;
    }
    expect(result.commit?.subject).toBe("First save");
    expect(gitOut(repoDir, ["ls-files"]).split("\n").toSorted()).toEqual([
      "agents/store-helper/agent.json",
      "agents/store-helper/manifests.json",
      "agents/store-helper/skills/order-lookup.md",
    ]);
    const status = await gitops.status({ agentId: "store-helper", draftSpec: spec });
    expect(status).toMatchObject({
      available: true,
      hasCheckpoint: true,
      inSync: true,
      remote: false,
    });
    expect(status.lastCommit?.hash).toBe(result.commit?.hash);
  });

  it("reports out-of-sync drafts and skips empty commits", async () => {
    const repoDir = await tempRepoDir();
    const gitops = createAgentGitOps({ repoDir });
    const spec = specWithSkill();
    await gitops.checkpoint({ spec });
    const unchanged = await gitops.checkpoint({ spec });
    expect(unchanged).toMatchObject({ ok: true, committed: false });

    const edited = structuredClone(spec);
    edited.agent.systemPrompt = "You are extremely formal.";
    const status = await gitops.status({ agentId: "store-helper", draftSpec: edited });
    expect(status.inSync).toBe(false);
    expect(status.hasCheckpoint).toBe(true);
  });

  it("removes deleted skills from the next checkpoint", async () => {
    const repoDir = await tempRepoDir();
    const gitops = createAgentGitOps({ repoDir });
    const spec = specWithSkill();
    await gitops.checkpoint({ spec });
    const withoutSkill = structuredClone(spec);
    withoutSkill.agent.skills = [];
    const result = await gitops.checkpoint({ spec: withoutSkill });
    expect(result).toMatchObject({ ok: true, committed: true });
    expect(gitOut(repoDir, ["ls-files"])).not.toContain("skills/order-lookup.md");
  });

  it("restores the committed spec after draft edits", async () => {
    const repoDir = await tempRepoDir();
    const gitops = createAgentGitOps({ repoDir });
    const spec = specWithSkill();
    await gitops.checkpoint({ spec });
    const restored = await gitops.restore("store-helper");
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(specsEqual(restored.spec, spec)).toBe(true);
    }
    expect((await gitops.restore("missing-agent")).ok).toBe(false);
  });

  it("keeps separate agents in separate trees", async () => {
    const repoDir = await tempRepoDir();
    const gitops = createAgentGitOps({ repoDir });
    await gitops.checkpoint({ spec: specWithSkill() });
    const other = createDefaultAgentSpec({ id: "faq-bot", name: "FAQ Bot" });
    await gitops.checkpoint({ spec: other });
    expect(await readdir(path.join(repoDir, "agents"))).toEqual(
      expect.arrayContaining(["store-helper", "faq-bot"]),
    );
    const status = await gitops.status({ agentId: "faq-bot", draftSpec: other });
    expect(status.inSync).toBe(true);
  });
});
