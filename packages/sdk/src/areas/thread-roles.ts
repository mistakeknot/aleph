import type {
  ClaimThreadRoleRequest,
  ReleaseThreadRoleRequest,
  ThreadRoleListResponse,
  ThreadRoleStateResponse,
  TransferThreadRoleRequest,
} from "@bb/server-contract";
import {
  threadRoleListResponseSchema,
  threadRoleStateSchema,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type ExperimentalThreadRoleState = ThreadRoleStateResponse;
export type ExperimentalThreadRoleListResult = ThreadRoleListResponse;

export interface ExperimentalThreadRoleGetArgs {
  role: string;
  signal?: AbortSignal;
}

export interface ExperimentalThreadRoleListArgs {
  signal?: AbortSignal;
}

export interface ExperimentalThreadRoleClaimArgs
  extends ClaimThreadRoleRequest {
  role: string;
}

export interface ExperimentalThreadRoleTransferArgs
  extends TransferThreadRoleRequest {
  role: string;
}

export interface ExperimentalThreadRoleReleaseArgs
  extends ReleaseThreadRoleRequest {
  role: string;
}

export interface ExperimentalThreadRolesArea {
  /**
   * Read one role. A role nobody holds still answers: `threadId`, `title` and
   * `archived` are null and `generation` is the current one.
   */
  get(args: ExperimentalThreadRoleGetArgs): Promise<ExperimentalThreadRoleState>;
  /** Snapshot of every role, held or released, ordered by role name. */
  list(
    args?: ExperimentalThreadRoleListArgs,
  ): Promise<ExperimentalThreadRoleListResult>;
  /**
   * Give an unheld role to a live thread. Fails with `role_held` (details
   * carry the current state) when any thread, archived or not, holds it.
   */
  claim(
    args: ExperimentalThreadRoleClaimArgs,
  ): Promise<ExperimentalThreadRoleState>;
  /**
   * Move a held role to a live thread in one compare-and-swap. Fails with
   * `role_generation_conflict` when `expectGeneration` is no longer current.
   */
  transfer(
    args: ExperimentalThreadRoleTransferArgs,
  ): Promise<ExperimentalThreadRoleState>;
  /**
   * Leave a role unheld, keeping its generation counter. Fails with
   * `role_generation_conflict` when `expectGeneration` is no longer current.
   */
  release(
    args: ExperimentalThreadRoleReleaseArgs,
  ): Promise<ExperimentalThreadRoleState>;
}

export function createThreadRolesArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalThreadRolesArea {
  const roles = transport.api.v1["thread-roles"];
  return {
    async get(input) {
      const body = await transport.readJson(
        roles[":role"].$get(
          { param: { role: input.role } },
          ...signalRequestArgs(input.signal),
        ),
      );
      return threadRoleStateSchema.parse(body);
    },
    async list(input) {
      const body = await transport.readJson(
        roles.$get({}, ...signalRequestArgs(input?.signal)),
      );
      return threadRoleListResponseSchema.parse(body);
    },
    async claim({ role, ...json }) {
      const body = await transport.readJson(
        roles[":role"].claim.$post({ param: { role }, json }),
      );
      return threadRoleStateSchema.parse(body);
    },
    async transfer({ role, ...json }) {
      const body = await transport.readJson(
        roles[":role"].transfer.$post({ param: { role }, json }),
      );
      return threadRoleStateSchema.parse(body);
    },
    async release({ role, ...json }) {
      const body = await transport.readJson(
        roles[":role"].release.$post({ param: { role }, json }),
      );
      return threadRoleStateSchema.parse(body);
    },
  };
}
