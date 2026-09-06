import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

/**
 * Flat config.
 *
 * eslint-config-next 16 ships a flat config array directly, so no FlatCompat
 * shim is needed (and on ESLint 10 the shim fails outright).
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'src/generated/**',
      'next-env.d.ts',
      'coverage/**',
      'data/**',
      'media-cache/**',
      'tmp-uploads/**',
    ],
  },
  ...nextCoreWebVitals,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts', 'src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
);
