import js from "@eslint/js";
import html from "eslint-plugin-html";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", ".venv/**", "test-results/**", "playwright-report/**", "coverage/**", "tests/js/fixtures/prev/**"] },
  {
    files: ["index.html"],
    plugins: { html },
    languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: { ...globals.browser } },
    rules: { ...js.configs.recommended.rules }
  },
  {
    files: ["sw.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: { ...globals.serviceworker } },
    rules: { ...js.configs.recommended.rules }
  },
  {
    files: ["tests/**/*.{js,mjs}", "eval/**/*.{js,mjs}", "playwright.config.mjs", "eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node, ...globals.browser } },
    rules: { ...js.configs.recommended.rules }
  }
];
