"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { firstPage, nextPage, type Page, type PageRead } from "@/lib/stack/state";

/* Owner reads shared by the state and maintenance views: keyed so another subject's data never shows, fenced so an
 * older answer never replaces a newer one, and re-run on the owner's invalidation. */

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One read, re-run when its key or invalidation changes. An older answer never replaces a newer one. */
export function useKeyedRead<T>(read: () => Promise<T>, key: string, observe: number): { data: T | null; error: string | null; loading: boolean; refresh(): void } {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key, data: null, error: null });
  const [loading, setLoading] = useState(false);
  const token = useRef(0);
  const latest = useRef(read);
  latest.current = read;
  const run = useCallback(() => {
    const mine = ++token.current;
    setLoading(true);
    latest.current().then((data) => { if (mine === token.current) setState({ key, data, error: null }); },
      (error: unknown) => { if (mine === token.current) setState((held) => ({ key, data: held.key === key ? held.data : null, error: message(error) })); })
      .finally(() => { if (mine === token.current) setLoading(false); });
  }, [key]);
  useEffect(() => { run(); return () => { token.current++; }; }, [run, observe]);
  // Data read for another key is never shown, even for the render before the new read starts.
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, loading, refresh: run };
}

/** Bounded pages of one observation; continuing after the owner changed it starts again from the first page. */
export function usePagedRead<T>(read: PageRead<T>, key: string, observe: number) {
  const [state, setState] = useState<{ key: string; page: Page<T> | null; error: string | null }>({ key, page: null, error: null });
  const [loading, setLoading] = useState(false);
  const token = useRef(0);
  const latest = useRef(read);
  latest.current = read;
  const load = useCallback((more: Page<T> | null) => {
    const mine = ++token.current;
    setLoading(true);
    (more ? nextPage(latest.current, more) : firstPage(latest.current)).then((page) => { if (mine === token.current) setState({ key, page, error: null }); },
      (error: unknown) => { if (mine === token.current) setState((held) => ({ key, page: held.key === key ? held.page : null, error: message(error) })); })
      .finally(() => { if (mine === token.current) setLoading(false); });
  }, [key]);
  useEffect(() => { load(null); return () => { token.current++; }; }, [load, observe]);
  const page = state.key === key ? state.page : null;
  return { page, error: state.key === key ? state.error : null, loading, refresh: () => load(null), more: () => { if (page) load(page); } };
}

