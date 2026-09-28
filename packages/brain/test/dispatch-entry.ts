// Test-only adapter for legacy command-contract regressions. Brain publishes no CLI.
import { main } from "../src/dispatch.js";
void main(process.argv.slice(2));
