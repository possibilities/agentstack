import { expect as jestExpect } from "expect";

/** Upstream Bun assertions accept an optional explanatory message. */
export const expect = Object.assign((value: unknown, _message?: string) => jestExpect(value), jestExpect) as
  typeof jestExpect & ((value: unknown, message?: string) => ReturnType<typeof jestExpect>);
