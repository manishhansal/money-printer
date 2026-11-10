const path = require('path');

/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  displayName: 'extension',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // Use an absolute path so ts-jest resolves the config correctly
        // regardless of the directory from which Jest is invoked.
        tsconfig: path.resolve(__dirname, 'tsconfig.json'),
      },
    ],
  },
  testEnvironment: 'node',
  // Runs after the Jest environment is set up — jest.fn() is available here.
  setupFilesAfterEnv: [path.resolve(__dirname, 'jest.setup.ts')],
};
