/**
 * Minimal Chrome Extension API type declarations for the MoneyPrinter extension.
 * For full type coverage in production, install @types/chrome.
 */
declare const chrome: {
  storage: {
    session: {
      set(items: Record<string, unknown>, callback?: () => void): void;
      get(
        keys: string | string[],
        callback: (result: Record<string, unknown>) => void,
      ): void;
      remove(keys: string | string[], callback?: () => void): void;
    };
  };
  runtime: {
    lastError: { message: string } | undefined;
    sendMessage(message: unknown): void;
    sendMessage<T = unknown>(
      message: unknown,
      callback?: (response: T) => void,
    ): void;
    onInstalled: { addListener(callback: () => void | Promise<void>): void };
    onStartup: { addListener(callback: () => void | Promise<void>): void };
    /** Fired when a message is sent from an extension process or a content script. */
    onMessage: {
      addListener(
        callback: (
          message: { type: string; payload: unknown },
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => void,
      ): void;
    };
  };
  tabs: {
    query(
      queryInfo: { active?: boolean; currentWindow?: boolean },
      callback: (tabs: Array<{ windowId: number; id?: number }>) => void,
    ): void;
  };
  sidePanel: {
    open(options: { windowId: number; tabId?: number }): Promise<void>;
    setPanelBehavior(behavior: { openPanelOnActionClick?: boolean }): Promise<void>;
  };
};
