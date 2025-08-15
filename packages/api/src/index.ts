// See tsup.config.ts for additional banner/footer js
export * from "./near";

declare global {
  interface Window {
    near: typeof import("./near");

    // $$: typeof NearGlobal.utils.convertUnit;
  }
}
