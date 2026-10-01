import { enrollmentOrigin } from "./enrollment.js";
import { connectionSchema, type ConnectionDescriptor } from "./connection-schema.js";
export { connectionSchema, uiHandoffInput, uiHandoffSchema, uiExchangeInput, type ConnectionDescriptor } from "./connection-schema.js";

/** Advertised destinations are hints authenticated by HTTPS, not tailnet evidence. */
export function connectionDescriptor(serverId: string, env: NodeJS.ProcessEnv): ConnectionDescriptor {
  const deviceOrigin = enrollmentOrigin(env);
  const artifact = new URL(deviceOrigin);
  artifact.port = env.STACK_ACCESS_ARTIFACT_PORT ?? "8944";
  return connectionSchema.parse({ version: 1, serverId, deviceOrigin, documentOrigin: deviceOrigin,
    artifactOrigin: artifact.origin, uiOrigin: env.STACK_ACCESS_UI_ORIGIN ?? null,
    pairing: ["manual", "invitation", "sponsor"] });
}
