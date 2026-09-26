import ts from "typescript-compiler";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "tsconfig.json");
const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root);
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();
const roots = {
  "types": ["StatsData", "SearchData", "ContextData", "DocumentData", "ChunkData", "TagsData", "RecoveryImportReport"],
  "admission": ["AdmissionResult", "AlreadyIndexedResult"],
  "jobs": ["SafeJob", "SafeJobRecord", "RevealedJob", "JobStats", "SafeRunRecord", "DoctorReport"],
  "source-types": ["SourceListItem", "SourceDetail", "SourceStatus", "SourceSyncAdmission", "SourceSyncWaitResult"],
  "sources": ["SourceApplyResult"],
  "backup": ["BackupCreateResult", "BackupVerifyResult"],
  "recovery-online": ["RecoveryOnlineReport"],
  "worker": ["WorkerResult"],
  "dispatch": ["RetagResult"],
};

function schema(type, depth = 0) {
  if (depth > 25) throw new Error(`recursive output type: ${checker.typeToString(type)}`);
  const next = (value) => schema(value, depth + 1);
  if (type.flags & ts.TypeFlags.StringLiteral) return `z.literal(${JSON.stringify(type.value)})`;
  if (type.flags & ts.TypeFlags.NumberLiteral) return `z.literal(${type.value})`;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return `z.literal(${type.intrinsicName})`;
  if (type.flags & ts.TypeFlags.Null) return "z.null()";
  if (type.flags & ts.TypeFlags.String) return "z.string()";
  if (type.flags & ts.TypeFlags.Number) return "z.number()";
  if (type.flags & ts.TypeFlags.Boolean) return "z.boolean()";
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return "z.unknown()";
  if (type.isUnion()) {
    const members = type.types.filter((value) => !(value.flags & ts.TypeFlags.Undefined));
    const values = members.map(next);
    return values.length === 1 ? values[0] : `z.union([${values.join(", ")}])`;
  }
  if (checker.isTupleType(type)) return `z.tuple([${checker.getTypeArguments(type).map(next).join(", ")}])`;
  if (checker.isArrayType(type)) return `z.array(${next(checker.getTypeArguments(type)[0])})`;
  const index = type.getStringIndexType();
  const properties = type.getProperties();
  if (index && properties.length === 0) return `z.record(z.string(), ${next(index)})`;
  if (properties.length > 0) {
    return `z.looseObject({\n${properties.map((property) => {
      const value = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations?.[0] ?? program.getSourceFiles()[0]);
      return `  ${JSON.stringify(property.name)}: ${next(value)}${property.flags & ts.SymbolFlags.Optional ? ".optional()" : ""}`;
    }).join(",\n")}\n})`;
  }
  throw new Error(`unmapped output type: ${checker.typeToString(type)}`);
}

const declarations = [];
for (const [module, names] of Object.entries(roots)) {
  const source = program.getSourceFile(resolve(root, "src", `${module}.ts`));
  for (const name of names) {
    const node = source.statements.find((node) => node.name?.text === name);
    if (!node) throw new Error(`missing output type ${module}.${name}`);
    declarations.push(`export const ${name}Schema = ${schema(checker.getTypeAtLocation(node))};`);
  }
}
const path = resolve(root, "src/output-schemas.ts");
const generated = `// Generated from domain types by scripts/generate-output-schemas.mjs.\nimport { z } from "zod";\n\n${declarations.join("\n\n")}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== generated) throw new Error("Brain output schemas drifted; run pnpm --filter @agentstack/brain generate:schemas");
} else writeFileSync(path, generated);
