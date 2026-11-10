import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Only the two classic rules: the plugin's `recommended` preset also
      // turns on the React Compiler rules, which ask for behavioural changes.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    // Injected into the BB page to produce the README screenshots.
    files: ["docs/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // `[item, fx] = run(...)` reassigns `item` while `fx` is written once.
      "prefer-const": ["error", { destructuring: "all" }],
      // `try { ... } catch {}` is used where a failure is deliberately ignored.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
