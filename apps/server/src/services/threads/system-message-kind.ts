import type { SystemMessageKind, ThreadEventTurnStatus } from "@bb/domain";
import type { TemplateId } from "@bb/templates";

const STATIC_SYSTEM_MESSAGE_KIND_BY_TEMPLATE = {
  systemMessageThreadOwnershipAssigned: "ownership-assigned",
  systemMessageThreadOwnershipRemoved: "ownership-removed",
  systemMessageChildThreadNeedsAttention: "child-needs-attention",
} satisfies Partial<Record<TemplateId, SystemMessageKind>>;

type StaticSystemMessageTemplateId =
  keyof typeof STATIC_SYSTEM_MESSAGE_KIND_BY_TEMPLATE;

export function systemMessageKindForTemplate(
  templateId: StaticSystemMessageTemplateId,
): SystemMessageKind {
  return STATIC_SYSTEM_MESSAGE_KIND_BY_TEMPLATE[templateId];
}

export function childOutcomeSystemMessageKind(
  turnStatus: ThreadEventTurnStatus,
): SystemMessageKind {
  switch (turnStatus) {
    case "completed":
      return "child-completed";
    case "failed":
      return "child-failed";
    case "interrupted":
      return "child-interrupted";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

export function systemMessageWakeCause(kind: SystemMessageKind) {
  switch (kind) {
    case "tool-result-delivered":
      return "interaction" as const;
    case "unlabeled":
      return "unknown" as const;
    case "ownership-assigned":
    case "ownership-removed":
    case "ownership-batch":
    case "child-needs-attention":
    case "child-completed":
    case "child-failed":
    case "child-interrupted":
    case "child-outcome-batch":
    case "environment-directory-updated":
      return "message" as const;
  }
}
