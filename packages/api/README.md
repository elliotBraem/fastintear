# fastintear

> [!WARNING]
> This package is an experimental fork of [@fastnear/js-monorepo](https://github.com/fastnear/js-monorepo) that has some minor package improvements (will make their way upstream) and exclusively uses [INTEAR Wallet](https://github.com/INTEARnear/wallet).

## Installation & Integration

### Install

```bash
bun add fastintear
```

### Preferred: Client-Based Usage (createNearClient)

```typescript
import { createNearClient } from "fastintear";

// Create isolated NEAR client instance
const nearClient = createNearClient({ networkId: "mainnet" });

// Sign in with contract for LAK signing (Promise-based)
await nearClient.requestSignIn({ contractId: "your-contract.near" });

// Sign in with callbacks for real-time updates
nearClient.requestSignIn(
  { contractId: "your-contract.near" },
  {
    onSuccess: (result) => {
      console.log('Signed in successfully:', result.accountId);
    },
    onError: (error) => {
      console.error('Sign-in failed:', error.message);
    }
  }
);

// Send transaction (uses LAK if conditions met, wallet popup otherwise)
await nearClient.sendTx({
  receiverId: "your-contract.near",
  actions: [
    nearClient.actions.functionCall({
      methodName: "your_method",
      args: { key: "value" },
      gas: "30000000000000",
      deposit: "0"
    })
  ]
});

// Listen for transaction updates
nearClient.event.onTx((txStatus) => {
  console.log(`Transaction ${txStatus.txId}: ${txStatus.status}`);
});

// Sign out
await nearClient.signOut();
```

**Benefits of createNearClient:**
- **Isolated State**: Each client maintains its own authentication and transaction state
- **Multiple Clients**: Support multiple NEAR connections in one application
- **Cleaner Architecture**: Better separation of concerns and testability
- **Same API**: Compatible with existing `near.*` methods

### Alternative: Global Import

```typescript
import * as near from "fastintear";
// or for specific imports with full type safety
import { 
  config, 
  requestSignIn, 
  sendTx, 
  actions, 
  event,
  type Action,
  type TxStatus 
} from "fastintear";

// Configure network
near.config({ networkId: "mainnet" });

// Sign in with contract for LAK signing (Promise-based)
await near.requestSignIn({ contractId: "your-contract.near" });

// Send transaction (uses LAK if conditions met, wallet popup otherwise)
await near.sendTx({
  receiverId: "your-contract.near",
  actions: [
    near.actions.functionCall({
      methodName: "your_method",
      args: { key: "value" },
      gas: "30000000000000",
      deposit: "0"
    })
  ]
});

// Listen for transaction updates
near.event.onTx((txStatus: TxStatus) => {
  console.log(`Transaction ${txStatus.txId}: ${txStatus.status}`);
});

// Sign out
await near.signOut();
```

### Alternative: Script Tag (IIFE) - Static HTML

```html
<script src="https://cdn.jsdelivr.net/npm/fastintear/dist/umd/browser.global.js"></script>
<script>
  // Global `near` object is now available
  near.config({ networkId: "mainnet" });
  
  // Also available: window.$$ = near.utils.convertUnit
  const amount = $$`1 NEAR`; // "1000000000000000000000000"
</script>
```

## General

This is a workspace package from the [@fastnear/js-monorepo](https://github.com/fastnear/js-monorepo) that has the primary responsibility. It's what creates the global `near` object.

## Technical

### Node.js decoupling

This library surgically removed ties to Node.js, replacing them with CommonJS and/or modern APIs available in browsers.

For instance `Buffer.from()` is an example of a Node.js feature that is commonly used in libraries doing binary encoding, cryptographic operations, and so on. There exists alternative with `Uint8Array` and `TextEncoder` to fill in pieces. This subject could be quite lengthy, and I mention a couple examples just to set the scene.

So it *is* possible to have a web3 library that's decoupled from Node.js

### What this means

Some emergent behavior comes as a result of this.

- ability to run code in browser's dev console
- ability to create web3 projects entirely with static html

### `near` global

In `tsup.config.ts`, you find TypeScript compilations targets. We feel preferential towards the IIFE version. ([MDN docs on IIFE](https://developer.mozilla.org/en-US/docs/Glossary/IIFE)) That file utilizes `esbuild`'s `banner` and `footer` to inject JavaScript that utilizes `Object.defineProperty` in a way to make it "not [configurable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/defineProperty#configurable)."

If you look in the `dist` directory under `umd` (Universal Module Definition, but it seems IIFE fits better as a term) there is one file. At the bottom of the file you'll see how the global `near` object can undergo some modifications, potentially hardening it further as this library develops.

## Documentation

For comprehensive implementation details, API reference, and advanced usage patterns, see the [LLM.txt](./LLM.txt) file which contains detailed documentation designed for both developers and AI systems.

## Status

This package provides a complete, production-ready SDK for NEAR Protocol with browser-first design and INTEAR Wallet integration. The core functionality is stable and feature-complete.

Make sure to visit the [project-level README](https://github.com/fastnear/js-monorepo#global-near-js) for more information about the monorepo structure.
