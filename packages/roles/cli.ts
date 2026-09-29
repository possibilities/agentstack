import { socketCall, socketPath } from "@stack/api";
import type { PackageCli } from "@stack/cli";
import type { RoleCatalog } from "./src/store.js";
import { inject } from "./src/inject.js";
import { injectUsage } from "./src/inject-args.js";

export default {
  async run(args) {
    if (args[0] === "inject") {
      if (args.length === 2 && ["--help", "-h"].includes(args[1]!)) { console.log(injectUsage); return 0; }
      return inject(args.slice(1));
    }
    const call = (name: string, args: Record<string, unknown> = {}) => socketCall(socketPath("roles"), "tools/call", { name, arguments: args });
    if (args.length === 1 && args[0] === "list") {
      console.log(JSON.stringify(await call("roles_snapshot"), null, 2));
      return 0;
    }
    if ((args.length === 1 || args.length === 2) && args[0] === "snapshot") {
      const roleId = args[1] ?? (await call("roles_snapshot") as RoleCatalog).defaultRoleId;
      if (!roleId) throw new Error("no default role; create the first role before reading a snapshot");
      const snapshot = await call("role_snapshot", { roleId });
      console.log(JSON.stringify(snapshot, null, 2));
      return 0;
    }
    console.error(`usage: stack roles list | snapshot [role-id]\n${injectUsage}`);
    return 1;
  },
} satisfies PackageCli;
