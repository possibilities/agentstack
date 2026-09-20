import turbo from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "artifacts/**",
      "vendor/payloads/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: { turbo },
    rules: {
      "turbo/no-undeclared-env-vars": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
