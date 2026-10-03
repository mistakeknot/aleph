/**
 * Schema-derived "structural" positions of thread events.
 *
 * Credential redaction replaces known secret values wherever they are echoed.
 * That must never rewrite a value the event schema constrains (enums,
 * literals, format-checked strings, ids): a secret that happens to equal
 * `completed` or `toolCall` would otherwise turn a valid event into one the
 * server rejects. The positions are derived from `threadEventSchema` itself
 * (once, lazily), so a new enum field is protected without a second list.
 *
 * Free-form subtrees (`z.unknown()`, records of unknowns, JSON values) never
 * carry a terminal node, so an attacker-chosen key such as `result.status`
 * is not protected.
 */
import { threadEventSchema } from "./provider-event.js";

export interface StructuralNode {
  children: Map<string, StructuralNode>;
  terminal: boolean;
}

/** Child key that matches any array index or record key. */
const WILDCARD = "*";
const MAX_SCHEMA_DEPTH = 40;

interface SchemaDef {
  type?: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  items?: unknown[];
  options?: unknown[];
  left?: unknown;
  right?: unknown;
  innerType?: unknown;
  in?: unknown;
  out?: unknown;
  valueType?: unknown;
  entries?: unknown;
  values?: unknown[];
  checks?: Array<{ _zod?: { def?: { check?: string } } }>;
}

function defOf(schema: unknown): SchemaDef | null {
  const zod = (schema as { _zod?: { def?: SchemaDef } } | null)?._zod;
  return zod?.def ?? null;
}

function childOf(node: StructuralNode, key: string): StructuralNode {
  let child = node.children.get(key);
  if (child === undefined) {
    child = { children: new Map(), terminal: false };
    node.children.set(key, child);
  }
  return child;
}

function isIdLikeKey(key: string | null): boolean {
  return key !== null && (key === "id" || /Id$/.test(key));
}

const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
]);

function visit(
  schema: unknown,
  node: StructuralNode,
  key: string | null,
  seen: Map<StructuralNode, Set<unknown>>,
  depth: number,
): void {
  const def = defOf(schema);
  // Recursive schemas (JSON values) only ever add non-terminal nodes.
  if (def === null || depth > MAX_SCHEMA_DEPTH) {
    return;
  }
  let visited = seen.get(node);
  if (visited === undefined) {
    visited = new Set();
    seen.set(node, visited);
  }
  if (visited.has(schema)) {
    return;
  }
  visited.add(schema);

  const type = def.type ?? "";
  if (WRAPPER_TYPES.has(type)) {
    visit(def.innerType, node, key, seen, depth + 1);
  } else if (type === "object") {
    for (const [childKey, child] of Object.entries(def.shape ?? {})) {
      visit(child, childOf(node, childKey), childKey, seen, depth + 1);
    }
  } else if (type === "array") {
    visit(def.element, childOf(node, WILDCARD), null, seen, depth + 1);
  } else if (type === "tuple") {
    for (const item of def.items ?? []) {
      visit(item, childOf(node, WILDCARD), null, seen, depth + 1);
    }
  } else if (type === "record") {
    visit(def.valueType, childOf(node, WILDCARD), null, seen, depth + 1);
  } else if (type === "union") {
    for (const option of def.options ?? []) {
      visit(option, node, key, seen, depth + 1);
    }
  } else if (type === "intersection") {
    visit(def.left, node, key, seen, depth + 1);
    visit(def.right, node, key, seen, depth + 1);
  } else if (type === "pipe") {
    visit(def.in, node, key, seen, depth + 1);
    visit(def.out, node, key, seen, depth + 1);
  } else if (type === "lazy") {
    const inner = (schema as { _zod?: { innerType?: unknown } })._zod
      ?.innerType;
    visit(inner, node, key, seen, depth + 1);
  } else if (type === "enum") {
    node.terminal = true;
  } else if (type === "literal") {
    if ((def.values ?? []).some((value) => typeof value === "string")) {
      node.terminal = true;
    }
  } else if (type === "string") {
    const formatChecked = (def.checks ?? []).some(
      (check) => check._zod?.def?.check === "string_format",
    );
    if (formatChecked || isIdLikeKey(key)) {
      node.terminal = true;
    }
  }
}

let cached: StructuralNode | null = null;

/** Root of the structural-position trie for every thread event type. */
export function getStructuralRoot(): StructuralNode {
  if (cached === null) {
    const root: StructuralNode = { children: new Map(), terminal: false };
    visit(threadEventSchema, root, null, new Map(), 0);
    cached = root;
  }
  return cached;
}

/** Nodes reached from `frontier` by one path segment (array index => `*`). */
export function stepStructural(
  frontier: readonly StructuralNode[],
  key: string,
): StructuralNode[] {
  const next: StructuralNode[] = [];
  for (const node of frontier) {
    const exact = node.children.get(key);
    if (exact !== undefined) {
      next.push(exact);
    }
    if (key !== WILDCARD) {
      const wild = node.children.get(WILDCARD);
      if (wild !== undefined) {
        next.push(wild);
      }
    }
  }
  return next;
}

export const STRUCTURAL_ARRAY_KEY = WILDCARD;

export function isStructuralTerminal(
  frontier: readonly StructuralNode[],
): boolean {
  return frontier.some((node) => node.terminal);
}

/** Dotted structural paths (`*` for index/record key), for tests. */
export function listStructuralPaths(): string[] {
  const out: string[] = [];
  const walk = (node: StructuralNode, path: string[]): void => {
    if (node.terminal) {
      out.push(path.join("."));
    }
    for (const [key, child] of node.children) {
      walk(child, [...path, key]);
    }
  };
  walk(getStructuralRoot(), []);
  return out.sort();
}
