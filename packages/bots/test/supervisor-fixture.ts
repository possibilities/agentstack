import { Supervisor, type SupervisorOptions } from "../src/supervisor.js";

/** Lifecycle tests start with a configured Role, just as they seed accounts. */
export class ConfiguredSupervisor extends Supervisor {
  constructor(options: SupervisorOptions) {
    super(options);
    const catalog = this.role.catalog();
    if (!catalog.defaultRoleId) this.role.createRole(catalog.revision, "Fixture");
  }
}
