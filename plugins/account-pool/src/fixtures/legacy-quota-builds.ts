import type Database from "better-sqlite3";
import { z } from "zod";
import { EMPTY_FAMILY_WEEKLY, quotaSchema } from "../contracts.js";
import type { AccountQuota } from "../contracts.js";

export const LEGACY_MIGRATION_COUNT = 8;

const legacyQuotaRowSchema = z
  .object({
    account_id: z.string().uuid(),
    five_hour_utilization: z.number().nullable(),
    five_hour_reset_at: z.number().int().nullable(),
    five_hour_status: z.string().nullable(),
    seven_day_utilization: z.number().nullable(),
    seven_day_reset_at: z.number().int().nullable(),
    seven_day_status: z.string().nullable(),
    representative_claim: z.string().nullable(),
    bucket_exhaustion_json: z.string(),
    family_weekly_json: z.string(),
    limit_windows_json: z.string(),
    extra_usage_json: z.string(),
    usage_restriction_json: z.string(),
    observed_at: z.number().int().nullable(),
    held_until: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const LEGACY_QUOTA_COLUMNS = Object.keys(legacyQuotaRowSchema.shape);

export type LegacyBuild = "old" | "a0";

export class LegacyQuotaStore {
  constructor(
    private readonly db: Database.Database,
    private readonly build: LegacyBuild,
  ) {}

  get(accountId: string): AccountQuota {
    const columns =
      this.build === "a0" ? LEGACY_QUOTA_COLUMNS.join(", ") : "*";
    const row = legacyQuotaRowSchema
      .optional()
      .parse(
        this.db
          .prepare(`SELECT ${columns} FROM account_quota WHERE account_id = ?`)
          .get(accountId),
      );
    if (row === undefined) return emptyQuota(accountId);
    return quotaSchema.parse({
      accountId: row.account_id,
      fiveHourUtilization: row.five_hour_utilization,
      fiveHourResetAt: row.five_hour_reset_at,
      fiveHourStatus: row.five_hour_status,
      sevenDayUtilization: row.seven_day_utilization,
      sevenDayResetAt: row.seven_day_reset_at,
      sevenDayStatus: row.seven_day_status,
      representativeClaim: row.representative_claim,
      familyWeekly: JSON.parse(row.family_weekly_json),
      limitWindows: JSON.parse(row.limit_windows_json),
      extraUsage: JSON.parse(row.extra_usage_json),
      usageRestriction: JSON.parse(row.usage_restriction_json),
      observedAt: row.observed_at,
      heldUntil: row.held_until,
      error: row.error,
    });
  }

  put(quota: AccountQuota): void {
    const value = quotaSchema.parse(quota);
    this.db
      .prepare(
        `INSERT INTO account_quota (
          account_id, five_hour_utilization, five_hour_reset_at,
          five_hour_status, seven_day_utilization, seven_day_reset_at,
          seven_day_status, representative_claim, bucket_exhaustion_json,
          family_weekly_json, limit_windows_json, extra_usage_json, usage_restriction_json, observed_at, held_until, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          five_hour_utilization = excluded.five_hour_utilization,
          five_hour_reset_at = excluded.five_hour_reset_at,
          five_hour_status = excluded.five_hour_status,
          seven_day_utilization = excluded.seven_day_utilization,
          seven_day_reset_at = excluded.seven_day_reset_at,
          seven_day_status = excluded.seven_day_status,
          representative_claim = excluded.representative_claim,
          family_weekly_json = excluded.family_weekly_json,
          limit_windows_json = excluded.limit_windows_json,
          extra_usage_json = excluded.extra_usage_json,
          usage_restriction_json = excluded.usage_restriction_json,
          observed_at = excluded.observed_at,
          held_until = excluded.held_until,
          error = excluded.error`,
      )
      .run(
        value.accountId,
        value.fiveHourUtilization,
        value.fiveHourResetAt,
        value.fiveHourStatus,
        value.sevenDayUtilization,
        value.sevenDayResetAt,
        value.sevenDayStatus,
        value.representativeClaim,
        JSON.stringify(value.familyWeekly),
        JSON.stringify(value.limitWindows),
        JSON.stringify(value.extraUsage),
        JSON.stringify(value.usageRestriction),
        value.observedAt,
        value.heldUntil,
        value.error,
      );
  }

  remove(accountId: string): void {
    this.db
      .prepare("DELETE FROM account_quota WHERE account_id = ?")
      .run(accountId);
  }
}

export function emptyQuota(accountId: string): AccountQuota {
  return quotaSchema.parse({
    accountId,
    usageRestriction: null,
    extraUsage: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
  });
}
