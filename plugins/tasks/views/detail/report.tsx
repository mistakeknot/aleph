import type { ReactNode } from "react";
import type { Task } from "../../shared/contract.js";

export function ReportSection({
  status,
  report,
  children,
}: Pick<Task, "status" | "report"> & { children: ReactNode }) {
  return (
    <section aria-label="Report" className="mt-4">
      <h2 className="text-sm font-medium">Report</h2>
      {status === "done" && !report?.trim() ? (
        <p className="text-sm text-muted-foreground">Closed without a report</p>
      ) : null}
      {children}
    </section>
  );
}
