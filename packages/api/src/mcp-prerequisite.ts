import { SocketCallError } from "./socket.js";

/** Safe diagnostic: no arguments, credentials, socket paths or native payloads. */
export function mcpPrerequisite(error: unknown, pkg: string, operation: string, prerequisite = `${pkg} private service`): unknown {
  if (!(error instanceof SocketCallError)) return error;
  const code = error.absent ? "stack_service_unavailable" : error.dispatched ? "stack_service_outcome_unknown" : "stack_service_connection_failed";
  const outcome = error.dispatched ? "Outcome unknown: request was dispatched; do not automatically retry or replay."
    : "Request not executed: no request was dispatched.";
  return new Error(`${code}\nPackage ${pkg}, operation ${operation}, prerequisite: ${prerequisite}. ${outcome} Recover the service with stack serve.`);
}
