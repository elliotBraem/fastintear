import * as near from "./near.js";
import { 
  type NetworkConfig,
  type WalletState,
  type TxStatus,
  type StateManager,
  type ExternalStateManager,
  type StateChangeCallbacks,
  NETWORKS,
  DEFAULT_NETWORK_ID,
  WIDGET_URL,
  LocalStorageStateManager,
  MemoryStateManager,
  ExternalStateManagerWrapper,
  TxHistoryManager
} from "./state.js";
import { WalletAdapter } from "./intear.js";
import { publicKeyFromPrivate } from "@fastnear/utils";

export interface ClientConfig {
  networkId?: string;
  stateManager?: StateManager | ExternalStateManager;
  callbacks?: StateChangeCallbacks;
  isolateState?: boolean; // Use memory state manager for complete isolation
}

/**
 * Creates a NEAR client instance with modern state management
 */
export function createNearClient(config: ClientConfig = {}) {
  const networkId = config.networkId || DEFAULT_NETWORK_ID;
  const networkConfig: NetworkConfig = {
    ...NETWORKS[networkId],
    networkId,
  };

  // Determine state manager
  let stateManager: StateManager;
  if (config.stateManager) {
    // If it's an ExternalStateManager, wrap it
    if ('subscribe' in config.stateManager) {
      stateManager = config.stateManager as StateManager;
    } else {
      stateManager = new ExternalStateManagerWrapper(config.stateManager as ExternalStateManager);
    }
  } else if (config.isolateState) {
    stateManager = new MemoryStateManager(networkId);
  } else {
    stateManager = new LocalStorageStateManager(networkId);
  }

  // Transaction history manager
  const txHistoryManager = new TxHistoryManager();

  // Current state cache
  let currentState: WalletState | null = null;

  // Initialize state
  stateManager.getState().then(state => {
    currentState = state;
    if (state && config.callbacks?.onStateChange) {
      config.callbacks.onStateChange(state);
    }
  });

  // Subscribe to state changes
  const unsubscribeState = stateManager.subscribe((state) => {
    const previousState = currentState;
    currentState = state;

    // Trigger callbacks
    if (config.callbacks?.onStateChange) {
      config.callbacks.onStateChange(state);
    }

    // Check for connect/disconnect events
    if (!previousState?.accountId && state.accountId) {
      config.callbacks?.onConnect?.({
        accountId: state.accountId,
        publicKey: state.publicKey || '',
      });
    } else if (previousState?.accountId && !state.accountId) {
      config.callbacks?.onDisconnect?.();
    }
  });

  // Create isolated adapter for this client
  const clientAdapter = new WalletAdapter({
    onStateUpdate: async (adapterState: any) => {
      const { accountId, lastWalletId, privateKey } = adapterState;
      
      if (accountId !== currentState?.accountId) {
        const newState: WalletState = {
          accountId: accountId || null,
          publicKey: privateKey ? publicKeyFromPrivate(privateKey) : null,
          privateKey: privateKey || null,
          networkId,
          lastWalletId: lastWalletId || null,
          accessKeyContractId: currentState?.accessKeyContractId || null,
        };
        
        await stateManager.setState(newState);
      }
    },
    walletUrl: WIDGET_URL,
  });


  // Return client API
  return {
    // State accessors
    accountId: (): string | null => currentState?.accountId || null,
    publicKey: (): string | null => currentState?.publicKey || null,
    authStatus: (): "SignedIn" | "SignedOut" => currentState?.accountId ? "SignedIn" : "SignedOut",
    
    // State management
    getState: (): Promise<WalletState | null> => stateManager.getState(),
    setState: (state: WalletState): Promise<void> => stateManager.setState(state),
    clearState: (): Promise<void> => stateManager.clearState(),
    
    // State restoration for external management
    restoreFromExternalState: async (state: {
      accountId: string;
      publicKey: string;
      privateKey?: string;
      networkId: string;
    }): Promise<void> => {
      const walletState: WalletState = {
        accountId: state.accountId,
        publicKey: state.publicKey,
        privateKey: state.privateKey || null,
        networkId: state.networkId,
        lastWalletId: null,
        accessKeyContractId: null,
      };
      await stateManager.setState(walletState);
    },

    // Check if externally managed
    isExternallyManaged: (): boolean => {
      return stateManager instanceof ExternalStateManagerWrapper;
    },

    // Config management
    config: (newConfig?: Partial<NetworkConfig>): NetworkConfig => {
      if (newConfig) {
        Object.assign(networkConfig, newConfig);
        
        // If network changed, clear state
        if (newConfig.networkId && networkConfig.networkId !== newConfig.networkId) {
          stateManager.clearState();
          txHistoryManager.clearHistory();
        }
      }
      return networkConfig;
    },

    // Selection info
    selected: () => {
      const network = networkConfig.networkId;
      const nodeUrl = networkConfig.nodeUrl;
      const walletUrl = networkConfig.walletUrl;
      const helperUrl = networkConfig.helperUrl;
      const explorerUrl = networkConfig.explorerUrl;
      const account = currentState?.accountId;
      const contract = currentState?.accessKeyContractId;
      const publicKey = currentState?.publicKey;

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
    requestSignIn: async (
      params: Parameters<typeof near.requestSignIn>[0] = {},
      callbacks: Parameters<typeof near.requestSignIn>[1] = {}
    ): Promise<ReturnType<typeof near.requestSignIn>> => {
      const result = await near.requestSignIn(params, callbacks);
      
      // Update state with results
      if (result.accountId) {
        const newState: WalletState = {
          accountId: result.accountId,
          publicKey: result.publicKey,
          privateKey: null, // Will be set by adapter
          networkId,
          lastWalletId: null,
          accessKeyContractId: params.contractId || null,
        };
        await stateManager.setState(newState);
      }
      
      return result;
    },

    signOut: async () => {
      await clientAdapter.signOut();
      await stateManager.clearState();
    },

    // RPC methods
    sendRpc: near.sendRpc,
    
    // Query methods
    view: near.view,
    queryAccount: near.queryAccount,
    queryBlock: near.queryBlock,
    queryAccessKey: near.queryAccessKey,
    queryTx: near.queryTx,

    // Transaction methods
    sendTx: near.sendTx,
    signMessage: near.signMessage,

    // Transaction history
    localTxHistory: () => txHistoryManager.getHistory(),

    // State subscription
    subscribe: (callback: (state: WalletState) => void): (() => void) => {
      return stateManager.subscribe(callback);
    },

    // Transaction subscription
    onTx: (callback: (tx: TxStatus) => void): (() => void) => {
      return txHistoryManager.subscribe(callback);
    },

    // Action helpers
    actions: near.actions,

    // Utils and exports
    utils: near.utils,
    exp: near.exp,

    // Cleanup
    destroy: () => {
      unsubscribeState();
    },
  };
}
