// @ts-check

const ts = require('typescript-eslint');
const js = require('@eslint/js');
const globals = require('globals');
const stylistic = require('@stylistic/eslint-plugin');

module.exports = ts.config(
  js.configs.recommended,
  ...ts.configs.strict,
  ...ts.configs.stylistic,
  stylistic.configs.customize({
    arrowParens: true,
    semi: true,
    flat: true,
  }),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2015,
        L: 'readonly',
        variable: 'writable',
        constant: 'writable',
        TREM: 'writable',
        api: 'readonly',
        ipcRenderer: 'readonly',
        ipcMain: 'readonly',
        reportMarkers: 'readonly',
      },
    },
  },
  {
    files: [
      './src/**/*.{js}',
      'eslint.config.js',
    ],
  },
  {
    rules: {
      'curly': ['error'],
      '@typescript-eslint/no-require-imports': ['off'],
      '@typescript-eslint/no-unused-vars': ['off'],
    },
  },
);
