/**
 * Popup unit tests (8 tests).
 *
 * Tests verify the two-step ARM/DISARM UI rules (Requirements 1.1, 11.1):
 *   1.  Activate button is disabled when state is ARMED_PENDING
 *   2.  Activate button is disabled when state is ARMED
 *   3.  Activate button is enabled when state is DISARMED
 *   4.  Confirm button is only visible/enabled when ARMED_PENDING
 *   5.  Disarm button is only shown when ARMED or ARMED_PENDING
 *   6.  renderState sets health badge class correctly for all three statuses
 *   7.  P&L is displayed with correct sign and colour class
 *   8.  Active positions count is shown correctly
 *
 * Requirements: 1.1, 11.1
 */

/**
 * @jest-environment jsdom
 */

import { renderState, handleActivate, handleConfirm, handleDisarm, formatPnl } from './popup';
import type { PopupState } from './popup';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal HTML matching popup.html button/element IDs. */
const POPUP_HTML = `
  <span id="armed-state-label" class="info-value state-disarmed">DISARMED</span>
  <button id="activate-btn" type="button">Activate Live Mode</button>
  <button id="confirm-btn" type="button" class="hidden">Confirm Arm</button>
  <button id="disarm-btn" type="button" class="hidden">Disarm</button>
  <span id="health-badge" class="badge badge-healthy">Healthy</span>
  <span id="session-pnl" class="info-value pnl-neutral">₹0.00</span>
  <span id="active-positions-count" class="info-value">0</span>
`;

