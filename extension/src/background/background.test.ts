/**
 * Unit tests for the MV3 Background Service Worker (BSW).
 *
 * Coverage:
 *  1. recoverState() reverts ARMED → DISARMED on startup        (Requirement 1.5)
 *  2. recoverState() reverts ARMED_PENDING → DISARMED            (Requirement 1.5)
 *  3. recoverState() preserves DISARMED state                    (Requirement 1.3)
 *  4. Recovery timeout fires DISARMED state + user notification  (Requirement 1.4)
 *  5. State is persisted to chrome.storage.session on change     (Requirement 1.3)
 *
 * Requirements: 1.1, 1.3, 1.4, 1.5
 */

// ─── Import modules under test ─────────────────────────────────────────────────
// background.ts registers chrome event listeners at module-load time.
// The jest.setup.ts (setupFilesAfterEnv) has already installed the chrome/WebSocket
// globals before any import runs, so the registrations are safe.

import * as stateManager from './state.manager';
import {
  recoverState,
  updateState,
  getCurrentState,
  _resetStateForTesting,
} from './background';
import { INITIAL_STATE, ExtensionState } from './background.types';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Convenience accessor for the chrome.runtime.sendMessage mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendMessageMock = (): jest.Mock => (global as any).chrome.runtime.sendMessage as jest.Mock;

// ─── Test suite ────────────────────────────────────────────────────────────────

