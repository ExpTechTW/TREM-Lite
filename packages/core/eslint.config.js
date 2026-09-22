import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-explicit-any": "off",

      // All network access must go through the HTTP abstraction layer
      // (src/lib/http), which owns forced gzip, ETag revalidation and the
      // 250 MB SQLite LRU. Direct transports bypass every one of those.
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Use `http` from @/lib/http instead of calling fetch directly.",
        },
        {
          name: "XMLHttpRequest",
          message: "Use `http` from @/lib/http instead of XMLHttpRequest.",
        },
        {
          name: "EventSource",
          message: "Use `http.stream()` from @/lib/http for server-sent events.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tauri-apps/plugin-http",
              message: "Only src/lib/http may use plugin-http; import `http` from @/lib/http.",
            },
          ],
        },
      ],
    },
  },
  {
    // The abstraction layer itself is the one place that owns the transports.
    files: ["src/lib/http/**/*.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-imports": "off",
    },
  },
);
