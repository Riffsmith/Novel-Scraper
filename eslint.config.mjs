import tseslint from "typescript-eslint";

const v1UntouchedDirs = [
  "src/scraper/**",
  "src/queue/**",
  "src/epub/**",
  "src/sessions/**",
  "src/tui/**",
  "src/cookies/**",
  "src/config/**",
  "src/sites/**",
  "src/logger/**",
  "src/types.ts",
  "src/index.ts",
];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "docs/**",
      "tests/fixtures/**",
      "src/adapters/epub-archiver/templates.ts",
      "src/adapters/epub-archiver/assets.ts",
      ...v1UntouchedDirs,
    ],
  },

  ...tseslint.configs.recommended,

  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "playwright",
              message:
                "ADR-001 / AGENTS.md: new v2 code must import playwright-core, not playwright. playwright remains a dependency only for the untouched v1 reference oracle.",
            },
          ],
          patterns: [],
        },
      ],
    },
  },

  // Tests use `any` legitimately on fake page handles and mock functions.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
