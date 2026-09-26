export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly recovery?: string;

  constructor(
    code: string,
    message: string,
    options: { exitCode?: number; recovery?: string } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.recovery = options.recovery;
  }
}
