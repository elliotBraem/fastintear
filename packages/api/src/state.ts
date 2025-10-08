import {
  lsGet,
  lsSet,
  publicKeyFromPrivate,
} from "./utils";

export const WIDGET_URL = "https://wallet.intear.tech";
export const DEFAULT_NETWORK_ID = "mainnet";

export const NETWORKS = {
  testnet: {
    networkId: "testnet",
    nodeUrl: "https://rpc.testnet.fastnear.com/",
  },
  mainnet: {
    networkId: "mainnet",
    nodeUrl: "https://rpc.mainnet.fastnear.com/",
  },
};

export interface NetworkConfig {
  networkId: string;
  nodeUrl?: string;
  walletUrl?: string;
  helperUrl?: string;
  explorerUrl?: string;
  [key: string]: any;
}

// Modern WalletState interface - comprehensive state representation
export interface WalletState {
  accountId: string | null;
  publicKey: string | null;
  privateKey: string | null;
  networkId: string;
  lastWalletId?: string | null;
  accessKeyContractId?: string | null;
}

// State change callbacks for reactive state management
export interface StateChangeCallbacks {
  onStateChange?: (newState: WalletState) => void;
  onConnect?: (accountData: { accountId: string; publicKey: string }) => void;
  onDisconnect?: () => void;
}

// External state manager interface
export interface ExternalStateManager {
  getState(): Promise<WalletState | null>;
  setState(state: WalletState): Promise<void>;
  clearState(): Promise<void>;
}

// Unified state manager interface
export interface StateManager {
  getState(): Promise<WalletState | null>;
  setState(state: WalletState): Promise<void>;
  clearState(): Promise<void>;
  subscribe(callback: (state: WalletState) => void): () => void;
}

// LocalStorage-based state manager implementation
export class LocalStorageStateManager implements StateManager {
  private subscribers = new Set<(state: WalletState) => void>();
  private currentState: WalletState | null = null;

  constructor(private networkId: string = DEFAULT_NETWORK_ID) {
    this.loadInitialState();
  }

  private loadInitialState(): void {
    try {
      const savedState = lsGet("walletState") as WalletState | null;
      if (savedState && savedState.networkId === this.networkId) {
        // Ensure publicKey is derived from privateKey if available
        if (savedState.privateKey && !savedState.publicKey) {
          savedState.publicKey = publicKeyFromPrivate(savedState.privateKey);
        }
        this.currentState = savedState;
      }
    } catch (e) {
      console.error("Error loading initial state:", e);
      this.currentState = null;
    }
  }

  async getState(): Promise<WalletState | null> {
    return this.currentState;
  }

  async setState(state: WalletState): Promise<void> {
    // Ensure publicKey is derived from privateKey
    if (state.privateKey && !state.publicKey) {
      state.publicKey = publicKeyFromPrivate(state.privateKey);
    }

    this.currentState = state;
    lsSet("walletState", state);

    // Clear nonce when private key changes
    if (state.privateKey !== this.currentState?.privateKey) {
      lsSet("nonce", null);
    }

    // Notify subscribers
    this.notifySubscribers(state);
  }

  async clearState(): Promise<void> {
    const clearedState: WalletState = {
      accountId: null,
      publicKey: null,
      privateKey: null,
      networkId: this.networkId,
      lastWalletId: null,
      accessKeyContractId: null,
    };

    this.currentState = clearedState;
    lsSet("walletState", null);
    lsSet("nonce", null);
    lsSet("block", null);

    // Notify subscribers of cleared state
    this.notifySubscribers(clearedState);
  }

