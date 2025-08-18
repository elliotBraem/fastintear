import {
  fromBase58,
  privateKeyFromRandom,
  publicKeyFromPrivate,
  signHash
} from "@fastnear/utils";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import type { Account, SignatureResult, WalletTxResult } from "./near";
import { signOut } from "./near";

const DEFAULT_WALLET_DOMAIN = "https://wallet.intear.tech";
const DEFAULT_LOGOUT_BRIDGE_SERVICE = "https://logout-bridge-service.intear.tech";
const STORAGE_KEY = "_intear_wallet_connected_account";
const POPUP_FEATURES = "width=400,height=700";

let hasCheckedLogout = false;
let checkingAccountPromise: Promise<Account[]> | null = null;
let sessionVerificationInProgress = false;

interface Transaction {
  signerId?: string;
  receiverId: string;
  actions: Array<any>;
}

export interface TransactionResult {
  /** URL to redirect to if needed. */
  url?: string;

  /** Transaction hash if immediately available. */
  hash?: string;

  /** Error message if the transaction failed. */
  error?: string;
}

export interface WalletAdapterConstructor {
  walletUrl?: string;
  targetOrigin?: string;
  onStateUpdate?: (state: any) => void;
  lastState?: any;
  callbackUrl?: string;
  logoutBridgeService?: string;
}

interface SavedData {
  accounts: Account[];
  key: string;
  contractId: string;
  methodNames: string[];
  logoutKey: string;
  networkId: string;
}

class IntearAdapterError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "IntearAdapterError";
    if (cause) {
      this.stack += `\nCaused by: ${cause instanceof Error ? cause.stack : String(cause)
        }`;
    }
  }
}

type WsClientMessage = {
  Auth: {
    network: string; // e.g., "mainnet", "testnet"
    account_id: string;
    app_public_key: string;
    nonce: number;
    signature: string;
  };
};

type LogoutInfo = {
  nonce: number;
  signature: string;
  caused_by: "User" | "App";
};

type WsServerMessage =
  | { Error: { message: string } }
  | { Success: { message: string } }
  | {
    LoggedOut: {
      network: string;
      account_id: string;
      app_public_key: string;
      logout_info: LogoutInfo;
    };
  };

type SessionStatus = "Active" | { LoggedOut: LogoutInfo };


class LogoutWebSocket {
  private static instance: LogoutWebSocket | null = null;
  private ws: WebSocket | null = null;
  private network: string;
  private accountId: string;
  private appPrivateKey: string;
  private userLogoutPublicKey: string;
  private logoutBridgeServiceUrl: string;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private logger: Console;

  private constructor(
    network: string,
    accountId: string,
    appPrivateKey: string,
    userLogoutPublicKey: string,
    logoutBridgeServiceUrl: string,
    logger: Console
  ) {
    this.network = network;
    this.accountId = accountId;
    this.appPrivateKey = appPrivateKey;
    this.userLogoutPublicKey = userLogoutPublicKey;
    this.logoutBridgeServiceUrl = logoutBridgeServiceUrl;
    this.logger = logger;
    this.connect();
  }

