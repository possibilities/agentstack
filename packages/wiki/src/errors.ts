/** Domain failure: rendered as an ok:false envelope on stdout, exit 1. */
export class CliError extends Error {
  readonly code: string;
  readonly recovery?: string;

  constructor(code: string, message: string, recovery?: string) {
    super(message);
    this.code = code;
    if (recovery !== undefined) this.recovery = recovery;
  }
}

/** Grammar fault: usage text on stderr, exit 2 — never an envelope, so agents
 * can rely on stdout being JSON whenever a command actually ran. */
export class UsageError extends Error {}
