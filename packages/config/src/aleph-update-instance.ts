export const ALEPH_INSTANCE_GRAMMAR = {
  schema: "aleph-update-instance-grammar/1",
  unit_template: "aleph-update@{instance}.service",
  fields: {
    version: "(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})",
    digest: "[0-9a-f]{64}",
    consent: "[ni]",
    nonce: "[0-9a-f]{32}",
  },
  operations: {
    update: {
      layout: ["update", "version", "digest", "consent", "nonce"],
      server: true,
    },
    rollback: {
      layout: ["rollback", "version:from", "version:to", "consent", "nonce"],
      server: true,
    },
    recover: {
      layout: ["recover", "nonce"],
      server: true,
    },
    adopt: {
      layout: ["adopt", "version", "digest", "consent", "nonce"],
      server: false,
    },
  },
} as const;

type FieldKind = keyof typeof ALEPH_INSTANCE_GRAMMAR.fields;
type Operation = keyof typeof ALEPH_INSTANCE_GRAMMAR.operations;

export type ParsedAlephInstance =
  | {
      operation: "update";
      version: string;
      digest: string;
      interrupt: boolean;
      nonce: string;
    }
  | {
      operation: "adopt";
      version: string;
      digest: string;
      interrupt: boolean;
      nonce: string;
    }
  | {
      operation: "rollback";
      from: string;
      to: string;
      interrupt: boolean;
      nonce: string;
    }
  | { operation: "recover"; nonce: string };

const FIELD_PATTERNS = ALEPH_INSTANCE_GRAMMAR.fields;

const OPERATIONS = Object.keys(
  ALEPH_INSTANCE_GRAMMAR.operations,
) as Operation[];

function fieldKind(slot: string): FieldKind | null {
  const kind = slot.split(":", 1)[0] ?? "";
  return kind in FIELD_PATTERNS ? (kind as FieldKind) : null;
}

function slotName(slot: string): string {
  return slot.includes(":") ? (slot.split(":")[1] ?? slot) : slot;
}

function operationPattern(operation: Operation, capture: boolean): string {
  const parts = ALEPH_INSTANCE_GRAMMAR.operations[operation].layout.map(
    (slot) => {
      const kind = fieldKind(slot);
      if (kind === null) return slot;
      return capture
        ? `(?<${slotName(slot)}>${FIELD_PATTERNS[kind]})`
        : FIELD_PATTERNS[kind];
    },
  );
  return parts.join("_");
}

const PARSERS = OPERATIONS.map((operation) => ({
  operation,
  regex: new RegExp(`^${operationPattern(operation, true)}$`, "u"),
}));

const NONCE_REGEX = new RegExp(`^${FIELD_PATTERNS.nonce}$`, "u");
const VERSION_REGEX = new RegExp(`^${FIELD_PATTERNS.version}$`, "u");
const DIGEST_REGEX = new RegExp(`^${FIELD_PATTERNS.digest}$`, "u");

export const ALEPH_UPDATE_PROBE_INSTANCE = `recover_${"0".repeat(32)}`;

export function isAlephNonce(value: string): boolean {
  return NONCE_REGEX.test(value);
}

export function parseAlephInstance(
  instance: string,
): ParsedAlephInstance | null {
  for (const { operation, regex } of PARSERS) {
    const groups = regex.exec(instance)?.groups;
    if (groups === undefined) continue;
    const nonce = groups["nonce"] ?? "";
    const interrupt = groups["consent"] === "i";
    switch (operation) {
      case "update":
      case "adopt":
        return {
          operation,
          version: groups["version"] ?? "",
          digest: groups["digest"] ?? "",
          interrupt,
          nonce,
        };
      case "rollback":
        return {
          operation,
          from: groups["from"] ?? "",
          to: groups["to"] ?? "",
          interrupt,
          nonce,
        };
      case "recover":
        return { operation, nonce };
    }
  }
  return null;
}

function requireValid(regex: RegExp, value: string, label: string): string {
  if (!regex.test(value)) {
    throw new Error(`${label} is not valid for an update instance`);
  }
  return value;
}

function consent(interrupt: boolean): string {
  return interrupt ? "i" : "n";
}

export function buildUpdateInstance(args: {
  version: string;
  digest: string;
  interrupt: boolean;
  nonce: string;
}): string {
  return [
    "update",
    requireValid(VERSION_REGEX, args.version, "version"),
    requireValid(DIGEST_REGEX, args.digest, "digest"),
    consent(args.interrupt),
    requireValid(NONCE_REGEX, args.nonce, "nonce"),
  ].join("_");
}

export function buildRollbackInstance(args: {
  from: string;
  to: string;
  interrupt: boolean;
  nonce: string;
}): string {
  return [
    "rollback",
    requireValid(VERSION_REGEX, args.from, "from version"),
    requireValid(VERSION_REGEX, args.to, "to version"),
    consent(args.interrupt),
    requireValid(NONCE_REGEX, args.nonce, "nonce"),
  ].join("_");
}

export function buildRecoverInstance(args: { nonce: string }): string {
  return ["recover", requireValid(NONCE_REGEX, args.nonce, "nonce")].join("_");
}

export function alephInstanceUnit(instance: string): string {
  if (parseAlephInstance(instance) === null) {
    throw new Error("instance does not match the update grammar");
  }
  return ALEPH_INSTANCE_GRAMMAR.unit_template.replace("{instance}", instance);
}

export function alephPolkitUnitPattern(): string {
  const alternatives = OPERATIONS.filter(
    (operation) => ALEPH_INSTANCE_GRAMMAR.operations[operation].server,
  ).map((operation) => operationPattern(operation, false));
  const [prefix = "", suffix = ""] =
    ALEPH_INSTANCE_GRAMMAR.unit_template.split("{instance}");
  const escape = (text: string): string =>
    text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return `^${escape(prefix)}(?:${alternatives.join("|")})${escape(suffix)}$`;
}