  private async connect() {
    try {
      const wsUrl = this.logoutBridgeServiceUrl
        .replace("https://", "wss://")
        .replace("http://", "ws://");
      this.ws = new WebSocket(`${wsUrl}/api/subscribe`);

      this.ws.onopen = async () => {
        if (!this.ws) {
          return;
        }

        const nonce = Date.now();
        const messageText = `subscribe|${nonce}`;
        const messageBytes = new TextEncoder().encode(messageText);

        const appPublicKeyString = publicKeyFromPrivate(this.appPrivateKey);
        const signatureBase58 = signHash(messageBytes, this.appPrivateKey, { returnBase58: true }) as string;
        const signatureString = `ed25519:${signatureBase58}`;

        const authMessage: WsClientMessage = {
          Auth: {
            network: this.network,
            account_id: this.accountId,
            app_public_key: appPublicKeyString,
            nonce,
            signature: signatureString,
          },
        };

        this.ws.send(JSON.stringify(authMessage));
      };

      this.ws.onmessage = async (event) => {
        const message = JSON.parse(event.data as string) as WsServerMessage;

        if ("Success" in message) {
          this.logger.log("LogoutWebSocket:", message.Success.message);
          this.reconnectAttempts = 0;
        } else if ("Error" in message) {
          this.logger.error("LogoutWebSocket error:", message.Error.message);
          this.ws?.close();
        } else if ("LoggedOut" in message) {
          const { logout_info: logoutInfo } = message.LoggedOut;
          this.logger.log("LogoutWebSocket: Received logout notification:", logoutInfo);

          // TODO: verify, 
          // validateNonce
          if (
            logoutInfo.nonce > Date.now() ||
            logoutInfo.nonce < Date.now() - 1000 * 60 * 5 // 5 minutes tolerance
          ) {
            this.logger.error("LogoutWebSocket: Invalid logout nonce:", logoutInfo.nonce);
            return;
          }

          const appPublicKeyString = publicKeyFromPrivate(this.appPrivateKey);
          const verifyMessageText = `logout|${logoutInfo.nonce}|${this.accountId}|${appPublicKeyString}`; // validateMessage
          const verifyMessageBytes = new TextEncoder().encode(verifyMessageText);

          const sigParts = logoutInfo.signature.split(":");
          if (sigParts.length !== 2 || (sigParts[0] !== "ed25519" && sigParts[0] !== "secp256k1")) {
            this.logger.error("LogoutWebSocket: Invalid signature format:", logoutInfo.signature);
            return;
          }
          const sigData = sigParts[1];
          const signatureBytes = fromBase58(sigData);

          let effectiveVerifyKey: string;
          if (logoutInfo.caused_by === "User") {
            effectiveVerifyKey = this.userLogoutPublicKey;
          } else if (logoutInfo.caused_by === "App") {
            // No idea how the user can be signed out by the app and the app doesn't
            // know that, but whatever, handle this anyway
            effectiveVerifyKey = appPublicKeyString;
          } else {
            this.logger.error("LogoutWebSocket: Unknown logout cause:", logoutInfo.caused_by);
            return;
          }

          // Convert effectiveVerifyKey string (e.g., "ed25519:...") to Uint8Array
          let publicKeyBytes: Uint8Array;
          const base58PublicKey = effectiveVerifyKey.substring("ed25519:".length);
          publicKeyBytes = fromBase58(base58PublicKey);

          const isValid = ed25519.verify(signatureBytes, verifyMessageBytes, publicKeyBytes);

          if (!isValid) {
            this.logger.error("LogoutWebSocket: Invalid logout signature");
            return;
          }

          this.logger.log(
            "LogoutWebSocket: Valid logout message received. Calling signOut and reloading."
          );
          // Call the signOut function from near.ts to properly update the application state
          signOut();
          this.intentionallyClosed = true;
          this.close();
          window.location.reload();
        }
      };

      this.ws.onclose = () => {
        this.logger.log("LogoutWebSocket: Connection closed.");
        // If it was intentionally closed, do not attempt to reconnect
        if (this.intentionallyClosed) {
          // If this instance is the current static instance, nullify it
          if (LogoutWebSocket.instance === this) {
            LogoutWebSocket.instance = null;
          }
        } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          this.logger.log(`LogoutWebSocket: Attempting to reconnect in 500ms... (Attempt ${this.reconnectAttempts} of ${this.maxReconnectAttempts})`);
          setTimeout(() => this.connect(), 500);
        } else {
          this.logger.warn(`LogoutWebSocket: Maximum reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
          if (LogoutWebSocket.instance === this) {
            LogoutWebSocket.instance = null;
          }
        }
      };

      this.ws.onerror = (error) => {
        this.logger.warn("LogoutWebSocket: Error:", error);
        if (!this.intentionallyClosed) {
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.logger.log(`LogoutWebSocket: Attempting to reconnect in 500ms... (Attempt ${this.reconnectAttempts} of ${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), 500);
          } else {
            this.logger.warn(`LogoutWebSocket: Maximum reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
            if (LogoutWebSocket.instance === this) {
              LogoutWebSocket.instance = null;
            }
          }
        } else {
          LogoutWebSocket.instance = null;
        }
      };
    } catch (error) {
      this.logger.warn("LogoutWebSocket: Error creating WebSocket connection:", error);
      // Don't let WebSocket connection failures break the app
    }
  }

  public static initialize(
    network: string,
    accountId: string,
    appPrivateKey: string,
    userLogoutPublicKey: string,
    logoutBridgeServiceUrl: string,
    logger: Console
  ): LogoutWebSocket | null {
    try {
      if (LogoutWebSocket.instance) {
        // If an instance already exists, return it
        return LogoutWebSocket.instance;
      }

      // Create and connect new instance
      LogoutWebSocket.instance = new LogoutWebSocket(
        network,
        accountId,
        appPrivateKey,
        userLogoutPublicKey,
        logoutBridgeServiceUrl,
        logger
      );

      return LogoutWebSocket.instance;
    } catch (error) {
      // Catch any unexpected errors during initialization
      logger.warn("LogoutWebSocket: Failed to initialize:", error);
      return null;
    }
  }

  public static getInstance(): LogoutWebSocket | null {
    return LogoutWebSocket.instance;
  }

  public close() {
    if (this.ws) {
      this.intentionallyClosed = true;
      this.ws.close();
    }
    LogoutWebSocket.instance = null;
  }
}


async function generateAuthSignature(
  privateKey: string,
  data: string,
  nonce: number
): Promise<string> {
  // TODO: replace with near-sign-verify? sign(message, options)
  const messageToSign = nonce.toString() + "|" + data; // need to append TAG, could break his verify
  const messageBytes = new TextEncoder().encode(messageToSign); // maybe we should adopt nonce prepended in messages
  const hashBytes = sha256(messageBytes);

  const signatureBase58 = signHash(hashBytes, privateKey, { returnBase58: true }) as string;

  return `ed25519:${signatureBase58}`;
}

function assertLoggedIn(): SavedData {
  if (typeof window === 'undefined') {
    throw new IntearAdapterError("Cannot access localStorage in this environment.");
  }
  const savedDataStr = window.localStorage.getItem(STORAGE_KEY);
  if (!savedDataStr) {
    throw new IntearAdapterError("Not signed in (no data found)");
  }
  try {
    const savedData = JSON.parse(savedDataStr) as SavedData;
    if (!savedData || !savedData.accounts || savedData.accounts.length === 0 || !savedData.key) {
      throw new Error("Invalid saved data structure");
    }
    return savedData;
  } catch (e) {
    console.error("Error parsing saved login data, clearing storage.", e);
    window.localStorage.removeItem(STORAGE_KEY);
    throw new IntearAdapterError("Failed to parse login data, please sign in again.", e);
  }
}

/**
 * Safely get saved data without throwing
 * @returns SavedData or null if not logged in or error
 */
function getSavedData(): SavedData | null {
  try {
    return assertLoggedIn();
  } catch {
    return null;
  }
}

/**
 * Verify a logout signature from the bridge service
 * @returns true if signature is valid, false otherwise
 */
function verifyLogoutSignature(
  logoutInfo: LogoutInfo,
  accountId: string,
  appPublicKeyString: string,
  userLogoutPublicKey: string
): boolean {
  try {
    const logoutMessageToVerify = `logout|${logoutInfo.nonce}|${accountId}|${appPublicKeyString}`;
    const sigParts = logoutInfo.signature.split(":");

    if (sigParts.length !== 2 || (sigParts[0] !== "ed25519" && sigParts[0] !== "secp256k1")) {
      console.error("WalletAdapter: Invalid signature format:", logoutInfo.signature);
      return false;
    }

    const sigData = sigParts[1];
    const signatureToVerify = fromBase58(sigData);

    let verifyKey: string;
    if (logoutInfo.caused_by === "User") {
      verifyKey = userLogoutPublicKey;
    } else if (logoutInfo.caused_by === "App") {
      verifyKey = appPublicKeyString;
    } else {
      console.error("WalletAdapter: Unknown logout cause:", logoutInfo.caused_by);
      return false;
    }

    const base58PublicKey = verifyKey.substring("ed25519:".length);
    const publicKeyBytes = fromBase58(base58PublicKey);

    return ed25519.verify(
      signatureToVerify,
      new TextEncoder().encode(logoutMessageToVerify),
      publicKeyBytes
    );
  } catch (error) {
    console.error("WalletAdapter: Error verifying logout signature:", error);
    return false;
  }
}

/**
 * Verify session status with the bridge service
 * @returns Object with session status and accounts
 */
async function verifySessionStatus(
  savedData: SavedData,
  logoutBridgeService: string,
  onStateUpdate?: (state: any) => void
): Promise<{ isActive: boolean; accounts: Account[] }> {
  try {
    const account = savedData.accounts[0];
    const networkId = savedData.networkId;
    const appPrivateKey = savedData.key;
    const appPublicKeyString = publicKeyFromPrivate(appPrivateKey);

    // Initialize WebSocket for real-time logout notifications
    LogoutWebSocket.initialize(
      networkId,
      account.accountId,
      appPrivateKey,
      savedData.logoutKey,
      logoutBridgeService,
      console
    );

    // Check current session status
    const nonce = Date.now();
    const checkMessage = `check|${nonce}`;
    const messageBytes = new TextEncoder().encode(checkMessage);
    const signatureBase58 = signHash(messageBytes, appPrivateKey, { returnBase58: true }) as string;
    const signatureString = `ed25519:${signatureBase58}`;

    const response = await fetch(
      `${logoutBridgeService}/api/check_logout/${networkId}/${account.accountId}/${appPublicKeyString}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ nonce, signature: signatureString }),
      }
    );

    if (!response.ok) {
      console.warn("WalletAdapter: Failed to check logout status:", await response.text());
      return { isActive: true, accounts: savedData.accounts }; // Assume active if we can't check
    }

    const status = (await response.json()) as SessionStatus;
    console.debug("WalletAdapter: Logout check response:", status);

    if (status === "Active") {
      return { isActive: true, accounts: savedData.accounts };
    } else {
      // Handle logout case
      const logoutInfo = (status as { LoggedOut: LogoutInfo }).LoggedOut;
      console.debug("WalletAdapter: User was logged out:", logoutInfo);

      // Verify the logout signature
      const isValid = verifyLogoutSignature(
        logoutInfo,
        account.accountId,
        appPublicKeyString,
        savedData.logoutKey
      );

      if (!isValid) {
        console.error("WalletAdapter: Invalid logout signature");
        return { isActive: true, accounts: savedData.accounts }; // Treat as active if signature invalid
      }

      // Clear storage if signature is valid
      console.debug("WalletAdapter: Valid remote logout. Clearing local session.");
      window.localStorage.removeItem(STORAGE_KEY);
      LogoutWebSocket.getInstance()?.close();
      onStateUpdate?.({ accountId: null, networkId: null, publicKey: null });
      return { isActive: false, accounts: [] };
    }
  } catch (error) {
    console.error("WalletAdapter: Error verifying session status:", error);
    return { isActive: true, accounts: savedData.accounts }; // Assume active on error
  }
}

