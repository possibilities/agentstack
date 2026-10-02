"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientInput, ClientOutput } from "@stack/client/contract";
import { ClientCallError, clientCall } from "./channel";

export type LocalOperation = "client_install" | "client_platform_start" | "client_platform_stop" | "client_login_set";
export type LocalRequest = { [K in LocalOperation]: { version: 1; operation: K; input: ClientInput<K> } }[LocalOperation];
type Job = ClientOutput<"client_job_get">;
const operations: LocalOperation[] = ["client_install", "client_platform_start", "client_platform_stop", "client_login_set"];

function readRequest(text: string): LocalRequest {
  const record = JSON.parse(text);
  if (record?.version !== 1 || Object.keys(record).sort().join() !== "input,operation,version" || !operations.includes(record.operation)
    || !record.input || typeof record.input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.input.requestId)) throw new Error();
  const keys = Object.keys(record.input).sort().join();
  if (record.operation === "client_install" ? keys !== "release,requestId" || !record.input.release || typeof record.input.release !== "object"
    : record.operation === "client_login_set" ? keys !== "enabled,requestId" || typeof record.input.enabled !== "boolean" : keys !== "requestId") throw new Error();
  return record;
}

/** One root-scoped frozen local intent. No credentials or navigation URLs. Reads
 * on recovery are allowed; dispatch is ALWAYS an explicit event-handler action. */
export function useLocalRequest(scope: string) {
  const key = `stack.client.${scope}.local-request.v1`;
  const [request, setRequest] = useState<LocalRequest | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inspected, setInspected] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    try { const text = localStorage.getItem(key); if (text) setRequest(readRequest(text)); }
    catch { setError("Local recovery storage is unavailable or invalid. Dispatch is blocked; preserve and inspect this browser's saved request."); }
    setLoaded(true);
  }, [key]);
  const inspect = useCallback(async (record = request, explicit = true) => {
    if (!record) return;
    try { setJob(await clientCall("client_job_get", { id: record.input.requestId })); setError(null); }
    catch { setError("Admission unresolved. The exact saved request is retained. Inspect the snapshot before an identical retry."); }
    finally { if (explicit) setInspected(true); }
  }, [request]);
  useEffect(() => { if (request) void inspect(request, false); }, [request, inspect]);
  const dispatch = async (record: LocalRequest) => {
    setBusy(true); setError(null); setInspected(false);
    try {
      // Reverify persistence immediately before every dispatch, including retry.
      if (localStorage.getItem(key) !== JSON.stringify(record)) throw new Error("storage_changed");
    } catch {
      setError("Recovery storage changed or is unavailable. Nothing was dispatched. Preserve and inspect the saved request before retrying.");
      setBusy(false); lock.current = false; return;
    }
    try {
      const result = record.operation === "client_install" ? await clientCall(record.operation, record.input)
        : record.operation === "client_login_set" ? await clientCall(record.operation, record.input)
        : await clientCall(record.operation, record.input);
      setJob(result.job);
    } catch (error) {
      setError(error instanceof ClientCallError && ["trusted_release_required", "trusted_release_changed"].includes(error.code)
        ? `${error.message} Relaunch stack-ui with the original reviewed --release-manifest to recover this exact request; it remains frozen.`
        : "Admission unresolved. The exact saved request is retained. Inspect the job and snapshot before an identical retry.");
    } finally { setBusy(false); lock.current = false; }
  };
  const admit = async (operation: LocalOperation, values: { release?: ClientInput<"client_install">["release"]; enabled?: boolean } = {}) => {
    if (!loaded || request || lock.current || error) return;
    lock.current = true;
    let record: LocalRequest;
    try {
      const input = { requestId: crypto.randomUUID(), ...values };
      record = readRequest(JSON.stringify({ version: 1, operation, input }));
      const text = JSON.stringify(record);
      if (localStorage.getItem(key) !== null) throw new Error();
      localStorage.setItem(key, text);
      if (localStorage.getItem(key) !== text) throw new Error();
      setRequest(record); setJob(null);
    } catch {
      lock.current = false;
      setError("Could not persist the exact request. Nothing was dispatched. Local recovery storage must work before any action.");
      return;
    }
    await dispatch(record);
  };
  const retry = async () => {
    if (!request || busy || lock.current || !inspected || job) return;
    lock.current = true; await dispatch(request);
  };
  const clear = () => {
    if (!request || busy || !job || job.state === "running" || !inspected) return false;
    try {
      if (localStorage.getItem(key) !== JSON.stringify(request)) throw new Error();
      localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw new Error();
    }
    catch { setError("Could not clear recovery storage. The request remains frozen."); return false; }
    setRequest(null); setJob(null); setError(null); setInspected(false);
    return true;
  };
  const observeJob = useCallback((jobs: Job[]) => {
    if (!request) return;
    const current = jobs.find(item => item.id === request.input.requestId);
    if (current) { setJob(current); setError(null); }
  }, [request]);
  return { request, job, error, loaded, busy, inspected, admit, retry, clear, inspect, observeJob };
}
