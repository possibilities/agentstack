/** A package-owned command. Arguments start after `stack <package>`. */
export type PackageCli = {
  description?: string;
  run(args: string[]): number | void | Promise<number | void>;
};
