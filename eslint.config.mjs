import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  tseslint.configs.recommended,
  {
    // The circleci plugin is the in-tree proof that a plugin can be built
    // from the public `roost/plugin` surface alone.
    files: ["src/orchestrator/plugins/circleci/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^\\.\\./(?!\\.\\./plugin-api\\.js$)",
          message: "circleci imports roost internals only via ../../plugin-api.js (the roost/plugin surface).",
        }],
      }],
    },
  },
);
