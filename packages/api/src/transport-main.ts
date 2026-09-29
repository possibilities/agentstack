#!/usr/bin/env node
import { runApi } from "./run.js";

await runApi(process.argv.slice(2));
