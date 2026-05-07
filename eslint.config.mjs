import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  tseslint.configs.recommended,
);
