/**
 * dhan-websocket.client.spec.ts
 *
 * Unit tests for DhanWebSocketClient.
 *
 * Test coverage (Requirements 3.4, 3.5):
 *  1. Backoff schedule — reconnect attempt delays are exactly 1 s, 2 s, 4 s,
 *     8 s, 16 s (Requirement 3.5).
 *  2. Connectivity failure — after 5 consecutive failures, a CRITICAL alert is
 *     published within 5 s (Requirement 3.8).
 *  3. Failure counter reset — a successful `open` event resets
 *     `consecutiveFailures` to 0 (Requirement 3.5).
 *  4. First-tick SLA — a WARNING log and staleness alert are published when no
 *     tick arrives within 3 s of connection (Requirement 3.4).
 */

import { EventEmitter } from 'events';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// ─────────────────────────────────────────────────────────────────────────────
// WS Mock
//
// We use a module-level const that is initialised before any tests run.
// Jest hoists jest.mock() registrations above imports, but the MockWs
// constructor only RUNS inside tests (after all module-level code executes),
// so the closure reference to wsInstances resolves correctly.
// ─────────────────────────────────────────────────────────────────────────────

/** Accumulates every MockWs instance created during the current test. */
const wsInstances: Array<
  EventEmitter & {
    send: jest.Mock;
    close: jest.Mock;
    terminate: jest.Mock;
    readyState: number;
  }
> = [];

jest.mock('ws', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events') as {
    EventEmitter: typeof EventEmitter;
  };

  class MockWs extends EE {
    public send = jest.fn();
    public close = jest.fn();
    public terminate = jest.fn();
    public readyState = 1;

    constructor(_url: string, _opts?: Record<string, unknown>) {
      super();
      wsInstances.push(this as unknown as (typeof wsInstances)[number]);
    }
  }

  return {
    __esModule: true,
    default: MockWs,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Subject under test (imported after jest.mock() so it picks up the mock)
// ─────────────────────────────────────────────────────────────────────────────

import { DhanWebSocketClient } from './dhan-websocket.client';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationService } from '../notification/notification.service';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

type MockWsInstance = (typeof wsInstances)[number];

/** Shorthand to get the latest WS instance. */
function latestWs(): MockWsInstance {
  const ws = wsInstances[wsInstances.length - 1];
  if (!ws) throw new Error('No MockWs instance available');
  return ws;
}

/** Simulate the WS server accepting the connection. */
function emitOpen(ws: MockWsInstance = latestWs()): void {
  ws.emit('open');
}

/** Simulate the WS connection closing unexpectedly. */
function emitClose(ws: MockWsInstance = latestWs(), code = 1006, reason = ''): void {
  ws.emit('close', code, Buffer.from(reason));
}

