import { requireAgentBrowserSuccess, runAgentBrowser } from "./browser.js";
import { AgentscrapeBrowserError } from "./errors.js";

function fail(context: string, detail: string): AgentscrapeBrowserError {
  return new AgentscrapeBrowserError(`${context}: ${detail}`);
}

export function decodeBrowserEval(stdout: string, context = "browser eval"): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw fail(context, "agent-browser eval returned invalid JSON");
  }
}

export function decodeBrowserEvalString(stdout: string, context = "browser eval"): string {
  const value = decodeBrowserEval(stdout, context);
  if (typeof value !== "string")
    throw fail(context, "agent-browser eval returned a non-string result");
  return value;
}

export async function browserEval(
  expression: string,
  session?: string | null,
  context = "browser eval failed",
): Promise<unknown> {
  const result = await runAgentBrowser(["eval", expression], session);
  requireAgentBrowserSuccess(result, context);
  return decodeBrowserEval(result.stdout, context);
}

export async function browserEvalString(
  expression: string,
  session?: string | null,
  context = "browser eval failed",
): Promise<string> {
  const value = await browserEval(expression, session, context);
  if (typeof value !== "string")
    throw fail(context, "agent-browser eval returned a non-string result");
  return value;
}
