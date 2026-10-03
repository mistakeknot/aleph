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
  /**
   * Discriminated-union branches: discriminator key -> value -> the branch's
   * own node. Only the branch whose discriminator matches the actual value is
   * entered, so one event type's constraints never apply to another's fields.
   */
  variants: Map<string, Map<string, StructuralNode>>;
  /** Closed string constants (enum / literal values) allowed at this position. */
  constants: Set<string>;
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
  discriminator?: string;
  checks?: Array<{ _zod?: { def?: { check?: string } } }>;
}

function defOf(schema: unknown): SchemaDef | null {
  const zod = (schema as { _zod?: { def?: SchemaDef } } | null)?._zod;
  return zod?.def ?? null;
}

function childOf(node: StructuralNode, key: string): StructuralNode {
  let child = node.children.get(key);
  if (child === undefined) {
    child = newNode();
    node.children.set(key, child);
  }
  return child;
}

function newNode(): StructuralNode {
  return {
    children: new Map(),
    terminal: false,
    variants: new Map(),
    constants: new Set(),
  };
}

function variantOf(
  node: StructuralNode,
  discriminator: string,
  value: string,
): StructuralNode {
  let byValue = node.variants.get(discriminator);
  if (byValue === undefined) {
    byValue = new Map();
    node.variants.set(discriminator, byValue);
  }
  let variant = byValue.get(value);
  if (variant === undefined) {
    variant = newNode();
    byValue.set(value, variant);
  }
  return variant;
}

/** String values a discriminator field of an object option can take. */
function discriminatorValues(option: unknown, discriminator: string): string[] {
  const def = defOf(option);
  if (def?.type !== "object") {
    return [];
  }
  const field = defOf(def.shape?.[discriminator]);
  if (field?.type === "literal") {
    return (field.values ?? []).filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (field?.type === "enum") {
    return Object.values(
      (field.entries ?? {}) as Record<string, unknown>,
    ).filter((value): value is string => typeof value === "string");
  }
  return [];
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
      const values =
        def.discriminator === undefined
          ? []
          : discriminatorValues(option, def.discriminator);
      if (def.discriminator === undefined || values.length === 0) {
        visit(option, node, key, seen, depth + 1);
        continue;
      }
      for (const value of values) {
        visit(
          option,
          variantOf(node, def.discriminator, value),
          key,
          seen,
          depth + 1,
        );
      }
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
    for (const value of Object.values(
      (def.entries ?? {}) as Record<string, unknown>,
    )) {
      if (typeof value === "string") {
        node.constants.add(value);
      }
    }
  } else if (type === "literal") {
    const strings = (def.values ?? []).filter(
      (value): value is string => typeof value === "string",
    );
    if (strings.length > 0) {
      node.terminal = true;
      for (const value of strings) {
        node.constants.add(value);
      }
    }
  } else if (type === "string") {
    // Only identity and routing values are structural: ids, and extension
    // kinds (`.refine(isExtensionKind)` on a `kind` key). Content constraints
    // (nonblank text, URL format, length limits) do not make a string
    // structural: such prose is redacted and then repaired to a placeholder
    // that satisfies the constraint (see `repairSchemaViolations`).
    const customChecked = (def.checks ?? []).some(
      (check) => check._zod?.def?.check === "custom",
    );
    if (isIdLikeKey(key) || (customChecked && key === "kind")) {
      node.terminal = true;
    }
  }
}

let cached: StructuralNode | null = null;

/** Root of the structural-position trie for every thread event type. */
export function getStructuralRoot(): StructuralNode {
  if (cached === null) {
    const root = newNode();
    visit(threadEventSchema, root, null, new Map(), 0);
    cached = root;
  }
  return cached;
}

/**
 * Frontier for the payload of an event of `type`: the shared root plus the
 * branch of that event type. Unknown types only get the shared fields.
 */
export function structuralFrontierForType(type: string): StructuralNode[] {
  return enterStructural([getStructuralRoot()], { type });
}

/**
 * Adds the discriminated-union branches selected by `value`'s own
 * discriminator fields (`item.type`, ...) to a frontier.
 */
export function enterStructural(
  frontier: readonly StructuralNode[],
  value: unknown,
): StructuralNode[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return frontier as StructuralNode[];
  }
  const entered: StructuralNode[] = [];
  for (const node of frontier) {
    entered.push(node);
    for (const [discriminator, byValue] of node.variants) {
      const actual = (value as Record<string, unknown>)[discriminator];
      const variant =
        typeof actual === "string" &&
        Object.prototype.hasOwnProperty.call(
          value as Record<string, unknown>,
          discriminator,
        )
          ? byValue.get(actual)
          : undefined;
      if (
        variant !== undefined &&
        !frontier.includes(variant) &&
        !entered.includes(variant)
      ) {
        entered.push(variant);
      }
    }
  }
  return entered;
}

