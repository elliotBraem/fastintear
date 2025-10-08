export * from "./crypto.js";
export * from "./transaction.js";
export * from "./misc.js";
export * from "./storage.js";

import { serialize, deserialize } from "borsh";

// exports (or re-exports as well)
const exp = {
  borsh: {
    serialize,
    deserialize
  }
}

export { exp }
