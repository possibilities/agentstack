"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePubsub } from "@agentstack/api/ui/use-pubsub";
import { cancelCodexLogin, codexAccounts, codexLoginStatus, removeCodexAccount, selectCodexAccount, startCodexLogin, type Account, type LoginState } from "./actions";

const button = "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50";

export function CodexAccounts({ initial, initialLogin, eventsUrl }: { initial: Account[] | null; initialLogin: LoginState | null; eventsUrl: string | null }) {
  usePubsub(eventsUrl, ["accounts_changed"]);
  const [accounts, setAccounts] = useState(initial);
  const [login, setLogin] = useState<LoginState | null>(initialLogin);
  const loginRef = useRef<LoginState | null>(initialLogin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  function updateLogin(next: LoginState | null) {
    loginRef.current = next;
    setLogin(next);
  }

  useEffect(() => setAccounts(initial), [initial]);

  useEffect(() => {
    if (!login || login.status !== "pending") return;
    const id = login.id;
    const timer = setInterval(() => {
      void codexLoginStatus(id).then(async (next) => {
        if (loginRef.current?.id !== id || loginRef.current.status !== "pending") return;
        updateLogin(next);
        if (next.status === "complete") {
          const refreshed = await codexAccounts();
          if (loginRef.current?.id !== id) return;
          setAccounts(refreshed);
          router.refresh();
        }
      }).catch(() => {
        if (loginRef.current?.id === id) setError("Could not check Codex sign-in.");
      });
    }, 1200);
    return () => clearInterval(timer);
  }, [login?.id, login?.status, router]);

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setError(null); setNotice(`Copied the ${label}.`); }
    catch { setError(`Could not copy the ${label}.`); setNotice(null); }
  }

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Account action failed"); }
    finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="codex-accounts" className="mb-8 max-w-2xl">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="codex-accounts" className="text-base font-semibold">Accounts</h2>
        <button type="button" className={button} disabled={busy || login?.status === "pending"} onClick={() => void act(async () => { updateLogin(await startCodexLogin()); })}>Add account</button>
      </div>
      {accounts === null ? <p role="status" className="text-sm text-muted-foreground">Accounts unavailable</p> : accounts.length === 0 ? <p className="text-sm text-muted-foreground">Sign in to start a managed Codex server.</p> : (
        <ul className="divide-y divide-border" aria-label="Codex accounts">
          {accounts.map((account) => (
            <li key={account.name} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 font-mono">{account.name}</span>
              {account.active ? <span className="text-positive">Active for new servers</span> : <button type="button" className={button} disabled={busy} onClick={() => void act(async () => { setAccounts(await selectCodexAccount(account.name)); })}>Make active</button>}
              <button type="button" className={button} disabled={busy || login?.status === "pending"} onClick={() => void act(async () => { updateLogin(await startCodexLogin(account.name)); })}>Sign in again</button>
              <button type="button" className={button} disabled={busy} aria-label={`Remove ${account.name}`} onClick={() => {
                if (window.confirm(`Remove ${account.name}? Running servers keep their current account.`)) void act(async () => { setAccounts(await removeCodexAccount(account.name)); });
              }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {login?.status === "pending" ? (
        <div className="mt-4 text-sm" role="status">
          {login.authUrl && login.userCode ? (
            <>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="[overflow-wrap:anywhere]">
                    1. Open{" "}
                    <a className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus" href={login.authUrl} target="_blank" rel="noopener noreferrer">{login.authUrl}</a>
                  </span>
                  <button type="button" className={button} onClick={() => void copy(login.authUrl ?? "", "sign-in link")}>Copy URL</button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span>2. Enter this one-time code (expires in 15 minutes):</span>
                  <code className="rounded-md border border-border px-2 py-0.5 font-mono">{login.userCode}</code>
                  <button type="button" className={button} onClick={() => void copy(login.userCode ?? "", "code")}>Copy code</button>
                </div>
              </div>
              <p className="mt-2 text-muted-foreground">This page will update when sign-in finishes.</p>
            </>
          ) : <p>Preparing Codex sign-in…</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => void act(async () => { updateLogin(await startCodexLogin(login.targetAccount ?? undefined)); })}>Start over</button>
            <button type="button" className={button} disabled={busy} onClick={() => void act(async () => { await cancelCodexLogin(login.id); updateLogin(null); })}>Cancel sign-in</button>
          </div>
        </div>
      ) : null}
      {login?.status === "complete" ? <p role="status" className="mt-3 text-sm">{login.account} added.</p> : null}
      {login?.status === "failed" ? <p role="alert" className="mt-3 text-sm text-negative">{login.error}</p> : null}
      {notice ? <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-negative">{error}</p> : null}
    </section>
  );
}
