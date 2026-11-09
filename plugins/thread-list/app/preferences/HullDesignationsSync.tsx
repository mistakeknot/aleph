import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { threadListRpcContract } from "../../server.js";
import {
  hullDesignationsAtom,
  hullNameDesignationsAtom,
} from "./hull-designations.js";
export function HullDesignationsSync() {
  const rpc = useRpc<typeof threadListRpcContract>();
  const setDesignations = useSetAtom(hullDesignationsAtom);
  const setNames = useSetAtom(hullNameDesignationsAtom);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => rpc.call("listHullDesignations", null))
      .then((response) => {
        if (cancelled) return;
        setDesignations(response.designations);
        setNames(response.names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rpc, setDesignations, setNames]);
  return null;
}
