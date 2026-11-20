import { z } from "zod";
import schema from "./cujgel.schema.json";
import type { ParsedWikiPage } from "./wiki-page.js";
import type { ClaimMarker } from "./wiki-types.js";

const validator = z.fromJSONSchema(
  schema as Parameters<typeof z.fromJSONSchema>[0],
);
type Entry = string | Record<string, string>;
interface Spec {
  cuj_id: string;
  version: string;
  status?: "draft" | "derived" | "validated" | "superseded";
  actor: string;
  trigger: string;
  steps: { step: string; build_surface?: string[] }[];
  mental_model: string;
  success_condition: string;
  ambiguity_ledger?: { closed_decisions?: Entry[]; open_questions?: Entry[] };
  implied_features?: Entry[];
  evidence?: Record<string, string>[];
  reference_lineage?: Record<string, string>[];
  provenance?: Record<string, string>[];
}

export function parseCujgelPage(input: {
  path: string;
  content: string;
}): ParsedWikiPage {
  const fail = (message: string): ParsedWikiPage => ({
    ok: false,
    error: { kind: "cuj", path: input.path, message },
  });
  if (new TextEncoder().encode(input.content).length > 512 * 1024)
    return fail("Spec is larger than 512 KB");
  let data: unknown;
  try {
    data = JSON.parse(input.content);
  } catch {
    return fail("Invalid JSON spec");
  }
  const parsed = validator.safeParse(data);
  if (!parsed.success)
    return fail(`Unsupported or invalid spec fields: ${parsed.error.message}`);
  const spec = parsed.data as Spec;
  const lines: string[] = [];
  const claims: ClaimMarker[] = [];
  const title = spec.cuj_id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const literal = (value: string) => {
    const longest = Math.max(
      2,
      ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = "`".repeat(longest + 1);
    lines.push(fence, value, fence, "");
  };
  const section = (name: string, value: string) => {
    lines.push(`## ${name}`, "");
    literal(value);
  };
  const entries = (
    name: string,
    values: Entry[] | undefined,
    defaults: Record<string, string> = {},
  ) => {
    if (values === undefined) return;
    lines.push(`## ${name}`, "");
    values.forEach((entry, index) => {
      lines.push(`### ${index + 1}`, "");
      const fields = typeof entry === "string" ? { value: entry } : entry;
      for (const [key, value] of Object.entries({ ...defaults, ...fields }))
        section(key, value);
    });
  };
  lines.push(`# ${title}`, "");
  section("CUJ identifier", spec.cuj_id);
  section("Journey version", spec.version);
  section("Actor", spec.actor);
  section("Trigger", spec.trigger);
  lines.push("## Steps", "");
  spec.steps.forEach((step, index) => {
    lines.push(`### Step ${index + 1}`, "");
    literal(step.step);
    entries("Build surface", step.build_surface);
  });
  section("Mental model", spec.mental_model);
  section("Success condition", spec.success_condition);
  for (const [name, values, status, shade] of [
    [
      "Closed decisions",
      spec.ambiguity_ledger?.closed_decisions,
      "design-choice",
      "confidence",
    ],
    ["Open questions", spec.ambiguity_ledger?.open_questions, "open", "gate"],
  ] as const) {
    if (values === undefined) continue;
    lines.push(`## ${name}`, "");
    for (const entry of values) {
      const fields = typeof entry === "string" ? { value: entry } : entry;
      const label = status === "open" ? "Open" : "Design choice";
      const context = JSON.stringify(fields).replace(
        /[&<>*`\[\]\\]/g,
        (char) => `&#${char.charCodeAt(0)};`,
      );
      lines.push(`**${label}**: ${context}`, "");
      claims.push({
        status,
        label,
        cards: [],
        line: lines.slice(0, -2).join("\n").split("\n").length + 1,
      });
      for (const [key, value] of Object.entries({
        [shade]: "unspecified",
        ...fields,
      }))
        section(key, value);
    }
  }
  entries("Implied features", spec.implied_features, { phase: "unspecified" });
  entries("Evidence", spec.evidence);
  entries("Reference lineage", spec.reference_lineage);
  entries("Provenance", spec.provenance, { autonomy: "unspecified" });
  return {
    ok: true,
    page: {
      id: `cujgel:${spec.cuj_id}`,
      kind: "cuj",
      path: input.path,
      source: input.path,
      title,
      status: null,
      pageSource: {
        type: "cujgel",
        status: spec.status ?? "unspecified",
        version: spec.version,
      },
      card: null,
      updated: null,
      body: lines.join("\n"),
      claims,
    },
  };
}
