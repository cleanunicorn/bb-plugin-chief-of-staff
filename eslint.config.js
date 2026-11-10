// ESLint flat config. Run with `npm run lint` (part of `npm run check` and CI).
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // docs/ holds browser scripts for the README screenshots, not plugin code.
  { ignores: ["dist/", "node_modules/", "docs/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Only the classic hook rules: the v7 recommended preset adds React Compiler
      // rules whose fixes would change component behaviour.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // Tests destructure `[item, fx] = run(...)` where only `fx` is declared per step.
      "prefer-const": ["error", { destructuring: "all" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
