import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// P1-P5 production paths must route tool execution through executeToolCall()
// and never call ToolRegistry.execute() directly. The two selectors below catch
// both the free variable (`registry.execute(`) and the member access
// (`this.registry.execute(`) forms. loop.ts remains an explicitly deferred
// legacy path (E3); tests legitimately exercise the public execute() API.
const NO_DIRECT_REGISTRY_EXECUTE = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='execute'][callee.object.name='registry']",
    message:
      'Use executeToolCall() instead of ToolRegistry.execute() in production paths.',
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='execute'][callee.object.type='MemberExpression'][callee.object.object.type='ThisExpression'][callee.object.property.name='registry']",
    message:
      'Use executeToolCall() instead of ToolRegistry.execute() in production paths.',
  },
];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-restricted-syntax': ['error', ...NO_DIRECT_REGISTRY_EXECUTE],
    },
  },
  {
    // Deferred legacy path (E3) and tests still call ToolRegistry.execute()
    // directly and are outside the unified execution migration scope.
    files: ['src/agent/loop.ts', 'src/__tests__/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.js', '*.mjs', '*.cjs'],
  }
);
