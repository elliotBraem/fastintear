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

  const withClientState = <T>(fn: () => T): T => {
    const [originalState, originalConfig] = [{ ..._state }, { ..._config }];
    Object.assign(_state, clientState);
    Object.assign(_config, clientConfig);
    try {
      return fn();
    } finally {
      Object.assign(_state, originalState);
      Object.assign(_config, originalConfig);
    }
  };

  // Return client API
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

    // Authentication methods
    requestSignIn: (
      params: Parameters<typeof near.requestSignIn>[0] = {},
      callbacks: Parameters<typeof near.requestSignIn>[1] = {}
    ): ReturnType<typeof near.requestSignIn> => 
      withClientState(async () => {
        const result = await near.requestSignIn(params, callbacks);
        
        // Update client state with results
        clientUpdate({
          accountId: _state.accountId,
          privateKey: _state.privateKey,
          publicKey: _state.publicKey,
          accessKeyContractId: _state.accessKeyContractId
        });
        
        return result;
      }),

    signOut: async () => {
      await clientAdapter.signOut();
      clientUpdate({ accountId: null, privateKey: null, accessKeyContractId: null, lastWalletId: null });
    },

    // RPC methods
    sendRpc: clientSendRpc,
    
    // Query methods
    view: (params: Parameters<typeof near.view>[0]): ReturnType<typeof near.view> => 
      withClientState(() => near.view(params)),

    queryAccount: (params: Parameters<typeof near.queryAccount>[0]): ReturnType<typeof near.queryAccount> => 
      withClientState(() => near.queryAccount(params)),

    queryBlock: (params: Parameters<typeof near.queryBlock>[0]): ReturnType<typeof near.queryBlock> => 
      withClientState(() => near.queryBlock(params)),

    queryAccessKey: (params: Parameters<typeof near.queryAccessKey>[0]): ReturnType<typeof near.queryAccessKey> => 
      withClientState(() => near.queryAccessKey(params)),

    queryTx: (params: Parameters<typeof near.queryTx>[0]): ReturnType<typeof near.queryTx> => 
      withClientState(() => near.queryTx(params)),

    // Transaction methods
    sendTx: (params: Parameters<typeof near.sendTx>[0]): ReturnType<typeof near.sendTx> => 
      withClientState(async () => {
        const result = await near.sendTx(params);
        
        // Update client state
        clientUpdate({
          accountId: _state.accountId,
          privateKey: _state.privateKey,
          publicKey: _state.publicKey,
          accessKeyContractId: _state.accessKeyContractId
        });
        
        return result;
      }),

    signMessage: (params: Parameters<typeof near.signMessage>[0]): ReturnType<typeof near.signMessage> => 
      withClientState(() => near.signMessage(params)),

    // Transaction history
    localTxHistory: () => clientTxHistory,

    // Events
    event: clientEvents,

    // Action helpers
    actions: near.actions,

    // Utils and exports
    utils: near.utils,
    exp: near.exp,
  };
}