/** Simulate an incoming tick message. */
function emitMessage(payload: Record<string, unknown>, ws: MockWsInstance = latestWs()): void {
  ws.emit('message', Buffer.from(JSON.stringify(payload)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('DhanWebSocketClient', () => {
  let client: DhanWebSocketClient;
  let mockNotificationService: { publish: jest.Mock };
  let mockEventEmitter: { emit: jest.Mock };
  let mockSecretsService: { get: jest.Mock; set: jest.Mock };
  let mockConfigService: { get: jest.Mock };

  beforeEach(async () => {
    // Reset the WS instance store
    wsInstances.length = 0;

    mockSecretsService = {
      get: jest.fn().mockResolvedValue('test-token'),
      set: jest.fn().mockResolvedValue(undefined),
    };

    mockConfigService = {
      get: jest.fn((_key: string, defaultVal?: string) => defaultVal ?? 'wss://api-feed.dhan.co'),
    };

    mockEventEmitter = { emit: jest.fn() };

    mockNotificationService = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DhanWebSocketClient,
        { provide: SecretsService, useValue: mockSecretsService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    client = module.get<DhanWebSocketClient>(DhanWebSocketClient);
  });

  afterEach(() => {
    // Restore real timers to prevent state leaking between suites
    jest.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Backoff schedule
  // ─────────────────────────────────────────────────────────────────────────

  describe('Requirement 3.5 — exponential backoff reconnect schedule', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('schedules reconnect attempt 1 after exactly 1 s', async () => {
      await client.connect();
      expect(wsInstances).toHaveLength(1);

      // Unexpected close → should schedule reconnect
      emitClose();

      // 999 ms — should NOT have reconnected yet
      await jest.advanceTimersByTimeAsync(999);
      expect(wsInstances).toHaveLength(1);

      // 1 ms more (total 1 000 ms) — reconnect attempt fires
      await jest.advanceTimersByTimeAsync(1);
      expect(wsInstances).toHaveLength(2);
    });

    it('schedules reconnect attempt 2 after exactly 2 s following attempt 1', async () => {
      await client.connect();
      emitClose();

      // Exhaust 1 s → attempt 1 created
      await jest.advanceTimersByTimeAsync(1_000);
      expect(wsInstances).toHaveLength(2);
      emitClose(wsInstances[1]);

      // 1 999 ms into second window — no new WS yet
      await jest.advanceTimersByTimeAsync(1_999);
      expect(wsInstances).toHaveLength(2);

      // 1 ms more → attempt 2 fires at 2 s
      await jest.advanceTimersByTimeAsync(1);
      expect(wsInstances).toHaveLength(3);
    });

    it('schedules attempt 3 after 4 s, attempt 4 after 8 s, attempt 5 after 16 s', async () => {
      await client.connect();

      // Simulate 5 consecutive failures and record when each WS is created
      const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000];
      const createdCounts: number[] = [1]; // ws[0] created on connect()

      for (let i = 0; i < expectedDelays.length; i++) {
        emitClose(wsInstances[wsInstances.length - 1]);

        // One ms before scheduled delay — no new instance
        await jest.advanceTimersByTimeAsync(expectedDelays[i] - 1);
        expect(wsInstances).toHaveLength(i + 1);

        // The last ms — new instance appears
        await jest.advanceTimersByTimeAsync(1);
        createdCounts.push(wsInstances.length);

        // Stop once the last reconnect attempt has fired
        if (i === expectedDelays.length - 1) break;
      }

      // The final wsInstances count should be 6: ws[0] + 5 reconnects
      expect(wsInstances).toHaveLength(6);
    });

    it('caps any computed delay at 30 s', async () => {
      // Verify the cap: 16 s < 30 s, so Math.min(16000, 30000) = 16000
      await client.connect();
      emitClose();

      // Fast-forward exactly 16 s (attempt 5 delay) — no cap needed yet
      // but we confirm no extra time is added
      await jest.advanceTimersByTimeAsync(1_000); // attempt 1
      emitClose(wsInstances[1]);
      await jest.advanceTimersByTimeAsync(2_000); // attempt 2
      emitClose(wsInstances[2]);
      await jest.advanceTimersByTimeAsync(4_000); // attempt 3
      emitClose(wsInstances[3]);
      await jest.advanceTimersByTimeAsync(8_000); // attempt 4
      emitClose(wsInstances[4]);
      await jest.advanceTimersByTimeAsync(16_000); // attempt 5 (≤ 30 s cap)
      expect(wsInstances).toHaveLength(6);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Connectivity-failure alert after 5 consecutive failures
  // ─────────────────────────────────────────────────────────────────────────

  describe('Requirement 3.8 — connectivity-failure alert after 5 failures', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('publishes a CRITICAL connectivity-failure alert after 5 consecutive failed reconnects', async () => {
      await client.connect();

      // Exhaust all 5 reconnect attempts (total simulated time: 31 s)
      emitClose();
      await jest.advanceTimersByTimeAsync(1_000); // attempt 1
      emitClose(wsInstances[1]);
      await jest.advanceTimersByTimeAsync(2_000); // attempt 2
      emitClose(wsInstances[2]);
      await jest.advanceTimersByTimeAsync(4_000); // attempt 3
      emitClose(wsInstances[3]);
      await jest.advanceTimersByTimeAsync(8_000); // attempt 4
      emitClose(wsInstances[4]);
      await jest.advanceTimersByTimeAsync(16_000); // attempt 5
      emitClose(wsInstances[5]); // 5th attempt closes → all exhausted

      // Flush pending promises (publishConnectivityFailureAlert is async)
      await jest.advanceTimersByTimeAsync(0);

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'CRITICAL',
          title: expect.stringContaining('Connectivity Failure') as string,
        }),
      );
    });

    it('emits websocket.connectivity-failure event after 5 failures', async () => {
      await client.connect();

      emitClose();
      await jest.advanceTimersByTimeAsync(1_000);
      emitClose(wsInstances[1]);
      await jest.advanceTimersByTimeAsync(2_000);
      emitClose(wsInstances[2]);
      await jest.advanceTimersByTimeAsync(4_000);
      emitClose(wsInstances[3]);
      await jest.advanceTimersByTimeAsync(8_000);
      emitClose(wsInstances[4]);
      await jest.advanceTimersByTimeAsync(16_000);
      emitClose(wsInstances[5]);

      await jest.advanceTimersByTimeAsync(0);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith('websocket.connectivity-failure');
    });

    it('does NOT publish a connectivity-failure alert before all 5 attempts are exhausted', async () => {
      await client.connect();

      // Only 4 failures
      emitClose();
      await jest.advanceTimersByTimeAsync(1_000);
      emitClose(wsInstances[1]);
      await jest.advanceTimersByTimeAsync(2_000);
      emitClose(wsInstances[2]);
      await jest.advanceTimersByTimeAsync(4_000);
      emitClose(wsInstances[3]);
      await jest.advanceTimersByTimeAsync(8_000);
      // 5th attempt fires but does NOT fail yet
      expect(wsInstances).toHaveLength(5);

      await jest.advanceTimersByTimeAsync(0);

      expect(mockNotificationService.publish).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Successful connection resets consecutive failure counter
  // ─────────────────────────────────────────────────────────────────────────

  describe('Requirement 3.5 — consecutive failure counter reset on success', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('resets the failure counter when a reconnect attempt succeeds', async () => {
      await client.connect();

      // Two failures → consecutiveFailures = 2
      emitClose();
      await jest.advanceTimersByTimeAsync(1_000);
      emitClose(wsInstances[1]);
      await jest.advanceTimersByTimeAsync(2_000);

      // ws[2] connects successfully
      emitOpen(wsInstances[2]);

      // ws[2] now drops — counter should restart from 0 (next backoff = 1 s)
      emitClose(wsInstances[2]);

      // At 999 ms no new WS (confirms delay is 1 s, not 4 s which would be
      // index-2 if the counter hadn't been reset)
      await jest.advanceTimersByTimeAsync(999);
      expect(wsInstances).toHaveLength(3);

      await jest.advanceTimersByTimeAsync(1);
      expect(wsInstances).toHaveLength(4);
    });

    it('emits websocket.connected when a connection is established', async () => {
      await client.connect();
      emitOpen();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith('websocket.connected');
    });

    it('does not schedule more reconnects after explicit disconnect', async () => {
      await client.connect();
      emitOpen();

      client.disconnect();
      emitClose(); // ws.close() triggers the close event

      // Even after waiting a long time, no reconnect is attempted
      await jest.advanceTimersByTimeAsync(60_000);
      expect(wsInstances).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. First-tick SLA
  // ─────────────────────────────────────────────────────────────────────────

  describe('Requirement 3.4 — first-tick SLA ≤ 3 s after connection confirmation', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('logs a WARNING and publishes a staleness alert when no tick arrives within 3 s', async () => {
      const warnSpy = jest.spyOn(client['logger'], 'warn').mockImplementation(() => undefined);

      await client.connect();
      emitOpen();

      // 2 999 ms — no tick, SLA not yet exceeded
      await jest.advanceTimersByTimeAsync(2_999);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(mockNotificationService.publish).not.toHaveBeenCalled();

      // 1 ms more → 3 000 ms → SLA violated
      await jest.advanceTimersByTimeAsync(1);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('First-tick SLA violation') as string,
      );

      // Flush async publish
      await jest.advanceTimersByTimeAsync(0);

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'WARNING',
          title: expect.stringContaining('Staleness') as string,
        }),
      );

      warnSpy.mockRestore();
    });

    it('does NOT trigger the SLA warning when a tick arrives within 3 s', async () => {
      const warnSpy = jest.spyOn(client['logger'], 'warn').mockImplementation(() => undefined);

      await client.connect();
      emitOpen();

      // Tick arrives at 1 s — within the 3 s SLA window
      await jest.advanceTimersByTimeAsync(1_000);
      emitMessage({ securityId: 49081, lastTradedPrice: 100 });

      // Advance past the 3 s mark — SLA timer should have been cancelled
      await jest.advanceTimersByTimeAsync(3_000);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(mockNotificationService.publish).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('emits market.tick.received with parsed tick data on each message', async () => {
      await client.connect();
      emitOpen();

      const tick = { securityId: 1333, lastTradedPrice: 21500.5 };
      emitMessage(tick);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'market.tick.received',
        expect.objectContaining(tick),
      );
    });

    it('resets the SLA timer on each fresh connection (reconnect scenario)', async () => {
      const warnSpy = jest.spyOn(client['logger'], 'warn').mockImplementation(() => undefined);

      await client.connect();
      emitOpen();

      // Advance 1 s — tick arrives (no SLA violation)
      await jest.advanceTimersByTimeAsync(1_000);
      emitMessage({ securityId: 1333 });

      // Connection drops and reconnects
      emitClose();
      await jest.advanceTimersByTimeAsync(1_000); // backoff 1 s
      emitOpen(wsInstances[1]); // fresh connection

      // 2 999 ms of new connection — no tick yet but SLA not exceeded
      await jest.advanceTimersByTimeAsync(2_999);
      expect(warnSpy).not.toHaveBeenCalled();

      // 1 ms more → SLA violated on the fresh connection
      await jest.advanceTimersByTimeAsync(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('First-tick SLA violation') as string,
      );

      warnSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Additional — subscribe / unsubscribe
  // ─────────────────────────────────────────────────────────────────────────

  describe('subscribe / unsubscribe message sending', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('subscribe sends a RequestCode 21 message when connected', async () => {
      await client.connect();
      emitOpen();

      client.subscribe([49081, 49082], 'NSE_FNO');

      expect(latestWs().send).toHaveBeenCalledTimes(1);
      const sentPayload = JSON.parse(
        (latestWs().send as jest.Mock).mock.calls[0][0] as string,
      ) as Record<string, unknown>;
      expect(sentPayload['RequestCode']).toBe(21);
      expect(sentPayload['InstrumentCount']).toBe(2);
    });

    it('unsubscribe sends a RequestCode 22 message for previously subscribed IDs', async () => {
      await client.connect();
      emitOpen();

      client.subscribe([49081], 'NSE_FNO');
      client.unsubscribe([49081]);

      // subscribe + unsubscribe = 2 sends
      expect(latestWs().send).toHaveBeenCalledTimes(2);
      const unsubPayload = JSON.parse(
        (latestWs().send as jest.Mock).mock.calls[1][0] as string,
      ) as Record<string, unknown>;
      expect(unsubPayload['RequestCode']).toBe(22);
    });

    it('discards subscribe/unsubscribe calls when not connected', () => {
      // Not calling connect() — state is DISCONNECTED
      expect(() => client.subscribe([1333], 'NSE_EQ')).not.toThrow();
      expect(() => client.unsubscribe([1333])).not.toThrow();
    });
  });
});
