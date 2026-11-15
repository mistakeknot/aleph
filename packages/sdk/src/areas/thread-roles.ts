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

export interface ExperimentalThreadRoleClaimArgs extends ClaimThreadRoleRequest {
  role: string;
}

export interface ExperimentalThreadRoleTransferArgs extends TransferThreadRoleRequest {
  role: string;
}

export interface ExperimentalThreadRoleReleaseArgs extends ReleaseThreadRoleRequest {
  role: string;
}

export interface ExperimentalThreadRolesArea {
  get(
    args: ExperimentalThreadRoleGetArgs,
  ): Promise<ExperimentalThreadRoleState>;
  list(
    args?: ExperimentalThreadRoleListArgs,
  ): Promise<ExperimentalThreadRoleListResult>;
  claim(
    args: ExperimentalThreadRoleClaimArgs,
  ): Promise<ExperimentalThreadRoleState>;
  transfer(
    args: ExperimentalThreadRoleTransferArgs,
  ): Promise<ExperimentalThreadRoleState>;
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
