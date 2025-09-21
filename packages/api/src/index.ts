export * from "./near";
export { createNearClient } from "./client";
export type { 
  NetworkConfig, 
  TxStatus, 
  TxStatusType,
  WalletState,
  StateManager,
  ExternalStateManager,
  StateChangeCallbacks
} from "./state";
export type { ClientConfig } from "./client";

declare global {
  interface Window {
    // @ts-ignore - this will resolve properly in browser
    near: typeof import("fastintear");

    // $$: typeof NearGlobal.utils.convertUnit;
  }
}