  subscribe(callback: (state: WalletState) => void): () => void {
    this.subscribers.add(callback);

    // Immediately call with current state if available
    if (this.currentState) {
      callback(this.currentState);
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers(state: WalletState): void {
    this.subscribers.forEach(callback => {
      try {
        callback(state);
      } catch (e) {
        console.error("Error in state subscriber:", e);
      }
    });
  }
}

// Memory-based state manager implementation (for testing/isolation)
export class MemoryStateManager implements StateManager {
  private subscribers = new Set<(state: WalletState) => void>();
  private currentState: WalletState | null = null;

  constructor(private networkId: string = DEFAULT_NETWORK_ID) {
    this.currentState = {
      accountId: null,
      publicKey: null,
      privateKey: null,
      networkId: this.networkId,
      lastWalletId: null,
      accessKeyContractId: null,
    };
  }

  async getState(): Promise<WalletState | null> {
    return this.currentState;
  }

  async setState(state: WalletState): Promise<void> {
    // Ensure publicKey is derived from privateKey
    if (state.privateKey && !state.publicKey) {
      state.publicKey = publicKeyFromPrivate(state.privateKey);
    }

    this.currentState = state;
    this.notifySubscribers(state);
  }

  async clearState(): Promise<void> {
    const clearedState: WalletState = {
      accountId: null,
      publicKey: null,
      privateKey: null,
      networkId: this.networkId,
      lastWalletId: null,
      accessKeyContractId: null,
    };

    this.currentState = clearedState;
    this.notifySubscribers(clearedState);
  }

  subscribe(callback: (state: WalletState) => void): () => void {
    this.subscribers.add(callback);

    // Immediately call with current state if available
    if (this.currentState) {
      callback(this.currentState);
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers(state: WalletState): void {
    this.subscribers.forEach(callback => {
      try {
        callback(state);
      } catch (e) {
        console.error("Error in state subscriber:", e);
      }
    });
  }
}

// External state manager wrapper
export class ExternalStateManagerWrapper implements StateManager {
  private subscribers = new Set<(state: WalletState) => void>();
  private currentState: WalletState | null = null;

  constructor(private externalManager: ExternalStateManager) {
    this.loadInitialState();
  }

  private async loadInitialState(): Promise<void> {
    try {
      this.currentState = await this.externalManager.getState();
    } catch (e) {
      console.error("Error loading external state:", e);
      this.currentState = null;
    }
  }

  async getState(): Promise<WalletState | null> {
    try {
      this.currentState = await this.externalManager.getState();
      return this.currentState;
    } catch (e) {
      console.error("Error getting external state:", e);
      return this.currentState;
    }
  }

  async setState(state: WalletState): Promise<void> {
    try {
      // Ensure publicKey is derived from privateKey
      if (state.privateKey && !state.publicKey) {
        state.publicKey = publicKeyFromPrivate(state.privateKey);
      }

      await this.externalManager.setState(state);
      this.currentState = state;
      this.notifySubscribers(state);
    } catch (e) {
      console.error("Error setting external state:", e);
      throw e;
    }
  }

  async clearState(): Promise<void> {
    try {
      await this.externalManager.clearState();
      this.currentState = null;

      // Notify with null state
      this.subscribers.forEach(callback => {
        try {
          callback({
            accountId: null,
            publicKey: null,
            privateKey: null,
            networkId: this.currentState?.networkId || DEFAULT_NETWORK_ID,
            lastWalletId: null,
            accessKeyContractId: null,
          });
        } catch (e) {
          console.error("Error in state subscriber:", e);
        }
      });
    } catch (e) {
      console.error("Error clearing external state:", e);
      throw e;
    }
  }

  subscribe(callback: (state: WalletState) => void): () => void {
    this.subscribers.add(callback);

    // Immediately call with current state if available
    if (this.currentState) {
      callback(this.currentState);
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers(state: WalletState): void {
    this.subscribers.forEach(callback => {
      try {
        callback(state);
      } catch (e) {
        console.error("Error in state subscriber:", e);
      }
    });
  }
}

// Transaction status types and interfaces
export type TxStatusType =
  | 'Pending'
  | 'Included'
  | 'Executed'
  | 'Error'
  | 'ErrorAfterIncluded'
  | 'RejectedByUser'
  | 'PendingGotTxHash';

export interface TxStatus {
  txId: string;
  updateTimestamp?: number;
  status?: TxStatusType;
  tx?: any;
  txHash?: string;
  result?: any;
  error?: string | object;
  successValue?: any;
  finalState?: boolean;
  signature?: string;
  signedTxBase64?: string;
}

export type TxHistory = Record<string, TxStatus>;

// Transaction history manager
export class TxHistoryManager {
  private txHistory: TxHistory = {};
  private subscribers = new Set<(tx: TxStatus) => void>();

  constructor() {
    this.loadHistory();
  }

  private loadHistory(): void {
    try {
      this.txHistory = lsGet("txHistory") || {};
    } catch (e) {
      console.error("Error loading transaction history:", e);
      this.txHistory = {};
    }
  }

  updateTx(txStatus: TxStatus): void {
    const txId = txStatus.txId;
    this.txHistory[txId] = {
      ...(this.txHistory[txId] || {}),
      ...txStatus,
      updateTimestamp: Date.now(),
    };

    lsSet("txHistory", this.txHistory);
    this.notifySubscribers(this.txHistory[txId]);
  }

  getHistory(): TxHistory {
    return this.txHistory;
  }

  clearHistory(): void {
    this.txHistory = {};
    lsSet("txHistory", {});
  }

  subscribe(callback: (tx: TxStatus) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers(tx: TxStatus): void {
    this.subscribers.forEach(callback => {
      try {
        callback(tx);
      } catch (e) {
        console.error("Error in tx subscriber:", e);
      }
    });
  }
}