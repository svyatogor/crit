import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'

export default tseslint.config(
  {
    // Build output, dependencies and generated bundles are never linted.
    ignores: ['out/**', 'node_modules/**', '*.vsix', '.vscode-test/**', 'src/vscode-git.d.ts'],
  },

  // ---- Extension + MCP server sources (type-aware) ----
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // VS Code extension house rules (from the `yo code` template).
      curly: 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'warn',
      '@typescript-eslint/naming-convention': [
        'warn',
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],

      // The extension host swallows unawaited rejections silently — these
      // two catch the most common cause of "the command did nothing".
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],

      // The extension talks to two deliberately untyped boundaries — the
      // VS Code Git API (`getGitApi()` returns `any`) and MCP/JSON-RPC
      // payloads. Keep the type-checked rules on for signal, but as
      // warnings so they don't gate `npm test`.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // VS Code interfaces (LanguageModelTool.invoke, command handlers)
      // are declared as returning a Promise, so `async` without an
      // `await` is API conformance rather than a mistake.
      '@typescript-eslint/require-await': 'off',

      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // ---- Prompt template shims (`src/prompts/*.d.md.ts`) ----
  {
    files: ['src/prompts/*.d.md.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // ---- Tests + tooling (plain CommonJS/ESM JavaScript, no type info) ----
  {
    files: ['tests/**/*.{cjs,mjs,js}', '*.{mjs,js}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Must stay last: turns off every rule Prettier owns.
  prettier,
)