export type SignInStep = 'popup_opening' | 'waiting_for_user' | 'processing_result';

export type SignInErrorType =
  | 'popup_blocked'
  | 'user_cancelled'
  | 'wallet_error'
  | 'network_error'
  | 'timeout'
  | 'unknown';

export type SuggestedAction =
  | 'retry'
  | 'check_popup_blocker'
  | 'try_different_browser'
  | 'contact_support'
  | 'check_network';

export type SignInError = {
  type: SignInErrorType;
  message: string;
  retryable: boolean;
  suggestedAction: SuggestedAction;
  originalError?: any;
  timestamp: number;
}

export interface SignInCallbacks {
  onPending?: (context: { step: SignInStep; networkId: string; contractId?: string }) => void;
  onError?: (error: SignInError) => void;
  timeout?: number;
}

export class WalletAdapter {
  #walletUrl: string;
  #logoutBridgeService: string;
  #onStateUpdate?: (state: any) => void;

  constructor({
    walletUrl = DEFAULT_WALLET_DOMAIN,
    targetOrigin,
    onStateUpdate,
    lastState,
    callbackUrl,
    logoutBridgeService = DEFAULT_LOGOUT_BRIDGE_SERVICE,
  }: WalletAdapterConstructor) {
    this.#walletUrl = walletUrl;
    this.#logoutBridgeService = logoutBridgeService;
    this.#onStateUpdate = onStateUpdate;
    console.debug("Intear Popup WalletAdapter initialized. URL:", this.#walletUrl);
    if (typeof window !== 'undefined') {
      this.initializeSession().catch(err => {
        console.error("Error during initial session initialization:", err);
      });
    }
  }

  async signIn({
    contractId,
    methodNames,
    networkId,
    callbacks
  }: {
    contractId?: string;
    methodNames?: string[];
    networkId: string;
    callbacks?: SignInCallbacks;
  }): Promise<{ accountId: string, accounts: Account[], privateKey?: string, publicKey?: string, error?: string }> {
    console.debug("WalletAdapter: signIn", { contractId, methodNames, networkId });
    const { onPending, onError, timeout = 60000 } = callbacks || {};
    const privateKey = privateKeyFromRandom();

    let timeoutId: NodeJS.Timeout | null = null;

    return new Promise((resolve, reject) => {
      // Step 1: Opening popup
      onPending?.({ step: 'popup_opening', networkId, contractId });

      const popup = window.open(`${this.#walletUrl}/connect`, "_blank", POPUP_FEATURES);
      if (!popup) {
        const error = {
          type: 'popup_blocked' as SignInErrorType,
          message: 'Popup was blocked by browser',
          retryable: true,
          suggestedAction: 'check_popup_blocker' as SuggestedAction,
          timestamp: Date.now(),
        };
        onError?.(error);
        return reject(new IntearAdapterError("Popup was blocked"));
      }

      // Step 2: Waiting for user
      onPending?.({ step: 'waiting_for_user', networkId, contractId });

      // Set up timeout
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          popup.close();
          window.removeEventListener("message", listener);
          clearInterval(checkPopupClosed);

          const error = {
            type: 'timeout' as SignInErrorType,
            message: 'Sign-in timed out',
            retryable: true,
            suggestedAction: 'retry' as SuggestedAction,
            timestamp: Date.now(),
          };
          onError?.(error);
          reject(new IntearAdapterError("Sign-in timeout"));
        }, timeout);
      }

      let done = false;
      const listener = async (event: MessageEvent) => {
        if (event.origin !== new URL(this.#walletUrl).origin) {
          return;
        }
        if (!event.data || !event.data.type) {
          return;
        }

        console.debug("Message from connect popup", event.data);
        switch (event.data.type) {
          case "ready": {
            const origin = location.origin || "file://local-html-file";
            const message = JSON.stringify({ origin });
            const nonce = Date.now();
            const signatureString = await generateAuthSignature(privateKey, message, nonce);
            const publicKey = publicKeyFromPrivate(privateKey);
            popup.postMessage(
              {
                type: "signIn",
                data: {
                  contractId: contractId,
                  methodNames: methodNames,
                  publicKey: publicKey,
                  networkId: networkId,
                  nonce,
                  message,
                  signature: signatureString,
                },
              },
              this.#walletUrl
            );
            break;
          }
          case "connected": {
            // Step 3: Processing result
            onPending?.({ step: 'processing_result', networkId, contractId });

            done = true;
            popup.close();
            window.removeEventListener("message", listener);
            if (timeoutId) clearTimeout(timeoutId);

            const accounts = event.data.accounts as Account[];
            if (!accounts || accounts.length === 0) {
              const error = {
                type: 'wallet_error' as SignInErrorType,
                message: 'No accounts returned from wallet',
                retryable: true,
                suggestedAction: 'retry' as SuggestedAction,
                timestamp: Date.now(),
              };
              onError?.(error);
              return reject(new IntearAdapterError("No accounts returned from wallet"));
            }
            const functionCallKeyAdded = event.data.functionCallKeyAdded;
            const logoutKey = event.data.logoutKey;

            const dataToSave: SavedData = {
              accounts,
              key: privateKey,
              contractId: functionCallKeyAdded && contractId ? contractId : "",
              methodNames: functionCallKeyAdded ? (methodNames ?? []) : [],
              logoutKey: logoutKey,
              networkId: networkId,
            };
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));

            const newState = {
              accountId: accounts[0].accountId,
              networkId,
              privateKey: dataToSave.key,
              publicKey: publicKeyFromPrivate(dataToSave.key)
            };
            this.#onStateUpdate?.(newState);

            // Ensure any old WebSocket instance is closed before initializing a new one
            LogoutWebSocket.getInstance()?.close();

            LogoutWebSocket.initialize(
              dataToSave.networkId,
              dataToSave.accounts[0].accountId,
              dataToSave.key, // App's LAK private key (this is the appPrivateKey for WS)
              dataToSave.logoutKey, // User's main logout public key from wallet
              this.#logoutBridgeService,
              console
            );

            resolve({
              accountId: accounts[0].accountId,
              accounts,
              privateKey: dataToSave.key,
              publicKey: publicKeyFromPrivate(dataToSave.key)
            });
            break;
          }
          case "error": {
            done = true;
            popup.close();
            window.removeEventListener("message", listener);
            if (timeoutId) clearTimeout(timeoutId);

            const errorMessage = event.data.message || "Unknown error from wallet popup";
            const error = {
              type: 'wallet_error' as SignInErrorType,
              message: errorMessage,
              retryable: true,
              suggestedAction: 'contact_support' as SuggestedAction,
              originalError: event.data,
              timestamp: Date.now(),
            };
            onError?.(error);
            reject(new IntearAdapterError(errorMessage));
            break;
          }
        }
      };

