export default {
  testEnvironment: 'node',
  preset: 'ts-jest/presets/default-esm',
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.test.json'
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  injectGlobals: true,
  globalSetup: './tests/globalSetup.ts'
};
