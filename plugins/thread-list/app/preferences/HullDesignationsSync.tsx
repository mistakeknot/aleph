import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { threadListRpcContract } from "../../server.js";
import { hullDesignationsAtom } from "./hull-designations.js";
export function HullDesignationsSync() {
  const rpc = useRpc<typeof threadListRpcContract>();
  const setDesignations = useSetAtom(hullDesignationsAtom);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => rpc.call("listHullDesignations", null))
      .then((response) => {
        if (!cancelled) setDesignations(response.designations);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rpc, setDesignations]);
  return null;
}
