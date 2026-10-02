"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientOutput } from "@stack/client/contract";
import { clientCall } from "./channel";

type Observation = { snapshot: ClientOutput<"client_snapshot">; peers: ClientOutput<"client_connection_list">; at: number };
export function useClientObservation() {
  const [observation, setObservation] = useState<Observation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const controller = new AbortController(), events = new EventSource("/api/client/events");
    let busy = false, dirty = false;
    const refresh = async () => {
      if (busy) { dirty = true; return; }
      busy = true;
      do {
        dirty = false;
        try {
          const [snapshot, peers] = await Promise.all([clientCall("client_snapshot", {}, controller.signal), clientCall("client_connection_list", {}, controller.signal)]);
          if (!controller.signal.aborted) { setObservation({ snapshot, peers, at: Date.now() }); setError(null); }
        } catch (error) {
          if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Client observation unavailable.");
        } finally { if (!controller.signal.aborted) setLoading(false); }
      } while (dirty && !controller.signal.aborted);
      busy = false;
    };
    // Snapshot only after subscribe acknowledgement, including reconnects.
    events.addEventListener("ready", () => { refreshRef.current = refresh; void refresh(); });
    events.addEventListener("client_changed", () => void refresh());
    events.addEventListener("session_expired", () => {
      events.close(); controller.abort(); setLoading(false);
      setError("Client session expired. Run stack-ui to reconnect. The last observation is retained.");
    });
    const unavailable = () => { setLoading(false); setError("Client updates unavailable: the host may have disconnected or your session may have expired. The last observation is retained. Run stack-ui to reconnect if needed."); };
    events.addEventListener("unavailable", unavailable); events.onerror = unavailable;
    return () => { refreshRef.current = async () => {}; controller.abort(); events.close(); };
  }, []);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { observation, error, loading, refresh };
}