/** Nodes reached from an entered `frontier` by one path segment (array index => `*`). */
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

/**
 * Dotted structural paths (`*` for index/record key). `variantType` selects
 * one event type's branch (`type`), `variantItem` one item branch.
 */
export function listStructuralPaths(
  options: { eventType?: string; itemType?: string } = {},
): string[] {
  const out: string[] = [];
  const walk = (
    node: StructuralNode,
    path: string[],
    itemType: string | undefined,
  ): void => {
    if (node.terminal) {
      out.push(path.join("."));
    }
    for (const [key, child] of node.children) {
      walk(child, [...path, key], itemType);
    }
    for (const [discriminator, byValue] of node.variants) {
      for (const [value, variant] of byValue) {
        if (path.length === 0 && options.eventType !== undefined) {
          if (discriminator === "type" && value !== options.eventType) continue;
        }
        if (
          path.length === 1 &&
          path[0] === "item" &&
          options.itemType !== undefined &&
          discriminator === "type" &&
          value !== options.itemType
        ) {
          continue;
        }
        walk(variant, path, itemType);
      }
    }
  };
  walk(getStructuralRoot(), [], options.itemType);
  return [...new Set(out)].sort();
}

/**
 * Frontier at `path` of a payload (`root`) of an event of `type`, following the
 * discriminated-union branches the value itself selects.
 */
export function structuralFrontierAt(
  type: string,
  root: unknown,
  path: readonly PropertyKey[],
): StructuralNode[] {
  let frontier = structuralFrontierForType(type);
  let current = root;
  for (const key of path) {
    frontier = stepStructural(enterStructural(frontier, current), String(key));
    current =
      typeof current === "object" && current !== null
        ? (current as Record<PropertyKey, unknown>)[key]
        : undefined;
  }
  return frontier;
}

// ---------------------------------------------------------------------------
// Schema repair
// ---------------------------------------------------------------------------

interface IssueLike {
  code?: string;
  path?: PropertyKey[];
  origin?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  errors?: IssueLike[][];
}

/** Leaf issues, descending into the best-matching branch of unions. */
function leafIssues(issues: readonly IssueLike[], out: IssueLike[]): void {
  for (const issue of issues) {
    if (issue.code === "invalid_union" && (issue.errors?.length ?? 0) > 0) {
      let best: IssueLike[] | undefined;
      for (const branch of issue.errors ?? []) {
        if (best === undefined || branch.length < best.length) {
          best = branch;
        }
      }
      leafIssues(best ?? [], out);
    } else {
      out.push(issue);
    }
  }
}

function getAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function setAt(
  root: unknown,
  path: readonly PropertyKey[],
  value: unknown,
): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (typeof parent === "object" && parent !== null && last !== undefined) {
    (parent as Record<PropertyKey, unknown>)[last] = value;
  }
}

const REPAIR_SCOPES = [
  { kind: "thread" },
  { kind: "turn", turnId: "repair" },
] as const;

const MAX_LADDER_PASSES = 12;
const PAD_CHARACTER = ".";
const PLACEHOLDER = "[redacted]";
const URL_PLACEHOLDER = "https://redacted.invalid/";

