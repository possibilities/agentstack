"use server";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, type Catalog } from "../dist/src/catalog.js";

export async function apiCatalog(): Promise<Catalog> {
  return loadCatalog(process.env, dirname(fileURLToPath(import.meta.url)));
}
