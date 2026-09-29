import { socketCall, socketPath } from "@stack/api";
import type { PackageCli } from "@stack/cli";

export default {
  async run(args) {
    if (args.length === 1 && args[0] === "snapshot") {
      const snapshot = await socketCall(socketPath("roles"), "tools/call", { name: "role_snapshot", arguments: {} });
      console.log(JSON.stringify(snapshot, null, 2));
      return 0;
    }
    console.error("usage: stack roles snapshot");
    return 1;
  },
} satisfies PackageCli;
