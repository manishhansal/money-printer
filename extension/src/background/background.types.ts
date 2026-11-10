export type ConnectionState = 'connected' | 'disconnected' | 'connecting';
export type ArmedState = 'DISARMED' | 'ARMED_PENDING' | 'ARMED';

export interface ExtensionState {
  armedState: ArmedState;
  sessionToken: string | null;
  connectionState: ConnectionState;
}

export const INITIAL_STATE: ExtensionState = {
  armedState: 'DISARMED',
  sessionToken: null,
  connectionState: 'disconnected',
};
