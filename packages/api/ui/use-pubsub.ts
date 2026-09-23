"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const retryDelays = [500, 1_000, 2_000, 4_000, 8_000];

export function usePubsub(url: string | null | undefined, topic: string | readonly string[]): void {
  const router = useRouter();
  const topicKey = typeof topic === "string" ? topic : topic.join("\u0000");
  useEffect(() => {
    const topics = topicKey.split("\u0000");
    let cancelled = false;
    let socket: WebSocket | null = null;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled || timer !== undefined) return;
      const delay = retryDelays[Math.min(attempts, retryDelays.length - 1)];
      attempts += 1;
      timer = setTimeout(() => {
        timer = undefined;
        if (cancelled) return;
        router.refresh();
        if (url) connect();
        else schedule();
      }, delay);
    };

    const connect = () => {
      if (cancelled || !url) return;
      const ws = new WebSocket(url);
      socket = ws;
      ws.addEventListener("open", () => {
        for (const subscribedTopic of topics) ws.send(JSON.stringify({ type: "subscribe", topic: subscribedTopic }));
      });
      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let message: { type?: unknown; topic?: unknown };
        try {
          message = JSON.parse(event.data) as { type?: unknown; topic?: unknown };
        } catch {
          return;
        }
        if (!topics.includes(String(message.topic))) return;
        if (message.type === "subscribed") attempts = 0;
        if (message.type === "subscribed" || message.type === "event") router.refresh();
      });
      ws.addEventListener("close", () => {
        if (socket === ws) {
          socket = null;
          schedule();
        }
      });
      ws.addEventListener("error", () => ws.close());
    };

    if (url) connect();
    else schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      const current = socket;
      socket = null;
      current?.close();
    };
  }, [url, topicKey, router]);
}