/** Issues of the best-matching envelope, or `null` when `value` is valid. */
function validationIssues(
  type: string,
  value: unknown,
  isFullEvent: boolean,
): IssueLike[] | null {
  // Data-only payloads get a synthetic envelope; the scope kind depends on the
  // event type, so take whichever one leaves fewer issues.
  const candidates = isFullEvent
    ? [value]
    : REPAIR_SCOPES.map((scope) => ({
        type,
        threadId: "thr_repair",
        providerThreadId: "repair",
        scope,
        ...(value as Record<string, unknown>),
      }));
  let issues: IssueLike[] | null = null;
  for (const candidate of candidates) {
    const parsed = threadEventSchema.safeParse(candidate);
    if (parsed.success) {
      return null;
    }
    const found: IssueLike[] = [];
    leafIssues(parsed.error.issues as unknown as IssueLike[], found);
    if (issues === null || found.length < issues.length) {
      issues = found;
    }
  }
  return issues;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" || typeof b === "string") {
    return a === b;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function fitLength(text: string, issues: readonly IssueLike[]): string {
  let next = text;
  for (const issue of issues) {
    if (issue.origin !== "string") {
      continue;
    }
    if (issue.code === "too_big" && issue.maximum !== undefined) {
      next = next.slice(0, Number(issue.maximum));
    } else if (issue.code === "too_small" && issue.minimum !== undefined) {
      next = next.padEnd(Number(issue.minimum), PAD_CHARACTER);
    }
  }
  return next;
}

/**
 * Makes redaction schema-safe, failing closed. Redacting changes string
 * lengths and can rewrite a value a schema constrains (format, refinement,
 * length, size of a container); the redacted copy is validated against
 * `threadEventSchema` and every position it broke is repaired in place with a
 * value derived from the *redacted* copy or a fixed placeholder, never from the
 * original text:
 *
 * - string: length-fitted redacted text, then a placeholder (plain, URL, then
 *   unique per path) fitted to the length bounds; a closed schema constant
 *   (enum/literal) that redaction rewrote is restored, as constants carry no
 *   secret;
 * - container (object/array refinements such as a byte-size limit): every
 *   non-structural string under it masked, then the container emptied.
 *
 * When a path stays invalid, the whole event's free text is masked (`maskAt`
 * at the root) and repaired again. Only an event that was valid before
 * redaction is repaired that way; positions the redaction left untouched on an
 * already-invalid event are never "repaired" into something else.
 *
 * `sanitized` must be a private copy: it is edited in place (the root is
 * replaced only by the whole-event mask). Returns the repaired value.
 */
export function repairSchemaViolations<T extends object>(
  type: string,
  original: unknown,
  sanitized: T,
  isFullEvent: boolean,
  maskAt: (root: unknown, path: readonly PropertyKey[]) => unknown,
): T {
  let originalValid: boolean | null = null;
  const wasValid = (): boolean => {
    originalValid ??= validationIssues(type, original, isFullEvent) === null;
    return originalValid;
  };
  const touched = (root: unknown, path: readonly PropertyKey[]): boolean =>
    !sameValue(getAt(original, path), getAt(root, path)) || wasValid();

  const ladder = (start: unknown): unknown => {
    let root = start;
    const attempts = new Map<string, number>();
    for (let pass = 0; pass < MAX_LADDER_PASSES; pass += 1) {
      const issues = validationIssues(type, root, isFullEvent);
      if (issues === null) {
        return root;
      }
      const byPath = new Map<
        string,
        { path: PropertyKey[]; issues: IssueLike[] }
      >();
      for (const issue of issues) {
        const path = issue.path ?? [];
        if (path.length === 0 || !touched(root, path)) {
          continue;
        }
        const id = JSON.stringify(path.map(String));
        const entry = byPath.get(id) ?? { path: [...path], issues: [] };
        entry.issues.push(issue);
        byPath.set(id, entry);
      }
      if (byPath.size === 0) {
        return root;
      }
      let progressed = false;
      for (const [id, { path, issues: pathIssues }] of byPath) {
        const after = getAt(root, path);
        const candidates: unknown[] = [];
        if (typeof after === "string") {
          const before = getAt(original, path);
          const constants = structuralFrontierAt(type, root, path).flatMap(
            (node) => [...node.constants],
          );
          if (typeof before === "string" && constants.includes(before)) {
            candidates.push(before);
          }
          const lengthOnly = pathIssues.every(
            (issue) =>
              issue.origin === "string" &&
              (issue.code === "too_big" || issue.code === "too_small"),
          );
          if (lengthOnly) {
            candidates.push(fitLength(after, pathIssues));
          }
          for (const placeholder of [
            PLACEHOLDER,
            URL_PLACEHOLDER,
            `[redacted:${path.join(".")}]`,
            "",
          ]) {
            candidates.push(fitLength(placeholder, pathIssues));
          }
        } else if (typeof after === "object" && after !== null) {
          candidates.push(maskAt(root, path));
          candidates.push(Array.isArray(after) ? [] : {});
        }
        const attempt = attempts.get(id) ?? 0;
        const next = candidates.filter(
          (candidate, index) =>
            candidates.findIndex((other) => sameValue(other, candidate)) ===
            index,
        )[attempt];
        attempts.set(id, attempt + 1);
        if (next !== undefined && !sameValue(next, after)) {
          setAt(root, path, next);
          progressed = true;
        } else if (next !== undefined) {
          // Same value as now: skip to the next candidate on the next pass.
          progressed = true;
        }
      }
      if (!progressed) {
        return root;
      }
    }
    return root;
  };

  let root: unknown = ladder(sanitized);
  const remaining = validationIssues(type, root, isFullEvent);
  if (remaining === null) {
    return root as T;
  }
  const failClosed = remaining.some((issue) => {
    const path = issue.path ?? [];
    return path.length === 0 || touched(root, path);
  });
  if (!failClosed) {
    return root as T;
  }
  root = maskAt(root, []);
  return ladder(root) as T;
}