function baseState(overrides: Partial<PopupState> = {}): PopupState {
  return {
    armedState: 'DISARMED',
    healthStatus: 'Healthy',
    sessionPnl: 0,
    activePositionsCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let sendMessageMock: jest.Mock;

beforeEach(() => {
  document.body.innerHTML = POPUP_HTML;

  sendMessageMock = jest.fn();
  // Provide a minimal chrome global that the popup functions reference.
  (globalThis as Record<string, unknown>)['chrome'] = {
    runtime: { sendMessage: sendMessageMock },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['chrome'];
});

// ---------------------------------------------------------------------------
// Helper getters
// ---------------------------------------------------------------------------

function activateBtn(): HTMLButtonElement {
  return document.getElementById('activate-btn') as HTMLButtonElement;
}

function confirmBtn(): HTMLButtonElement {
  return document.getElementById('confirm-btn') as HTMLButtonElement;
}

function disarmBtn(): HTMLButtonElement {
  return document.getElementById('disarm-btn') as HTMLButtonElement;
}

function isHidden(el: HTMLElement): boolean {
  return el.classList.contains('hidden');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Popup UI — ARM/DISARM two-step flow', () => {
  /**
   * Test 1: Activate button disabled when ARMED_PENDING.
   * A second click on Activate while pending must be impossible so that
   * a single interaction cannot inadvertently re-trigger arming.
   */
  it('disables Activate button when armedState is ARMED_PENDING', () => {
    renderState(baseState({ armedState: 'ARMED_PENDING' }));
    expect(activateBtn().disabled).toBe(true);
  });

  /**
   * Test 2: Activate button disabled when ARMED.
   * While the engine is live, the Activate button must be inert to prevent
   * accidental re-trigger and enforce deliberate disarm-then-rearm flow.
   */
  it('disables Activate button when armedState is ARMED', () => {
    renderState(baseState({ armedState: 'ARMED' }));
    expect(activateBtn().disabled).toBe(true);
  });

  /**
   * Test 3: Activate button enabled when DISARMED.
   * The initial / idle state must allow the user to start the arming flow.
   */
  it('enables Activate button when armedState is DISARMED', () => {
    renderState(baseState({ armedState: 'DISARMED' }));
    expect(activateBtn().disabled).toBe(false);
  });

  /**
   * Test 4: Confirm button is visible and enabled ONLY in ARMED_PENDING.
   * This is the second step of the two-step arming sequence.
   * It must be hidden in DISARMED and ARMED to avoid accidental confirms.
   */
  it('shows Confirm button only when armedState is ARMED_PENDING', () => {
    // ARMED_PENDING → visible and enabled
    renderState(baseState({ armedState: 'ARMED_PENDING' }));
    expect(isHidden(confirmBtn())).toBe(false);
    expect(confirmBtn().disabled).toBe(false);

    // DISARMED → hidden and disabled
    renderState(baseState({ armedState: 'DISARMED' }));
    expect(isHidden(confirmBtn())).toBe(true);
    expect(confirmBtn().disabled).toBe(true);

    // ARMED → hidden and disabled
    renderState(baseState({ armedState: 'ARMED' }));
    expect(isHidden(confirmBtn())).toBe(true);
    expect(confirmBtn().disabled).toBe(true);
  });

  /**
   * Test 5: Disarm button is visible when ARMED or ARMED_PENDING.
   * The kill-switch must always be reachable once arming has begun.
   */
  it('shows Disarm button when armedState is ARMED or ARMED_PENDING, hides when DISARMED', () => {
    // ARMED → visible
    renderState(baseState({ armedState: 'ARMED' }));
    expect(isHidden(disarmBtn())).toBe(false);

    // ARMED_PENDING → visible
    renderState(baseState({ armedState: 'ARMED_PENDING' }));
    expect(isHidden(disarmBtn())).toBe(false);

    // DISARMED → hidden
    renderState(baseState({ armedState: 'DISARMED' }));
    expect(isHidden(disarmBtn())).toBe(true);
  });

  /**
   * Test 6: renderState sets the correct CSS class and text on the health badge
   * for all three system health statuses.
   */
  it('sets health badge class and text correctly for Healthy, Degraded, and Down', () => {
    const badge = document.getElementById('health-badge') as HTMLElement;

    renderState(baseState({ healthStatus: 'Healthy' }));
    expect(badge.className).toBe('badge badge-healthy');
    expect(badge.textContent).toBe('Healthy');

    renderState(baseState({ healthStatus: 'Degraded' }));
    expect(badge.className).toBe('badge badge-degraded');
    expect(badge.textContent).toBe('Degraded');

    renderState(baseState({ healthStatus: 'Down' }));
    expect(badge.className).toBe('badge badge-down');
    expect(badge.textContent).toBe('Down');
  });

  /**
   * Test 7: P&L is displayed with the correct sign and colour class.
   * - Positive P&L → "+" prefix + pnl-positive class (green)
   * - Negative P&L → no extra prefix (minus sign is part of the number) + pnl-negative class (red)
   * - Zero P&L → "+" not prepended + pnl-neutral class
   */
  it('displays P&L with correct sign prefix and colour class', () => {
    const pnlEl = document.getElementById('session-pnl') as HTMLElement;

    // Positive
    renderState(baseState({ sessionPnl: 1500.75 }));
    expect(pnlEl.textContent).toBe('+₹1500.75');
    expect(pnlEl.classList.contains('pnl-positive')).toBe(true);

    // Negative
    renderState(baseState({ sessionPnl: -750.5 }));
    expect(pnlEl.textContent).toBe('-₹750.50');
    expect(pnlEl.classList.contains('pnl-negative')).toBe(true);

    // Zero
    renderState(baseState({ sessionPnl: 0 }));
    expect(pnlEl.textContent).toBe('₹0.00');
    expect(pnlEl.classList.contains('pnl-neutral')).toBe(true);
  });

  /**
   * Test 8: Active positions count is rendered correctly for varying values.
   */
  it('displays active positions count correctly', () => {
    const posEl = document.getElementById('active-positions-count') as HTMLElement;

    renderState(baseState({ activePositionsCount: 0 }));
    expect(posEl.textContent).toBe('0');

    renderState(baseState({ activePositionsCount: 3 }));
    expect(posEl.textContent).toBe('3');

    renderState(baseState({ activePositionsCount: 12 }));
    expect(posEl.textContent).toBe('12');
  });
});

// ---------------------------------------------------------------------------
// Message dispatch tests (bonus — verifies BSW message types)
// ---------------------------------------------------------------------------

describe('Popup button message dispatch', () => {
  it('handleActivate sends REQUEST_ARM to the BSW', () => {
    handleActivate();
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'REQUEST_ARM' });
  });

  it('handleConfirm sends CONFIRM_ARM to the BSW', () => {
    handleConfirm();
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'CONFIRM_ARM' });
  });

  it('handleDisarm sends DISARM to the BSW', () => {
    handleDisarm();
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'DISARM' });
  });
});

// ---------------------------------------------------------------------------
// formatPnl unit tests
// ---------------------------------------------------------------------------

describe('formatPnl', () => {
  it('prefixes positive values with "+"', () => {
    expect(formatPnl(100)).toBe('+₹100.00');
  });

  it('does not double-prefix negative values', () => {
    expect(formatPnl(-100)).toBe('-₹100.00');
  });

  it('formats zero without a "+" prefix', () => {
    expect(formatPnl(0)).toBe('₹0.00');
  });
});
