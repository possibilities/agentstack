import { codexAccounts, codexCurrentLogin, codexEventsUrl } from "./actions";
import { CodexAccounts } from "./accounts";
import { CodexShell } from "./layout";

export default async function CodexAuthPage() {
  const [accounts, initialLogin, eventsUrl] = await Promise.all([
    codexAccounts().catch(() => null),
    codexCurrentLogin().catch(() => null),
    codexEventsUrl(),
  ]);
  return (
    <CodexShell section="auth">
      <CodexAccounts initial={accounts} initialLogin={initialLogin} eventsUrl={eventsUrl} />
    </CodexShell>
  );
}