describe('Background Service Worker', () => {
  beforeEach(() => {
    // Reset in-memory state so tests are independent
    _resetStateForTesting();
    // Restore any spies created in previous tests
    jest.restoreAllMocks();
    // Clear call history on the chrome.runtime.sendMessage mock
    sendMessageMock().mockClear();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. recoverState() — armed state reversion
  // ══════════════════════════════════════════════════════════════════════════════

  describe('recoverState() — armed state reversion', () => {
    it('reverts ARMED state to DISARMED on startup (Requirement 1.5)', async () => {
      const storedState: ExtensionState = {
        armedState: 'ARMED',
        sessionToken: 'live-session-token',
        connectionState: 'connected', sessionPnl: 0, activePositionsCount: 0, healthStatus: 'Healthy',
      };

      jest.spyOn(stateManager, 'loadState').mockResolvedValue(storedState);
      jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

      await recoverState(1000);

      const state = getCurrentState();
      expect(state.armedState).toBe('DISARMED');
      // sessionToken preserved for re-authentication
      expect(state.sessionToken).toBe('live-session-token');
    });

    it('reverts ARMED_PENDING state to DISARMED on startup (Requirement 1.5)', async () => {
      const storedState: ExtensionState = {
        armedState: 'ARMED_PENDING',
        sessionToken: 'pending-session-token',
        connectionState: 'connecting', sessionPnl: 0, activePositionsCount: 0, healthStatus: 'Healthy',
      };

      jest.spyOn(stateManager, 'loadState').mockResolvedValue(storedState);
      jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

      await recoverState(1000);

      const state = getCurrentState();
      expect(state.armedState).toBe('DISARMED');
      expect(state.sessionToken).toBe('pending-session-token');
    });

    it('preserves DISARMED state across startup (Requirement 1.3)', async () => {
      const storedState: ExtensionState = {
        armedState: 'DISARMED',
        sessionToken: null,
        connectionState: 'disconnected', sessionPnl: 0, activePositionsCount: 0, healthStatus: 'Healthy',
      };

      jest.spyOn(stateManager, 'loadState').mockResolvedValue(storedState);
      jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

      await recoverState(1000);

      const state = getCurrentState();
      expect(state.armedState).toBe('DISARMED');
      expect(state.sessionToken).toBeNull();
    });

    it('enters INITIAL_STATE when no stored state exists (first run)', async () => {
      jest.spyOn(stateManager, 'loadState').mockResolvedValue(null);
      jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

      await recoverState(1000);

      expect(getCurrentState()).toEqual(INITIAL_STATE);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. recoverState() — recovery timeout path (Requirement 1.4)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('recoverState() — recovery timeout', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('fires DISARMED state and sends user notification when recovery times out', async () => {
      // loadState never resolves — simulates a storage hang
      jest.spyOn(stateManager, 'loadState').mockReturnValue(
        new Promise<ExtensionState | null>(() => {/* never resolves */}),
      );
      jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

      const recoverPromise = recoverState(5000);

      // Fast-forward past the 5-second deadline
      jest.advanceTimersByTime(5001);

      await recoverPromise;

      // State must be DISARMED
      const state = getCurrentState();
      expect(state.armedState).toBe('DISARMED');
      expect(state.connectionState).toBe('disconnected');
      expect(state.sessionToken).toBeNull();

      // User must be notified (Requirement 1.4)
      expect(sendMessageMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RECOVERY_NOTIFICATION',
          message: 'Manual re-authorization required',
        }),
      );
    });

    it('fires DISARMED state and notification when storage throws an error', async () => {
      jest.spyOn(stateManager, 'loadState').mockRejectedValue(
        new Error('chrome.storage read failure'),
      );
      jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

      // No timer advancement needed — the rejection resolves immediately
      await recoverState(5000);

      expect(getCurrentState()).toEqual(INITIAL_STATE);
      expect(sendMessageMock()).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Manual re-authorization required' }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. State persistence to chrome.storage.session (Requirement 1.3)
  // ══════════════════════════════════════════════════════════════════════════════

  describe('State persistence to chrome.storage.session', () => {
    it('persists state to chrome.storage.session via saveState after recoverState()', async () => {
      const saveStateSpy = jest
        .spyOn(stateManager, 'saveState')
        .mockResolvedValue(undefined);
      jest.spyOn(stateManager, 'loadState').mockResolvedValue(null);

      await recoverState(1000);

      expect(saveStateSpy).toHaveBeenCalledTimes(1);
      expect(saveStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ armedState: 'DISARMED' }),
      );
    });

    it('persists updated state to chrome.storage.session via updateState()', async () => {
      const saveStateSpy = jest
        .spyOn(stateManager, 'saveState')
        .mockResolvedValue(undefined);

      await updateState({ connectionState: 'connected' });

      expect(saveStateSpy).toHaveBeenCalledTimes(1);
      expect(saveStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ connectionState: 'connected' }),
      );
    });

    it('persists each partial update merged with existing state', async () => {
      const saveStateSpy = jest
        .spyOn(stateManager, 'saveState')
        .mockResolvedValue(undefined);

      // First update: set connectionState
      await updateState({ connectionState: 'connecting' });
      // Second update: set a session token
      await updateState({ sessionToken: 'tok-abc' });

      // Both calls happened
      expect(saveStateSpy).toHaveBeenCalledTimes(2);

      // The second call carries the merged state
      const secondCallArg = saveStateSpy.mock.calls[1][0];
      expect(secondCallArg.connectionState).toBe('connecting');
      expect(secondCallArg.sessionToken).toBe('tok-abc');
      expect(secondCallArg.armedState).toBe('DISARMED');
    });

    it('reverted armed state is persisted on timeout recovery', async () => {
      jest.useFakeTimers();

      const saveStateSpy = jest
        .spyOn(stateManager, 'saveState')
        .mockResolvedValue(undefined);
      jest.spyOn(stateManager, 'loadState').mockReturnValue(
        new Promise<ExtensionState | null>(() => {/* never resolves */}),
      );

      const recoverPromise = recoverState(5000);
      jest.advanceTimersByTime(5001);
      await recoverPromise;

      expect(saveStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ armedState: 'DISARMED' }),
      );

      jest.useRealTimers();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. Never auto-re-arm invariant
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Never auto-re-arm invariant (Requirement 1.5)', () => {
    it.each<ExtensionState['armedState']>(['ARMED', 'ARMED_PENDING', 'DISARMED'])(
      'always results in DISARMED regardless of stored armedState=%s',
      async (storedArmedState) => {
        jest.spyOn(stateManager, 'loadState').mockResolvedValue({
          armedState: storedArmedState,
          sessionToken: null,
          connectionState: 'connected', sessionPnl: 0, activePositionsCount: 0, healthStatus: 'Healthy',
        });
        jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

        _resetStateForTesting();
        await recoverState(1000);

        expect(getCurrentState().armedState).toBe('DISARMED');
      },
    );

    it('connectionState is always reset to disconnected on recovery', async () => {
      jest.spyOn(stateManager, 'loadState').mockResolvedValue({
        armedState: 'ARMED',
        sessionToken: 'tok',
        connectionState: 'connected', sessionPnl: 0, activePositionsCount: 0, healthStatus: 'Healthy',
      });
      jest.spyOn(stateManager, 'saveState').mockResolvedValue(undefined);

      await recoverState(1000);

      expect(getCurrentState().connectionState).toBe('disconnected');
    });
  });
});
