import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,

  // Правила, требующие информации о типах, применяются только к исходникам,
  // входящим в tsconfig. Конфигурационные .js-файлы в проект не входят.
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
  })),
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // CLAUDE.md § 3 п. 15: any запрещён, внешние данные валидируются через zod
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',

      // CLAUDE.md § 3 п. 16: компонент не содержит доменных расчётов.
      // Деньги считаются на сервере либо в domain/, но не в JSX.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'decimal.js',
              message:
                'Денежные расчёты не живут в компонентах. Используйте значения с сервера ' +
                'или функции из src/domain/ (CLAUDE.md § 3 п. 16).',
            },
          ],
        },
      ],

      // CLAUDE.md § 3 п. 2: текущее время берётся из useClock(), а не из часов
      // браузера. Запрещается именно ЧТЕНИЕ текущего момента; разбор строки
      // даты (new Date(iso)) законен и необходим для отображения.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() запрещён: текущее время приходит от сервера через useClock() (ADR-014).',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Date.now() запрещён: текущее время приходит от сервера через useClock() (ADR-014).',
        },
      ],
    },
  },
  {
    // В слое domain/ расчёты разрешены — для этого он и существует
    files: ['src/domain/**/*.ts', 'src/shared/format/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Модуль часов — единственное место, где Date создаётся напрямую.
    // Ровно так же на сервере исключён core/clock.py.
    files: ['src/shared/clock/**/*.ts', 'src/mocks/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test-setup.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
