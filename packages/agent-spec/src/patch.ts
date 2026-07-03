// Minimal RFC 6902 subset (add/replace/remove) for AgentSpec edits. The
// builder agent proposes patches; this helper applies them immutably and
// re-validates so callers can never hold a structurally unknown spec.
import type { AgentSpec } from "./schema.ts";
import { validateAgentSpec, type AgentSpecValidationResult } from "./validation.ts";

export type AgentSpecPatchOp =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type AgentSpecPatchResult =
  | { ok: true; spec: AgentSpec; validation: Extract<AgentSpecValidationResult, { ok: true }> }
  | { ok: false; reason: "patch"; error: string }
  | {
      ok: false;
      reason: "validation";
      validation: Extract<AgentSpecValidationResult, { ok: false }>;
    };

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function parsePointer(path: string): string[] | null {
  if (path === "" || !path.startsWith("/")) {
    return null;
  }
  return path.slice(1).split("/").map(decodePointerSegment);
}

type Container = Record<string, unknown> | unknown[];

function resolveParent(root: unknown, segments: string[]): Container | null {
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return null;
      }
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return null;
    }
  }
  return current !== null && typeof current === "object" ? (current as Container) : null;
}

function applyOpInPlace(root: unknown, op: AgentSpecPatchOp): string | null {
  const segments = parsePointer(op.path);
  if (!segments || segments.length === 0) {
    return `invalid JSON pointer: ${JSON.stringify(op.path)}`;
  }
  const parent = resolveParent(root, segments);
  if (!parent) {
    return `path not found: ${op.path}`;
  }
  const key = segments[segments.length - 1] ?? "";
  if (Array.isArray(parent)) {
    const index = key === "-" && op.op === "add" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length) {
      return `invalid array index in path: ${op.path}`;
    }
    if (op.op === "add") {
      parent.splice(index, 0, op.value);
      return null;
    }
    if (index >= parent.length) {
      return `array index out of range: ${op.path}`;
    }
    if (op.op === "remove") {
      parent.splice(index, 1);
    } else {
      parent[index] = op.value;
    }
    return null;
  }
  if (op.op === "remove") {
    if (!(key in parent)) {
      return `path not found: ${op.path}`;
    }
    delete parent[key];
    return null;
  }
  if (op.op === "replace" && !(key in parent)) {
    return `path not found: ${op.path}`;
  }
  parent[key] = op.value;
  return null;
}

export function applyAgentSpecPatch(
  spec: AgentSpec,
  ops: AgentSpecPatchOp[],
): AgentSpecPatchResult {
  const draft: unknown = structuredClone(spec);
  for (const op of ops) {
    const error = applyOpInPlace(draft, op);
    if (error) {
      return { ok: false, reason: "patch", error };
    }
  }
  const validation = validateAgentSpec(draft);
  if (!validation.ok) {
    return { ok: false, reason: "validation", validation };
  }
  return { ok: true, spec: validation.spec, validation };
}
