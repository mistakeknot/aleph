import { describe, expect, it } from "vitest";
import { releaseAllWorkerClaimsOffline } from "../../src/data/transfer-operations.js";
import { abort, allRows, claim, enqueue, retire, setup } from "../helpers/retire-fixture.js";

const BULK = 33000;

describe("abort of a large retirement", () => {
  it("returns every owned row when owned origins exceed the bind cap", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    f.db.$client
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${BULK}) INSERT INTO queued_thread_messages (id,origin_id,thread_id,content,model,reasoning_level,permission_mode,service_tier,group_with_next,payload_kind,sort_key,created_at,updated_at) SELECT 'bulk'||i,'bulk'||i,?,'[]','m','r','full','default',0,'inline',printf('k%08d',i),1,1 FROM n`,
      )
      .run(f.target.id);
    f.db.$client
      .prepare(
        `INSERT INTO transfer_entries(id,op_id,kind,origin_id,source_row_id,source_sort_key,target_row_id,state,updated_at) SELECT 'entry-'||id,?,'moved',origin_id,'source-'||id,sort_key,id,'terminal',1 FROM queued_thread_messages WHERE id LIKE 'bulk%'`,
      )
      .run(outcome.operationId);
    expect(releaseAllWorkerClaimsOffline(f.db).released).toBe(1);
    const aborted = abort(f, outcome.operationId);
    expect(aborted.kind).toBe("aborted");
    expect(allRows(f, f.source.id)).toHaveLength(BULK + 1);
    expect(allRows(f, f.target.id)).toHaveLength(0);
  }, 120000);
});
