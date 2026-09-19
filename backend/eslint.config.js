import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'drizzle', 'contracts', 'dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // plain Node scripts (.mjs) run outside the TypeScript project, so declare the globals they use
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
  {
    rules: {
      // Spec: no `any` without an explanatory comment. Enforce via warning + review.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
