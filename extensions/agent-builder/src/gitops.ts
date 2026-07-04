// Git checkpoint store for built agents ("gitopsify" the builder output).
// Each checkpoint commits the canonical AgentSpec plus its skills and the
// rendered Kubernetes manifests into the generated-agents repository that the
// deployment bootstraps on the durable volume (see k8s/openclaw/06-deployment).
// The KV draft stays the live editing state; git holds durable, diffable
// versions a GitOps pipeline can consume — and once a version is committed and
// deployed, the served agent can only change through a new builder commit.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSpec } from "@openclaw/agent-spec";

export type GitRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const GIT_TIMEOUT_MS = 30_000;

export const runGit: GitRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Push/fetch against an unreachable remote must not hang the gateway.
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

export function resolveGitRepoDir(env: Record<string, string | undefined> = process.env): string {
  if (env.AGENT_BUILDER_GIT_DIR) {
    return env.AGENT_BUILDER_GIT_DIR;
  }
  const stateDir = env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "generated-agents");
}

/** Key-sorted JSON so checkpoints diff cleanly and equality is shape-based. */
export function stableSpecJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).toSorted()) {
        out[key] = sort((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function specsEqual(a: unknown, b: unknown): boolean {
  return stableSpecJson(a) === stableSpecJson(b);
}

export type GitCommitInfo = { hash: string; subject: string; committedAt: number };

export type GitCheckpointResult =
  | {
      ok: true;
      committed: boolean;
      commit?: GitCommitInfo;
      push: "pushed" | "no-remote" | "push-failed";
      warnings: string[];
    }
  | { ok: false; error: string };

export type GitSyncStatus = {
  available: boolean;
  error?: string;
  hasCheckpoint: boolean;
  /** Draft spec matches the last committed agent.json for this agent. */
  inSync: boolean;
  lastCommit?: GitCommitInfo;
  remote: boolean;
};

export type GitRestoreResult = { ok: true; spec: unknown } | { ok: false; error: string };

export type AgentGitOps = {
  checkpoint(params: {
    spec: AgentSpec;
    manifests?: unknown;
    message?: string;
  }): Promise<GitCheckpointResult>;
  status(params: { agentId: string; draftSpec: AgentSpec }): Promise<GitSyncStatus>;
  restore(agentId: string): Promise<GitRestoreResult>;
};

function agentTreePath(agentId: string): string {
  return path.posix.join("agents", agentId);
}

function skillFileText(skill: {
  name: string;
  description?: string;
  instructions: string;
}): string {
  const header = `# Skill: ${skill.name}`;
  const description = skill.description ? `\n\n${skill.description}` : "";
  return `${header}${description}\n\n${skill.instructions}\n`;
}

export function createAgentGitOps(options?: { repoDir?: string; git?: GitRunner }): AgentGitOps {
  const repoDir = options?.repoDir ?? resolveGitRepoDir();
  const rawGit = options?.git ?? runGit;
  const git = (args: string[]) => rawGit(["-C", repoDir, ...args]);

  async function ensureRepo(): Promise<void> {
    await mkdir(repoDir, { recursive: true });
    const check = await git(["rev-parse", "--git-dir"]);
    if (check.code !== 0) {
      const init = await git(["init", "-b", "main"]);
      if (init.code !== 0) {
        // Older git without -b support.
        const fallback = await git(["init"]);
        if (fallback.code !== 0) {
          throw new Error(`git init failed: ${fallback.stderr.trim()}`);
        }
      }
    }
    // Commits need an identity; only fill it in when none is configured so the
    // pod-level global identity (set at container start) wins when present.
    if ((await git(["config", "user.email"])).code !== 0) {
      await git(["config", "user.email", "agent-builder@openclaw.local"]);
      await git(["config", "user.name", "OpenClaw Agent Builder"]);
    }
  }

  async function lastCommitFor(agentId: string): Promise<GitCommitInfo | undefined> {
    const log = await git(["log", "-1", "--format=%H%x1f%s%x1f%ct", "--", agentTreePath(agentId)]);
    if (log.code !== 0 || !log.stdout.trim()) {
      return undefined;
    }
    const [hash, subject, committedAt] = log.stdout.trim().split("\x1f");
    if (!hash || !committedAt) {
      return undefined;
    }
    return { hash, subject: subject ?? "", committedAt: Number(committedAt) * 1000 };
  }

  async function checkpointedSpec(agentId: string): Promise<unknown> {
    const show = await git(["show", `HEAD:${agentTreePath(agentId)}/agent.json`]);
    if (show.code !== 0) {
      return undefined;
    }
    try {
      return JSON.parse(show.stdout);
    } catch {
      return undefined;
    }
  }

  async function hasRemote(): Promise<boolean> {
    return (await git(["remote", "get-url", "origin"])).code === 0;
  }

  return {
    async checkpoint({ spec, manifests, message }) {
      const warnings: string[] = [];
      try {
        await ensureRepo();
        const agentId = spec.agent.id;
        const treeDir = path.join(repoDir, "agents", agentId);
        // Rewrite the whole agent tree so removed skills/manifests disappear
        // from the commit instead of lingering as stale files.
        await rm(treeDir, { recursive: true, force: true });
        await mkdir(treeDir, { recursive: true });
        await writeFile(path.join(treeDir, "agent.json"), stableSpecJson(spec));
        if (spec.agent.skills.length > 0) {
          await mkdir(path.join(treeDir, "skills"), { recursive: true });
          for (const skill of spec.agent.skills) {
            await writeFile(path.join(treeDir, "skills", `${skill.name}.md`), skillFileText(skill));
          }
        }
        if (manifests !== undefined) {
          await writeFile(path.join(treeDir, "manifests.json"), stableSpecJson(manifests));
        } else {
          warnings.push("Rendered manifests were unavailable; committed the spec only.");
        }

        const add = await git(["add", "-A", "--", agentTreePath(agentId)]);
        if (add.code !== 0) {
          return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
        }
        const staged = await git(["diff", "--cached", "--quiet", "--", agentTreePath(agentId)]);
        const committed = staged.code !== 0;
        if (committed) {
          const subject = message?.trim() || `Checkpoint ${agentId}`;
          const commit = await git(["commit", "-m", subject, "--", agentTreePath(agentId)]);
          if (commit.code !== 0) {
            return { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
          }
        }
        // Push even when nothing new was committed so an earlier failed push
        // heals on the next checkpoint attempt.
        let push: "pushed" | "no-remote" | "push-failed" = "no-remote";
        if (await hasRemote()) {
          const branch = process.env.OPENCLAW_GENERATED_AGENTS_GIT_BRANCH || "main";
          const pushed = await git(["push", "origin", `HEAD:${branch}`]);
          push = pushed.code === 0 ? "pushed" : "push-failed";
          if (push === "push-failed") {
            warnings.push(`Committed locally, but pushing failed: ${pushed.stderr.trim()}`);
          }
        }
        return { ok: true, committed, commit: await lastCommitFor(agentId), push, warnings };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async status({ agentId, draftSpec }) {
      try {
        await ensureRepo();
        const saved = await checkpointedSpec(agentId);
        return {
          available: true,
          hasCheckpoint: saved !== undefined,
          inSync: saved !== undefined && specsEqual(saved, draftSpec),
          lastCommit: await lastCommitFor(agentId),
          remote: await hasRemote(),
        };
      } catch (error) {
        return {
          available: false,
          error: error instanceof Error ? error.message : String(error),
          hasCheckpoint: false,
          inSync: false,
          remote: false,
        };
      }
    },

    async restore(agentId) {
      try {
        await ensureRepo();
        const saved = await checkpointedSpec(agentId);
        if (saved === undefined) {
          return { ok: false, error: `No checkpoint exists for agent "${agentId}".` };
        }
        // Clean the working tree back to the commit too, so the next status
        // and checkpoint start from exactly the committed content.
        await git(["checkout", "HEAD", "--", agentTreePath(agentId)]);
        return { ok: true, spec: saved };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
