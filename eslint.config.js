// @ts-check

const js = require('@eslint/js');
const globals = require('globals');
const stylistic = require('@stylistic/eslint-plugin');

/**
 * @type {import('eslint').Linter.Config[]}
 */
module.exports = [
  js.configs.recommended,
  stylistic.configs.customize({
    arrowParens: true,
    semi: true,
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
];
