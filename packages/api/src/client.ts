import * as near from "./near.js";
import { 
  type NetworkConfig,
  type AppState,
  type TxHistory,
  type TxStatus,
  type EventsType,
  NETWORKS,
  DEFAULT_NETWORK_ID,
  WIDGET_URL,
  _state,
  _config
} from "./state.js";
import { WalletAdapter } from "./intear.js";
import { publicKeyFromPrivate } from "@fastnear/utils";

/**
 * Creates a NEAR client instance with isolated state
 * This is a simple wrapper that provides client-based usage while keeping existing functionality intact
 */
export function createNearClient(initialConfig?: Partial<NetworkConfig>) {
  // Create isolated state for this client instance
  const clientState: AppState = {
    accountId: null,
    privateKey: null,
    lastWalletId: null,
    publicKey: null,
    accessKeyContractId: null,
  };

  let clientConfig: NetworkConfig = {
    ...NETWORKS[initialConfig?.networkId || DEFAULT_NETWORK_ID],
    ...initialConfig,
  };

  let clientTxHistory: TxHistory = {};

  // Create isolated adapter for this client
  const clientAdapter = new WalletAdapter({
    onStateUpdate: (state: any) => {
      const { accountId, lastWalletId, privateKey } = state;
      const newAccountId = accountId || null;
      if (newAccountId !== clientState.accountId) {
        clientUpdate({
          accountId: newAccountId,
          lastWalletId: lastWalletId || undefined,
          ...(privateKey ? { privateKey } : {}),
        });
      }
    },
    walletUrl: WIDGET_URL,
  });

  // Create isolated events system for this client
  const clientEvents: EventsType = {
    _eventListeners: {
      account: new Set(),
      tx: new Set(),
    },

    notifyAccountListeners: (accountId: string) => {
      clientEvents._eventListeners.account.forEach((callback: any) => {
        try {
          callback(accountId);
        } catch (e) {
          console.error(e);
        }
      });
    },

    notifyTxListeners: (tx: TxStatus) => {
      clientEvents._eventListeners.tx.forEach((callback: any) => {
        try {
          callback(tx);
        } catch (e) {
          console.error(e);
        }
      });
    },

    onAccount: (callback: (accountId: string) => void) => {
      clientEvents._eventListeners.account.add(callback);
      return callback;
    },

    onTx: (callback: (tx: TxStatus) => void): (tx: TxStatus) => void => {
      clientEvents._eventListeners.tx.add(callback);
      return callback;
    },

    offAccount: (callback: (accountId: string) => void): void => {
      clientEvents._eventListeners.account.delete(callback);
    },

    offTx: (callback: (tx: TxStatus) => void): void => {
      clientEvents._eventListeners.tx.delete(callback);
    }
  };

  // Client-specific update function
  const clientUpdate = (newState: Partial<AppState>) => {
    const oldState = { ...clientState };
    Object.assign(clientState, newState);

    if (
      newState.hasOwnProperty("privateKey") &&
      newState.privateKey !== oldState.privateKey
    ) {
      clientState.publicKey = newState.privateKey
        ? publicKeyFromPrivate(newState.privateKey as string)
        : null;
    }

    if (newState.hasOwnProperty("accountId") && newState.accountId !== oldState.accountId) {
      clientEvents.notifyAccountListeners(newState.accountId as string);
    }

    if (
      (newState.hasOwnProperty("lastWalletId") &&
        newState.lastWalletId !== oldState.lastWalletId) ||
      (newState.hasOwnProperty("accountId") &&
        newState.accountId !== oldState.accountId) ||
      (newState.hasOwnProperty("privateKey") &&
        newState.privateKey !== oldState.privateKey)
    ) {
      clientAdapter.setState({
        publicKey: clientState.publicKey,
        accountId: clientState.accountId,
        lastWalletId: clientState.lastWalletId,
        networkId: clientConfig.networkId,
      });
    }
  };

  // Client-specific updateTxHistory function
  const clientUpdateTxHistory = (txStatus: TxStatus) => {
    const txId = txStatus.txId;
    clientTxHistory[txId] = {
      ...(clientTxHistory[txId] || {}),
      ...txStatus,
      updateTimestamp: Date.now(),
    };
    clientEvents.notifyTxListeners(clientTxHistory[txId]);
  };

  // Override the global functions with client-specific versions
  const clientSendRpc = async (method: string, params: Record<string, any> | any[]) => {
    if (!clientConfig?.nodeUrl) {
      throw new Error("fastnear: client config missing nodeUrl.");
    }
    const response = await fetch(clientConfig.nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `fastnear-${Date.now()}`,
        method,
        params,
      }),
    });
    const result = await response.json();
    if (result.error) {
      throw new Error(JSON.stringify(result.error));
    }
    return result;
  };

  // Return client API - wrapping existing functions with client-specific state
  return {
    // State accessors
    accountId: (): string | null => clientState.accountId,
    publicKey: (): string | null => clientState.publicKey,
    authStatus: (): "SignedIn" | "SignedOut" => clientState.accountId ? "SignedIn" : "SignedOut",
    
    // Config management
    config: (newConfig?: Partial<NetworkConfig>): NetworkConfig => {
      if (newConfig) {
        if (newConfig.networkId && clientConfig.networkId !== newConfig.networkId) {
          clientConfig = { ...NETWORKS[newConfig.networkId], networkId: newConfig.networkId };
          clientUpdate({ accountId: null, privateKey: null, lastWalletId: null });
          clientTxHistory = {};
        }
        clientConfig = { ...clientConfig, ...newConfig };
      }
      return clientConfig;
    },

    // Selection info
    selected: () => {
      const network = clientConfig.networkId;
      const nodeUrl = clientConfig.nodeUrl;
      const walletUrl = clientConfig.walletUrl;
      const helperUrl = clientConfig.helperUrl;
      const explorerUrl = clientConfig.explorerUrl;
      const account = clientState.accountId;
      const contract = clientState.accessKeyContractId;
      const publicKey = clientState.publicKey;

      return {
        network,
        nodeUrl,
        walletUrl,
        helperUrl,
        explorerUrl,
        account,
        contract,
        publicKey
      };
    },

    // Authentication - using the existing function but with client state
    requestSignIn: async (params = {}, callbacks = {}) => {
      // We'll need to temporarily override the global state for this call
      // This is the "simple wrapper" approach - we use existing functions but manage state
      const originalState = { ..._state };
      const originalConfig = { ..._config };
      
      try {
        // Temporarily set global state to client state
        Object.assign(_state, clientState);
        Object.assign(_config, clientConfig);
        
        const result = await near.requestSignIn(params, callbacks);
        
        // Update client state with results
        clientUpdate({
          accountId: _state.accountId,
          privateKey: _state.privateKey,
          publicKey: _state.publicKey,
          accessKeyContractId: _state.accessKeyContractId
        });
        
        return result;
      } finally {
        // Restore original global state
        Object.assign(_state, originalState);
        Object.assign(_config, originalConfig);
      }
    },

    signOut: async () => {
      await clientAdapter.signOut();
      clientUpdate({ accountId: null, privateKey: null, accessKeyContractId: null, lastWalletId: null });
    },

    // RPC methods - using client config
    sendRpc: clientSendRpc,
    
    // Wrap other functions to use client state/config
    view: (params: any) => {
      const originalConfig = { ..._config };
      try {
        Object.assign(_config, clientConfig);
        return near.view(params);
      } finally {
        Object.assign(_config, originalConfig);
      }
    },

    queryAccount: (params: any) => {
      const originalConfig = { ..._config };
      try {
        Object.assign(_config, clientConfig);
        return near.queryAccount(params);
      } finally {
        Object.assign(_config, originalConfig);
      }
    },

    queryBlock: (params: any) => {
      const originalConfig = { ..._config };
      try {
        Object.assign(_config, clientConfig);
        return near.queryBlock(params);
      } finally {
        Object.assign(_config, originalConfig);
      }
    },

    queryAccessKey: (params: any) => {
      const originalConfig = { ..._config };
      try {
        Object.assign(_config, clientConfig);
        return near.queryAccessKey(params);
      } finally {
        Object.assign(_config, originalConfig);
      }
    },

    queryTx: (params: any) => {
      const originalConfig = { ..._config };
      try {
        Object.assign(_config, clientConfig);
        return near.queryTx(params);
      } finally {
        Object.assign(_config, originalConfig);
      }
    },

    // Transaction methods
    sendTx: async (params: any) => {
      const originalState = { ..._state };
      const originalConfig = { ..._config };
      
      try {
        Object.assign(_state, clientState);
        Object.assign(_config, clientConfig);
        
        const result = await near.sendTx(params);
        
        // Update client state
        clientUpdate({
          accountId: _state.accountId,
          privateKey: _state.privateKey,
          publicKey: _state.publicKey,
          accessKeyContractId: _state.accessKeyContractId
        });
        
        return result;
      } finally {
        Object.assign(_state, originalState);
        Object.assign(_config, originalConfig);
      }
    },

    signMessage: async (params: any) => {
      const originalState = { ..._state };
      try {
        Object.assign(_state, clientState);
        return await near.signMessage(params);
      } finally {
        Object.assign(_state, originalState);
      }
    },

    // Transaction history
    localTxHistory: () => clientTxHistory,

    // Events
    event: clientEvents,

    // Action helpers (these are pure functions, no state needed)
    actions: near.actions,

    // Utils and exports (these are pure, no state needed)
    utils: near.utils,
    exp: near.exp,
  };
}
