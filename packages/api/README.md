# fastintear

> [!WARNING]
> This package is an experimental fork of [@fastnear/js-monorepo](https://github.com/fastnear/js-monorepo) that has some minor package improvements (will make their way upstream) and exclusively uses [INTEAR Wallet](https://github.com/INTEARnear/wallet).

## Installation & Integration

### Install

```bash
bun add fastintear
```

### Recommended: Client-Based Usage (createNearClient)

```typescript
import { createNearClient } from "fastintear";

// Create isolated NEAR client instance
const nearClient = createNearClient({ networkId: "mainnet" });

// External state management (e.g., better-near-auth)
const externalClient = createNearClient({
  networkId: "mainnet",
  stateManager: myExternalStateManager,
  callbacks: {
    onStateChange: (state) => updateUI(state),
    onConnect: (account) => showWelcome(account),
    onDisconnect: () => showSignIn()
  }
});

// Safe mode (memory-only state)
const safeClient = createNearClient({ 
  networkId: "mainnet", 
  isolateState: true 
});

// Sign in with contract for LAK signing
await nearClient.requestSignIn({ contractId: "your-contract.near" });

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

// Listen for state changes
const unsubscribe = nearClient.subscribe((state) => {
  console.log("State changed:", state);
});

// Listen for transaction updates
const unsubscribeTx = nearClient.onTx((txStatus) => {
  console.log(`Transaction ${txStatus.txId}: ${txStatus.status}`);
});

// Sign out
await nearClient.signOut();
```

**Benefits of createNearClient:**

- **Isolated State**: Each client maintains its own authentication and transaction state
- **Multiple Clients**: Support multiple NEAR connections in one application
- **External State Support**: Integration with external state managers like better-near-auth
- **Safe Patterns**: Memory-only mode for enhanced security
- **Reactive Updates**: Event-driven state management with callbacks

### Alternative: Global Import

```typescript
import * as near from "fastintear";
// or for specific imports with full type safety
import { 
  config, 
  requestSignIn, 
  sendTx, 
  actions, 
  createNearClient,
  type Action,
  type TxStatus 
} from "fastintear";

// Configure network
near.config({ networkId: "mainnet" });

// Sign in with contract for LAK signing
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

// Sign out
await near.signOut();
```

### Browser Console & Static HTML (IIFE)

```html
<script src="https://cdn.jsdelivr.net/npm/fastintear/dist/umd/browser.global.js"></script>
<script>
  // Global `near` object is now available
  near.config({ networkId: "mainnet" });
  
  // Also available: window.$$ = near.utils.convertUnit
  const amount = $$`1 NEAR`; // "1000000000000000000000000"
</script>
```

**Safe Mode for Static HTML:**

```html
<!-- Safe mode (memory-only state) -->
<script src="https://cdn.jsdelivr.net/npm/fastintear/dist/umd/browser.global.js?memory"></script>

<!-- Or use ?safe parameter -->
<script src="https://cdn.jsdelivr.net/npm/fastintear/dist/umd/browser.global.js?safe"></script>
```

## State Management Options

### Default (localStorage)

- Persists authentication state across browser sessions
- Suitable for most web applications
- Automatic session restoration

### Safe Mode (memory-only)

- No persistent state storage
- Enhanced security for sensitive applications
- Perfect for browser console experimentation
- Use `isolateState: true` in createNearClient or `?memory`/`?safe` URL parameters for IIFE

### External State Management

- Integration with external authentication systems
- Support for better-near-auth and similar libraries
- Session-aware state synchronization

```typescript
interface ExternalStateManager {
  getState(): Promise<WalletState | null>;
  setState(state: WalletState): Promise<void>;
  clearState(): Promise<void>;
}

const client = createNearClient({
  networkId: "mainnet",
  stateManager: myExternalStateManager
});
```

## Technical Features

### Modern State Management

- **Session-aware**: External state manager support for better-near-auth integration
- **Reactive**: Event-driven state updates with comprehensive callbacks
- **Isolated**: Multiple client instances with independent state
- **Safe**: Memory-only mode for enhanced security

### Browser-First Design

- **Node.js Decoupled**: No Node.js dependencies
- **Modern APIs**: Uses browser-native APIs (Uint8Array, TextEncoder, etc.)
- **Static HTML Support**: Enables web3 projects with pure static HTML files
- **Console Ready**: Perfect for browser console experimentation

### Intelligent Transaction Signing

- **LAK Signing**: Local signing for simple function calls with zero deposit
- **Wallet Signing**: INTEAR Wallet popup for complex transactions
- **Automatic Decision**: Smart routing based on transaction complexity

### Real-time Features

- **WebSocket Logout Detection**: Real-time logout notifications
- **Session Verification**: Automatic session validation
- **Cross-tab Synchronization**: State updates across browser tabs

## Documentation

For comprehensive implementation details, API reference, and advanced usage patterns, see the [LLM.txt](./LLM.txt) file which contains detailed documentation designed for both developers and AI systems.

## Status

This package provides a complete, production-ready SDK for NEAR Protocol with browser-first design and INTEAR Wallet integration. The core functionality is stable and feature-complete.

Make sure to visit the [project-level README](https://github.com/fastnear/js-monorepo#global-near-js) for more information about the monorepo structure.
