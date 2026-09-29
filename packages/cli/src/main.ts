#!/usr/bin/env node
import { dispatch } from "./dispatch.js";
import { workspaceRoot } from "./root.js";

try { process.exitCode = await dispatch(process.argv.slice(2), workspaceRoot(import.meta.dirname)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