      window.addEventListener("message", listener);
      const checkPopupClosed = setInterval(() => {
        if (popup.closed) {
          window.removeEventListener("message", listener);
          clearInterval(checkPopupClosed);
          if (timeoutId) clearTimeout(timeoutId);

          if (!done) {
            const error = {
              type: 'user_cancelled' as SignInErrorType,
              message: 'Sign-in canceled - popup closed by user',
              retryable: true,
              suggestedAction: 'retry' as SuggestedAction,
              timestamp: Date.now(),
            };
            onError?.(error);
            reject(new IntearAdapterError("Sign-in canceled - popup closed by user"));
          }
        }
      }, 100);
    });
  }

  async signOut(): Promise<void> {
    console.debug("WalletAdapter: signOut");
    const savedData = getSavedData();

    LogoutWebSocket.getInstance()?.close();

    if (savedData) {
      try {
        const accountId = savedData.accounts[0].accountId;
        const appPrivateKey = savedData.key;
        const appPublicKeyString = publicKeyFromPrivate(appPrivateKey);
        const networkId = savedData.networkId;
        const nonce = Date.now();

        const messageText = `logout|${nonce}|${accountId}|${appPublicKeyString}`;
        const messageBytes = new TextEncoder().encode(messageText);
        const hashBytes = sha256(messageBytes);
        const signatureBase58 = signHash(hashBytes, appPrivateKey, { returnBase58: true }) as string;
        const signatureString = `ed25519:${signatureBase58}`;

        const response = await fetch(`${this.#logoutBridgeService}/api/logout_app/${networkId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account_id: accountId,
            app_public_key: appPublicKeyString,
            nonce,
            signature: signatureString,
          }),
        });
        if (!response.ok) {
          console.error("WalletAdapter: Failed to notify bridge service of logout:", await response.text());
        } else {
          console.debug("WalletAdapter: Successfully notified bridge service of logout");
        }
      } catch (e) {
        console.error("WalletAdapter: Error during bridge service logout notification:", e);
      }
    }

    window.localStorage.removeItem(STORAGE_KEY);
    this.#onStateUpdate?.({ accountId: null, networkId: null, publicKey: null });
  }

  // Initialize the session by checking if the user is logged in and setting up WebSocket connection
  async initializeSession(): Promise<void> {
    // Prevent multiple simultaneous session verifications
    if (sessionVerificationInProgress) {
      return;
    }

    sessionVerificationInProgress = true;

    try {
      const savedData = getSavedData();

      if (!savedData) {
        // Not signed in, this is normal for new users
        LogoutWebSocket.getInstance()?.close();
        return;
      }

      // Use the shared session verification function
      await verifySessionStatus(savedData, this.#logoutBridgeService, this.#onStateUpdate);

    } catch (e) {
      console.error("WalletAdapter: Unexpected error during session initialization:", e);
      LogoutWebSocket.getInstance()?.close();
    } finally {
      sessionVerificationInProgress = false;
    }
  }


  getState(): { accountId: string | null; networkId: string | null; publicKey?: string | null } {
    const savedData = getSavedData();

    if (savedData) {
      return {
        accountId: savedData.accounts[0].accountId,
        networkId: savedData.networkId,
        publicKey: publicKeyFromPrivate(savedData.key),
      };
    }

    return { accountId: null, networkId: null, publicKey: null };
  }

  setState(state: any): void {
    // console.warn("WalletAdapter: setState called, but state is primarily managed in localStorage for this adapter.");
    this.#onStateUpdate?.(state);
  }

  async getAccounts(): Promise<Account[]> {
    console.debug("WalletAdapter: getAccounts");
    const savedData = getSavedData();

    if (!savedData) {
      return [];
    }

    if (!hasCheckedLogout) {
      if (checkingAccountPromise) {
        return await checkingAccountPromise;
      }

      checkingAccountPromise = new Promise<Array<Account>>(async (resolve) => {
        try {
          // Use the shared session verification function
          const result = await verifySessionStatus(savedData, this.#logoutBridgeService, this.#onStateUpdate);
          resolve(result.accounts);
        } catch (error) {
          console.error("WalletAdapter: Error in getAccounts:", error);
          resolve(savedData.accounts); // Return accounts on error
        }
      }).finally(() => {
        checkingAccountPromise = null;
        hasCheckedLogout = true;
      });

      return await checkingAccountPromise;
    }

    console.debug("WalletAdapter: Accounts:", savedData.accounts);
    return savedData.accounts;
  }

  async sendTransactions({ transactions }: { transactions: Transaction[] }): Promise<WalletTxResult> {
    console.debug("WalletAdapter: sendTransactions", { transactions });
    const savedData = assertLoggedIn(); // Throws if not logged in
    const privateKey = savedData.key;
    const accountId = savedData.accounts[0].accountId;

    return new Promise(async (resolve, reject) => {
      const popup = window.open(`${this.#walletUrl}/send-transactions`, "_blank", POPUP_FEATURES);
      if (!popup) {
        return reject(new IntearAdapterError("Popup was blocked"));
      }

      let done = false;
      const listener = async (event: MessageEvent) => {
        if (event.origin !== new URL(this.#walletUrl).origin) return;
        if (!event.data || !event.data.type) return;

        console.debug("Message from send-transactions popup", event.data);
        switch (event.data.type) {
          case "ready": {
            const transactionsString = JSON.stringify(transactions);
            const nonce = Date.now();
            const signatureString = await generateAuthSignature(privateKey, transactionsString, nonce);
            const publicKey = publicKeyFromPrivate(privateKey);
            popup.postMessage(
              {
                type: "signAndSendTransactions",
                data: {
                  transactions: transactionsString,
                  accountId: accountId,
                  publicKey: publicKey,
                  nonce: nonce,
                  signature: signatureString,
                },
              },
              this.#walletUrl
            );
            break;
          }
          case "sent": {
            done = true;
            popup.close();
            window.removeEventListener("message", listener);
            resolve({ outcomes: event.data.outcomes });
            break;
          }
          case "error": {
            done = true;
            popup.close();
            window.removeEventListener("message", listener);
            reject(new IntearAdapterError(event.data.message || "Unknown error from send-transactions popup"));
            break;
          }
        }
      };

      window.addEventListener("message", listener);
      const checkPopupClosed = setInterval(() => {
        if (popup.closed) {
          window.removeEventListener("message", listener);
          clearInterval(checkPopupClosed);
          if (!done) {
            reject(new IntearAdapterError("Transaction canceled - popup closed by user"));
          }
        }
      }, 100);
    });
  }

  async signMessage({ message, nonce, recipient, callbackUrl, state }: { message: string, nonce: Buffer, recipient: string, callbackUrl?: string, state?: string }): Promise<SignatureResult> {
    console.debug("WalletAdapter: signMessage", { message, nonce, recipient });
    const savedData = assertLoggedIn();
    const privateKey = savedData.key;
    const accountId = savedData.accounts[0].accountId;

    return new Promise(async (resolve, reject) => {
      const popup = window.open(`${this.#walletUrl}/sign-message`, "_blank", POPUP_FEATURES);
      if (!popup) {
        return reject(new IntearAdapterError("Popup was blocked"));
      }

      let done = false;
      const listener = async (event: MessageEvent) => {
        if (event.origin !== new URL(this.#walletUrl).origin) return;
        if (!event.data || !event.data.type) return;

        console.debug("Message from sign-message popup", event.data);
        switch (event.data.type) {
          case "ready": {
            const signMessageString = JSON.stringify({
              message,
              recipient,
              nonce: Array.from(nonce),
              callbackUrl,
              state,
            });
            const authNonce = Date.now();
            const signatureString = await generateAuthSignature(privateKey, signMessageString, authNonce);
            const publicKey = publicKeyFromPrivate(privateKey);
            popup.postMessage(
              {
                type: "signMessage",
                data: {
                  message: signMessageString,
                  accountId: accountId,
                  publicKey: publicKey,
                  nonce: authNonce,
                  signature: signatureString,
                },
              },
              this.#walletUrl
            );
            break;
          }
          case "signed": {
            done = true;
            popup.close();
            window.removeEventListener("message", listener);
            const signatureData = event.data.signature;
            try {
              resolve({
                accountId: signatureData.accountId,
                publicKey: signatureData.publicKey,
                signature: signatureData.signature,
              });
            } catch (e) {
              reject(new IntearAdapterError("Failed to process signature from wallet", e));
            }
            break;
          }
          case "error": {
            done = true;
            popup.close();
            window.removeEventListener("message", listener);
            reject(new IntearAdapterError(event.data.message || "Unknown error from sign-message popup"));
            break;
          }
        }
      };

      window.addEventListener("message", listener);
      const checkPopupClosed = setInterval(() => {
        if (popup.closed) {
          window.removeEventListener("message", listener);
          clearInterval(checkPopupClosed);
          if (!done) {
            reject(new IntearAdapterError("Message signing canceled - popup closed by user"));
          }
        }
      }, 100);
    });
  }

  destroy() {
    console.debug("Intear Popup WalletAdapter destroyed.");
  }
}

export default WalletAdapter;
