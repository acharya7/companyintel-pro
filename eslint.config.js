import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      eslintConfigPrettier,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    /*
     * Scope every rule back to `warn` — except the Fast Refresh boundary rule —
     * for the vendored shadcn/ui primitives and the platform-provided toolbar.
     *
     * Those files deliberately export a component *together with* its variant
     * table or hook (`Button` + `buttonVariants`, `Sidebar` + `useSidebar`), which
     * is how shadcn generates them and how every consumer imports them. The rule
     * is about whether Vite can hot-swap a module, and it is a false positive for
     * a file whose non-component export is a constant or a hook: nothing here
     * needs Fast Refresh to preserve state across an edit. Re-splitting vendored
     * primitives to satisfy it would make future `shadcn add` runs conflict.
     *
     * `src/main.tsx` is the other shape of the same false positive: it is the
     * bundle entry, which has no exports at all because it is never hot-swapped
     * (a change there reloads the page), yet it must declare small local helpers
     * such as the route fallback and the toolbar route syncer.
     */
    files: ["src/components/ui/**/*.{ts,tsx}", "vly-toolbar-readonly.tsx", "src/main.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
