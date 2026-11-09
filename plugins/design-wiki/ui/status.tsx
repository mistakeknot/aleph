import { cn } from "@/lib/utils";
import type { WikiStatus } from "../wiki-types.js";

export const STATUS_LABEL: Record<WikiStatus, string> = {
  ruled: "Ruled",
  "design-choice": "Design choice",
  open: "Open",
};

export const STATUS_TONE: Record<WikiStatus, string> = {
  ruled: "border-success/30 bg-success/10 text-success-foreground",
  "design-choice": "border-warning/30 bg-warning/10 text-warning-text",
  open: "border-destructive/30 bg-destructive/10 text-destructive-text",
};

export const STATUS_CELL_TONE: Record<WikiStatus, string> = {
  ruled: "bg-success/5",
  "design-choice": "bg-warning/5",
  open: "bg-destructive/5",
};

export function StatusPill(props: { status: WikiStatus; className?: string }) {
  return (
    <span
      data-wiki-status={props.status}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-none",
        STATUS_TONE[props.status],
        props.className,
      )}
    >
      {STATUS_LABEL[props.status]}
    </span>
  );
}
