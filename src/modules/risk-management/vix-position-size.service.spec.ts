/**
 * VixPositionSizeService unit + property-based tests.
 *
 * Coverage:
 *   updateVix / getMaxLots / isPositionSizeReduced
 *     - Unit: VIX above threshold → REDUCED, getMaxLots returns protection limit
 *     - Unit: VIX below threshold for < 5 min → still REDUCED
 *     - Unit: VIX below threshold for exactly 5 min → NORMAL, event emitted
 *     - Unit: VIX spikes above threshold again after restoration → immediately REDUCED
 *     - Unit: isPositionSizeReduced reflects current state
 *     - Unit: initial state is NORMAL
 *     - Property 14: VIX position size round-trip (Req 9.7, 9.10)
 *
 * Requirements: 9.7, 9.10
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import fc from 'fast-check';

import {
  VixPositionSizeService,
  VIX_POSITION_SIZE_RESTORED_EVENT,
} from './vix-position-size.service';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Default config values — mirrors the service defaults. */
const DEFAULT_CONFIG: Record<string, number> = {
  UNUSUAL_VOLATILITY_VIX_THRESHOLD: 20.0,
  VOLATILITY_PROTECTION_LIMIT_LOTS: 2,
  NORMAL_MAX_LOTS_PER_SIGNAL: 10,
  VIX_RESTORE_CONTINUOUS_MINUTES: 5,
};

function buildConfigService(overrides: Partial<Record<string, number>> = {}) {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  return {
    get: jest.fn(<T>(key: string): T | undefined => merged[key] as unknown as T),
  };
}

interface BuildServiceOptions {
  configOverrides?: Partial<Record<string, number>>;
}

async function buildService(opts: BuildServiceOptions = {}): Promise<{
  service: VixPositionSizeService;
  mockEventEmitter: { emit: jest.Mock };
}> {
  const mockEventEmitter = { emit: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      VixPositionSizeService,
      { provide: ConfigService, useValue: buildConfigService(opts.configOverrides) },
      { provide: EventEmitter2, useValue: mockEventEmitter },
    ],
  }).compile();

  return {
    service: module.get<VixPositionSizeService>(VixPositionSizeService),
    mockEventEmitter,
  };
}

/**
 * Advance the internal `belowThresholdSince` clock by manipulating Date.now.
 * Returns a cleanup function to restore the original Date.
 */
