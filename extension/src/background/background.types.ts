export type ConnectionState = 'connected' | 'disconnected' | 'connecting';
export type ArmedState = 'DISARMED' | 'ARMED_PENDING' | 'ARMED';

export interface ExtensionState {
  armedState: ArmedState;
  sessionToken: string | null;
  connectionState: ConnectionState;
  /** Net P&L for the current session after all trading charges (INR). */
  sessionPnl: number;
  /** Number of currently open positions. */
  activePositionsCount: number;
  /** System health status driven by CloudEngine health metrics. */
  healthStatus: 'Healthy' | 'Degraded' | 'Down';
}

export const INITIAL_STATE: ExtensionState = {
  armedState: 'DISARMED',
  sessionToken: null,
  connectionState: 'disconnected',
  sessionPnl: 0,
  activePositionsCount: 0,
  healthStatus: 'Healthy',
};
