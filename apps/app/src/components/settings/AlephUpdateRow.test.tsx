// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemAlephUpdateStatus } from "@bb/server-contract";
import { AlephUpdateRowView } from "./AlephUpdateRow";

afterEach(cleanup);

const DIGEST = "d".repeat(64);

function status(
  overrides: Partial<SystemAlephUpdateStatus> = {},
): SystemAlephUpdateStatus {
  return {
    activeThreadCount: 0,
    capability: "startable",
    detail: null,
    floor: { ageSeconds: 60, issuedAt: "2026-10-06T12:00:00Z", sequence: 4 },
    installed: { aleph: "0.5.3", version: "0.44.0+aleph.0.5.3" },
    predecessor: null,
    selection: "up-to-date",
    target: null,
    ...overrides,
  };
}

const AVAILABLE = status({
  selection: "available",
  target: {
    aleph: "0.5.4",
    manifestDigest: DIGEST,
    version: "0.44.0+aleph.0.5.4",
  },
});

function view(
  props: Partial<Parameters<typeof AlephUpdateRowView>[0]> & {
    status: SystemAlephUpdateStatus;
  },
) {
  const onUpdate = vi.fn();
  const onRollback = vi.fn();
  const onRecover = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AlephUpdateRowView
      name="bb server"
      request={{
        failure: null,
        finished: null,
        pending: null,
        runState: null,
        unknownMessage: null,
      }}
      onDismiss={onDismiss}
      onRecover={onRecover}
      onRollback={onRollback}
      onUpdate={onUpdate}
      {...props}
    />,
  );
  return { onDismiss, onRecover, onRollback, onUpdate };
}

describe("AlephUpdateRowView", () => {
  it("shows explicit text for the selection and the capability", () => {
    view({ status: status() });
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByText("Updates can be started from here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
  });

  it("starts an update with the target and manifest digest", () => {
    const { onUpdate } = view({ status: AVAILABLE });
    fireEvent.click(screen.getByRole("button", { name: /^update$/i }));
    expect(onUpdate).toHaveBeenCalledWith({
      confirm: "update",
      interrupt: false,
      manifestDigest: DIGEST,
      target: "0.5.4",
    });
  });

  it("labels the interrupt when threads are running and sends it", () => {
    const { onUpdate } = view({
      status: { ...AVAILABLE, activeThreadCount: 2 },
    });
    expect(screen.getByText(/2 threads are running/u)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /update and interrupt/i }),
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ interrupt: true }),
    );
  });

  it("offers a rollback to the predecessor when startable", () => {
    const { onRollback } = view({
      status: status({
        predecessor: { aleph: "0.5.2", version: "0.44.0+aleph.0.5.2" },
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: /roll back/i }));
    expect(onRollback).toHaveBeenCalledWith({
      confirm: "rollback",
      from: "0.5.3",
      interrupt: false,
      to: "0.5.2",
    });
  });

  it("offers recovery when recovery is required", () => {
    const { onRecover } = view({
      status: status({ selection: "recovery-required" }),
    });
    expect(screen.getByText("Recovery required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /recover/i }));
    expect(onRecover).toHaveBeenCalledWith({ confirm: "recover" });
  });

  it("shows no action buttons when the helper is absent", () => {
    view({ status: { ...AVAILABLE, capability: "absent" } });
    expect(
      screen.getByText("The update helper is not installed on this machine"),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the action available in command-only mode so the command can be shown", () => {
    const { onUpdate } = view({
      status: { ...AVAILABLE, capability: "command-only" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show command/i }));
    expect(onUpdate).toHaveBeenCalled();
  });

  it("shows a refusal with the root command", () => {
    view({
      status: AVAILABLE,
      request: {
        failure: {
          command: "systemctl start --no-block aleph-update@x.service",
          message: "run it from a root shell",
        },
        finished: null,
        pending: null,
        runState: null,
        unknownMessage: null,
      },
    });
    expect(screen.getByText("run it from a root shell")).toBeTruthy();
    expect(
      screen.getByText("systemctl start --no-block aleph-update@x.service"),
    ).toBeTruthy();
  });

  it("disables actions and shows progress while a request is pending", () => {
    view({
      status: AVAILABLE,
      request: {
        failure: null,
        finished: null,
        pending: {
          nonce: "a".repeat(32),
          operation: "update",
          body: {},
          sentAt: 0,
          resent: false,
        },
        runState: "running",
        unknownMessage: null,
      },
    });
    expect(screen.getByText("Update running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^update$/i })).toBeNull();
  });

  it("shows the unknown-outcome instruction instead of inferring success", () => {
    const { onDismiss } = view({
      status: AVAILABLE,
      request: {
        failure: null,
        finished: null,
        pending: {
          nonce: "a".repeat(32),
          operation: "update",
          body: {},
          sentAt: 0,
          resent: true,
        },
        runState: "not-found",
        unknownMessage: `Outcome unknown: run \`aleph-update status ${"a".repeat(32)}\` (root shell)`,
      },
    });
    expect(screen.getByText(/Outcome unknown: run/u)).toBeTruthy();
    expect(screen.queryByText("Update succeeded")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("shows the finished outcome", () => {
    view({
      status: status(),
      request: {
        failure: null,
        finished: { detail: null, nonce: "b".repeat(32), state: "rolled-back" },
        pending: null,
        runState: null,
        unknownMessage: null,
      },
    });
    expect(screen.getByText("Update failed and was rolled back")).toBeTruthy();
  });
});
