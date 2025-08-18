// See tsup.config.ts for additional banner/footer js
export * from "./near";
export type { NetworkConfig, TxStatus, TxStatusType } from "./state";

declare global {
  interface Window {
    // @ts-ignore - this will resolve properly in browser
    near: typeof import("fastintear");

    // $$: typeof NearGlobal.utils.convertUnit;
  }
}