function mockDateNow(offsetMs: number): () => void {
  const realNow = Date.now.bind(Date);
  const realDateConstructor = global.Date;

  // We need to mock both `new Date()` and `Date.now()` used inside the service.
  // The service uses `new Date()` for `now` — we patch it via a mock.
  const fakeNow = realNow() + offsetMs;

  const MockDate = class extends realDateConstructor {
    constructor(...args: ConstructorParameters<typeof realDateConstructor>) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((args as any[]).length === 0) {
        super(fakeNow);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        super(...(args as [any]));
      }
    }
    static now() {
      return fakeNow;
    }
  } as unknown as typeof Date;

  global.Date = MockDate;
  return () => {
    global.Date = realDateConstructor;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('VixPositionSizeService', () => {
  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts in NORMAL state with normal max lots', async () => {
    const { service } = await buildService();
    expect(service.getMaxLots()).toBe(10);
    expect(service.isPositionSizeReduced()).toBe(false);
  });

  // ── VIX above threshold → REDUCED ─────────────────────────────────────────

  it('transitions to REDUCED when VIX exceeds the threshold', async () => {
    const { service } = await buildService();

    service.updateVix(20.01); // just above 20.0

    expect(service.isPositionSizeReduced()).toBe(true);
    expect(service.getMaxLots()).toBe(2); // VOLATILITY_PROTECTION_LIMIT_LOTS
  });

  it('stays REDUCED on repeated above-threshold VIX updates', async () => {
    const { service } = await buildService();

    service.updateVix(25);
    service.updateVix(30);
    service.updateVix(22);

    expect(service.isPositionSizeReduced()).toBe(true);
    expect(service.getMaxLots()).toBe(2);
  });

  it('returns VOLATILITY_PROTECTION_LIMIT_LOTS (not normal limit) when REDUCED', async () => {
    const { service } = await buildService({
      configOverrides: {
        UNUSUAL_VOLATILITY_VIX_THRESHOLD: 20.0,
        VOLATILITY_PROTECTION_LIMIT_LOTS: 3,
        NORMAL_MAX_LOTS_PER_SIGNAL: 15,
      },
    });

    service.updateVix(25);

    expect(service.getMaxLots()).toBe(3);
  });

  // ── VIX below threshold for < 5 min → still REDUCED ───────────────────────

  it('remains REDUCED when VIX drops below threshold but has not been there for 5 minutes', async () => {
    const { service } = await buildService();

    // First spike to REDUCED
    service.updateVix(25);
    expect(service.isPositionSizeReduced()).toBe(true);

    // Drop below threshold — but only 4 minutes and 59 seconds have elapsed
    const restoreMs = 5 * 60 * 1000;
    const cleanup = mockDateNow(restoreMs - 1000); // 1 second short of 5 minutes
    try {
      service.updateVix(19);
      expect(service.isPositionSizeReduced()).toBe(true);
      expect(service.getMaxLots()).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('resets the restoration timer when VIX spikes back above threshold mid-countdown', async () => {
    const { service } = await buildService();

    // Spike to REDUCED
    service.updateVix(25);

    // Drop below — start timer
    service.updateVix(19); // belowThresholdSince = T0

    // Spike again — reset timer
    service.updateVix(21); // state stays REDUCED, timer = null

    // Drop below again — new timer starts at T1 (not T0)
    const cleanup = mockDateNow(5 * 60 * 1000 - 1000); // < 5 min from now
    try {
      service.updateVix(18);
      // Still REDUCED because the timer was reset by the spike
      expect(service.isPositionSizeReduced()).toBe(true);
    } finally {
      cleanup();
    }
  });

  // ── VIX below threshold for exactly 5 min → NORMAL ────────────────────────

  it('restores to NORMAL when VIX has been below threshold for exactly 5 minutes', async () => {
    const { service, mockEventEmitter } = await buildService();

    // First update to drop below threshold (timer starts at real T0)
    service.updateVix(19);
    // VIX was already NORMAL — this is the first below-threshold observation.
    // No reduction has happened yet, so no restoration event should fire.
    // But now spike to REDUCED first, then drop and wait.

    service.updateVix(25); // → REDUCED, belowThresholdSince = null

    // Drop below threshold at T1
    service.updateVix(19); // belowThresholdSince = now

    // Advance clock to T1 + exactly 5 minutes and call again
    const cleanup = mockDateNow(5 * 60 * 1000); // exactly 5 minutes
    try {
      service.updateVix(18);
      expect(service.isPositionSizeReduced()).toBe(false);
      expect(service.getMaxLots()).toBe(10); // NORMAL_MAX_LOTS_PER_SIGNAL
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(VIX_POSITION_SIZE_RESTORED_EVENT);
    } finally {
      cleanup();
    }
  });

  it('emits vix.position.size.restored exactly once on restoration', async () => {
    const { service, mockEventEmitter } = await buildService();

    service.updateVix(25); // REDUCED
    service.updateVix(18); // start timer

    const cleanup = mockDateNow(5 * 60 * 1000);
    try {
      service.updateVix(15); // triggers restoration
      service.updateVix(14); // already NORMAL — no duplicate emit
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(VIX_POSITION_SIZE_RESTORED_EVENT);
    } finally {
      cleanup();
    }
  });

  it('does NOT emit the restored event when VIX drops below threshold from an already-NORMAL state', async () => {
    const { service, mockEventEmitter } = await buildService();
    // Never went REDUCED — drops below threshold right away
    service.updateVix(15);

    const cleanup = mockDateNow(10 * 60 * 1000); // 10 minutes later
    try {
      service.updateVix(10);
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  // ── VIX spikes after restoration → immediately REDUCED ────────────────────

  it('immediately transitions back to REDUCED if VIX spikes above threshold again after restoration', async () => {
    const { service } = await buildService();

    service.updateVix(25); // REDUCED
    service.updateVix(18); // start restoration timer

    // Advance clock: restore to NORMAL
    const cleanup = mockDateNow(5 * 60 * 1000);
    try {
      service.updateVix(15);
      expect(service.isPositionSizeReduced()).toBe(false);

      // VIX spikes again — must go back to REDUCED immediately
      service.updateVix(22);
      expect(service.isPositionSizeReduced()).toBe(true);
      expect(service.getMaxLots()).toBe(2);
    } finally {
      cleanup();
    }
  });

  // ── Custom config values ───────────────────────────────────────────────────

  it('respects custom threshold and limit values from config', async () => {
    const { service } = await buildService({
      configOverrides: {
        UNUSUAL_VOLATILITY_VIX_THRESHOLD: 30.0,
        VOLATILITY_PROTECTION_LIMIT_LOTS: 1,
        NORMAL_MAX_LOTS_PER_SIGNAL: 20,
        VIX_RESTORE_CONTINUOUS_MINUTES: 3,
      },
    });

    // VIX at 29 should NOT trigger reduction (threshold is 30)
    service.updateVix(29);
    expect(service.isPositionSizeReduced()).toBe(false);
    expect(service.getMaxLots()).toBe(20);

    // VIX at 30.01 should trigger reduction
    service.updateVix(30.01);
    expect(service.isPositionSizeReduced()).toBe(true);
    expect(service.getMaxLots()).toBe(1);

    // Drop below — restore after 3 minutes (not 5)
    service.updateVix(29);

    const cleanup = mockDateNow(3 * 60 * 1000);
    try {
      service.updateVix(28);
      expect(service.isPositionSizeReduced()).toBe(false);
      expect(service.getMaxLots()).toBe(20);
    } finally {
      cleanup();
    }
  });

  it('VIX exactly at threshold (not above) does not trigger reduction', async () => {
    const { service } = await buildService();

    service.updateVix(20.0); // equal to threshold — should NOT reduce
    expect(service.isPositionSizeReduced()).toBe(false);
    expect(service.getMaxLots()).toBe(10);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 14: VIX Position Size Round-Trip
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Property 14: VIX Position Size Round-Trip
   *
   * **Validates: Requirements 9.7, 9.10**
   *
   * For any VIX value above the configured unusual-volatility threshold,
   * getMaxLots() MUST return VOLATILITY_PROTECTION_LIMIT_LOTS.
   *
   * For any subsequent sequence where VIX is continuously below the threshold
   * for 5 or more consecutive minutes, getMaxLots() MUST return
   * NORMAL_MAX_LOTS_PER_SIGNAL.
   */
  it('Property 14: VIX above threshold always returns protection limit (Req 9.7)', async () => {
    /**
     * **Validates: Requirements 9.7**
     *
     * Strategy: generate a threshold, a protection limit, a normal limit,
     * and a VIX value strictly above the threshold.  After calling updateVix
     * with that elevated VIX, getMaxLots() MUST return the protection limit.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: Math.fround(10), max: Math.fround(50), noNaN: true }), // threshold
        fc.integer({ min: 1, max: 5 }), // protection limit (lots)
        fc.integer({ min: 6, max: 20 }), // normal limit (lots)
        fc.integer({ min: 1, max: 100 }), // integer delta above threshold
        async (threshold, protectionLimit, normalLimit, delta) => {
          const { service } = await buildService({
            configOverrides: {
              UNUSUAL_VOLATILITY_VIX_THRESHOLD: threshold,
              VOLATILITY_PROTECTION_LIMIT_LOTS: protectionLimit,
              NORMAL_MAX_LOTS_PER_SIGNAL: normalLimit,
              VIX_RESTORE_CONTINUOUS_MINUTES: 5,
            },
          });

          const elevatedVix = threshold + delta;
          service.updateVix(elevatedVix);

          expect(service.getMaxLots()).toBe(protectionLimit);
          expect(service.isPositionSizeReduced()).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('Property 14: after 5+ minutes below threshold, getMaxLots returns normal limit (Req 9.10)', async () => {
    /**
     * **Validates: Requirements 9.10**
     *
     * Strategy: generate a threshold, limits, and a restore duration ≥ 5
     * minutes.  After spiking to REDUCED then advancing the clock by at least
     * the restore interval, getMaxLots() MUST return NORMAL_MAX_LOTS_PER_SIGNAL.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: Math.fround(10), max: Math.fround(50), noNaN: true }), // threshold
        fc.integer({ min: 1, max: 5 }), // protection limit
        fc.integer({ min: 6, max: 20 }), // normal limit
        fc.integer({ min: 5, max: 60 }), // restore minutes (≥5)
        fc.integer({ min: 0, max: 100 }), // integer delta below threshold
        async (threshold, protectionLimit, normalLimit, restoreMinutes, belowDelta) => {
          // Ensure VIX below threshold is strictly at or below
          const belowVix = Math.max(0, threshold - belowDelta);

          const { service } = await buildService({
            configOverrides: {
              UNUSUAL_VOLATILITY_VIX_THRESHOLD: threshold,
              VOLATILITY_PROTECTION_LIMIT_LOTS: protectionLimit,
              NORMAL_MAX_LOTS_PER_SIGNAL: normalLimit,
              VIX_RESTORE_CONTINUOUS_MINUTES: restoreMinutes,
            },
          });

          // Spike above threshold → REDUCED
          service.updateVix(threshold + 1);
          expect(service.isPositionSizeReduced()).toBe(true);

          // Drop below threshold → starts timer
          service.updateVix(belowVix);

          // Advance clock by exactly the restore duration (in ms)
          const cleanup = mockDateNow(restoreMinutes * 60 * 1000);
          try {
            service.updateVix(belowVix);
            expect(service.getMaxLots()).toBe(normalLimit);
            expect(service.isPositionSizeReduced()).toBe(false);
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
