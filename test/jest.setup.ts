import * as fc from 'fast-check';

/**
 * Configure fast-check global settings for all property-based tests.
 * - numRuns: minimum 100 iterations per property test (Requirement 2.2, 2.5)
 * - verbose: show full counter-example details on failure
 */
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});
