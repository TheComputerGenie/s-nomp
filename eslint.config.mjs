export default [
  {
    files: ['**/*.js'],
    ignores: ['website/static/scripts/*.js'],
    languageOptions: {
      'ecmaVersion': 2025,
      'globals': {
        '__dirname': 'readonly',
        '__filename': 'readonly',
        'algos': 'readonly',
        'BigInt': 'readonly',
        'Buffer': 'readonly',
        'console': 'readonly',
        'exports': 'readonly',
        'module': 'readonly',
        'process': 'readonly',
        'require': 'readonly'
      },
      'sourceType': 'commonjs'
    },
    'rules': {
      'brace-style': ['error', '1tbs'],
      'curly': ['error', 'all'],
      "eol-last": 1,
      'indent': ['error', 4, { 'SwitchCase': 1 }],
      'no-multiple-empty-lines': ['error', { 'max': 1 }],
      'no-prototype-builtins': 'off',
      'no-throw-literal': 'off',
      'no-trailing-spaces': 1,
      'no-var': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',
      'quotes': ['error', 'single', { 'allowTemplateLiterals': true }],
      'semi': ['error', 'always']
    },
  },
];