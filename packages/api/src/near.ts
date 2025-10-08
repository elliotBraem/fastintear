import {
  bytesToBase64,
  canSignWithLAK,
  fromBase64,
  lsGet,
  lsSet,
  parseJsonFromBytes,
  PlainTransaction,
  privateKeyFromRandom,
  serializeSignedTransaction,
  serializeTransaction,
  signHash,
  toBase58,
  toBase64,
  tryParseJson
} from "./utils";
import Big from "big.js";

import {
  NETWORKS,
  DEFAULT_NETWORK_ID,
  LocalStorageStateManager,
  TxHistoryManager,
  type NetworkConfig,
  type WalletState,
  type TxStatus,
} from "./state.js";
import { WalletAdapter } from "./intear.js";
import type { SignInError } from "./intear.js";

// Global state managers
let globalStateManager = new LocalStorageStateManager();
let globalTxHistoryManager = new TxHistoryManager();
let globalAdapter: WalletAdapter;

// Initialize global adapter
const initializeGlobalAdapter = () => {
  if (!globalAdapter) {
    globalAdapter = new WalletAdapter({
      onStateUpdate: async (adapterState: any) => {
        const { accountId, lastWalletId, privateKey, publicKey } = adapterState;
        const currentState = await globalStateManager.getState();
        
        if (accountId !== currentState?.accountId) {
          const newState: WalletState = {
            accountId: accountId || null,
            publicKey: publicKey || null,
            privateKey: privateKey || null,
            networkId: currentState?.networkId || DEFAULT_NETWORK_ID,
            lastWalletId: lastWalletId || null,
            accessKeyContractId: currentState?.accessKeyContractId || null,
          };
          
          await globalStateManager.setState(newState);
        }
      },
      walletUrl: "https://wallet.intear.tech",
    });
  }
  return globalAdapter;
};

// Action types
export interface CreateAccountAction {
  type: "CreateAccount";
}

export interface DeployContractAction {
  type: "DeployContract";
  params: {
    code: Uint8Array;
  };
}

export interface FunctionCallAction {
  type: "FunctionCall";
  params: {
    methodName: string;
    args: object;
    gas: string;
    deposit: string;
  };
}

export interface TransferAction {
  type: "Transfer";
  params: {
    deposit: string;
  };
}

export interface StakeAction {
  type: "Stake";
  params: {
    stake: string;
    publicKey: string;
  };
}

export type AddKeyPermission =
  | "FullAccess"
  | {
    receiverId: string;
    allowance?: string;
    methodNames?: Array<string>;
  };

export interface AddKeyAction {
  type: "AddKey";
  params: {
    publicKey: string;
    accessKey: {
      nonce?: number;
      permission: AddKeyPermission;
    };
  };
}

export interface DeleteKeyAction {
  type: "DeleteKey";
  params: {
    publicKey: string;
  };
}

export interface DeleteAccountAction {
  type: "DeleteAccount";
  params: {
    beneficiaryId: string;
  };
}

export interface SignedDelegateAction {
  type: "SignedDelegate";
  params: {
    delegateAction: Action;
    signature: string;
  };
}

export type Action =
  | CreateAccountAction
  | DeployContractAction
  | FunctionCallAction
  | TransferAction
  | StakeAction
  | AddKeyAction
  | DeleteKeyAction
  | DeleteAccountAction
  | SignedDelegateAction;

export type ActionType = Action["type"];

export interface Transaction {
  signerId: string;
  receiverId: string;
  actions: Array<Action>;
}

import * as reExportAllUtils from "./utils";
import { sha256 } from "@noble/hashes/sha2.js";

Big.DP = 27;
export const MaxBlockDelayMs = 1000 * 60 * 60 * 6; // 6 hours

export interface AccessKeyWithError {
  result: {
    nonce: number;
    permission?: any;
    error?: string;
  }
}

export interface WalletTxResult {
  url?: string;
  outcomes?: Array<Map<string, any>>;
  rejected?: boolean;
  error?: string;
}

export interface BlockView {
  result: {
    header: {
      hash: string;
      timestamp_nanosec: string;
    }
  }
}

export interface LastKnownBlock {
  header: {
    hash: string;
    timestamp_nanosec: string;
  }
}

export function withBlockId(params: Record<string, any>, blockId?: string) {
  if (blockId === "final" || blockId === "optimistic") {
    return { ...params, finality: blockId };
  }
  return blockId ? { ...params, block_id: blockId } : { ...params, finality: "optimistic" };
}

// Global config state
let globalConfig: NetworkConfig = {
  ...NETWORKS[DEFAULT_NETWORK_ID],
  networkId: DEFAULT_NETWORK_ID,
};

export async function sendRpc(method: string, params: Record<string, any> | any[]) {
  if (!globalConfig?.nodeUrl) {
    throw new Error("fastnear: getConfig() returned invalid config: missing nodeUrl.");
  }
  const response = await fetch(globalConfig.nodeUrl, {
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
}

export function afterTxSent(txId: string) {
  const txHistory = globalTxHistoryManager.getHistory();
  sendRpc("tx", {
    tx_hash: txHistory[txId]?.txHash,
    sender_account_id: txHistory[txId]?.tx?.signerId,
    wait_until: "EXECUTED_OPTIMISTIC",
  })
    .then(result => {
      const successValue = result?.result?.status?.SuccessValue;
      globalTxHistoryManager.updateTx({
        txId,
        status: "Executed",
        result,
        successValue: successValue ? tryParseJson(fromBase64(successValue)) : undefined,
        finalState: true,
      });
    })
    .catch((error) => {
      globalTxHistoryManager.updateTx({
        txId,
        status: "ErrorAfterIncluded",
        error: tryParseJson(error.message) ?? error.message,
        finalState: true,
      });
    });
}

export async function sendTxToRpc(signedTxBase64: string, waitUntil: string | undefined, txId: string) {
  waitUntil = waitUntil || "INCLUDED";

  try {
    const sendTxRes = await sendRpc("send_tx", {
      signed_tx_base64: signedTxBase64,
      wait_until: waitUntil,
    });

    globalTxHistoryManager.updateTx({ txId, status: "Included", finalState: false });
    afterTxSent(txId);

    return sendTxRes;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    globalTxHistoryManager.updateTx({
      txId,
      status: "Error",
      error: tryParseJson(errorMessage) ?? errorMessage,
      finalState: false,
    });
    throw new Error(errorMessage);
  }
}

export interface AccessKeyView {
  nonce: number;
  permission: any;
}

export function generateTxId(): string {
  const randomPart = crypto.getRandomValues(new Uint32Array(2)).join("");
  return `tx-${Date.now()}-${parseInt(randomPart, 10).toString(36)}`;
}

// Global config management
export const config = (newConfig?: Partial<NetworkConfig>): NetworkConfig => {
  if (newConfig) {
    if (newConfig.networkId && globalConfig.networkId !== newConfig.networkId) {
      globalConfig = { ...NETWORKS[newConfig.networkId], networkId: newConfig.networkId };
      globalStateManager = new LocalStorageStateManager(newConfig.networkId);
      globalTxHistoryManager = new TxHistoryManager();
      lsSet("block", null);
    }
    globalConfig = { ...globalConfig, ...newConfig };
  }
  return globalConfig;
};

export interface SignInParams {
  contractId?: string;
  methodNames?: string[];
}

export interface SignInCallbacks {
  onSuccess?: (result: {
    accountId: string;
    publicKey: string;
    networkId: string;
    contractId?: string;
    methodNames?: string[];
    accounts: Account[];
    isReconnection: boolean;
  }) => void;
  onError?: (error: SignInError) => void;
  timeout?: number;
}

export const requestSignIn = async (
  params: SignInParams = {},
  callbacks: SignInCallbacks = {}
) => {
  const { contractId, methodNames } = params;
  const { onSuccess, onError, timeout = 60000 } = callbacks;
  const networkId = globalConfig.networkId;

  // Check if this is a reconnection
  const previousAccountId = lsGet('lastSignedInAccount') as string | null;
  const currentState = await globalStateManager.getState();
  const isReconnection = !!previousAccountId && previousAccountId !== currentState?.accountId;

  const privateKey = privateKeyFromRandom();
  
  // Update state with new private key and contract info
  const newState: WalletState = {
    ...currentState,
    privateKey,
    accessKeyContractId: contractId || null,
    networkId,
    accountId: currentState?.accountId || null,
    publicKey: currentState?.publicKey || null,
    lastWalletId: currentState?.lastWalletId || null,
  };
  await globalStateManager.setState(newState);

  try {
    const adapter = initializeGlobalAdapter();
    const result = await adapter.signIn({
      networkId,
      contractId,
      methodNames,
      callbacks: {
        onError: onError ? (error) => {
          onError(error);
        } : undefined,
        timeout,
      },
    });

    if (result.error) {
      const error: SignInError = {
        type: 'wallet_error',
        message: result.error,
        retryable: true,
        suggestedAction: 'contact_support',
        originalError: result.error,
        timestamp: Date.now(),
      };

      onError?.(error);
      throw new Error(`Wallet error: ${result.error}`);
    }

    if (result.accountId) {
      // Store for reconnection detection
      lsSet('lastSignedInAccount', result.accountId);
      
      const finalState: WalletState = {
        accountId: result.accountId,
        privateKey: result.privateKey || privateKey,
        publicKey: result.publicKey || null,
        networkId,
        lastWalletId: null,
        accessKeyContractId: contractId || null,
      };
      
      await globalStateManager.setState(finalState);

      const successResult = {
        accountId: result.accountId,
        publicKey: result.publicKey!,
        networkId,
        contractId,
        methodNames,
        accounts: result.accounts || [{ accountId: result.accountId, publicKey: result.publicKey }],
        isReconnection,
      };

      onSuccess?.(successResult);
      return successResult;
    } else {
      console.warn("@fastnear: signIn resolved without accountId or error.");
      await globalStateManager.clearState();

      const error: SignInError = {
        type: 'unknown',
        message: 'Sign-in completed but no account information was returned',
        retryable: true,
        suggestedAction: 'retry',
        originalError: null,
        timestamp: Date.now(),
      };

      onError?.(error);
      throw new Error('Sign-in completed but no account information was returned');
    }
  } catch (err) {
    const error: SignInError = {
      type: 'unknown',
      message: err instanceof Error ? err.message : 'Unknown error occurred',
      retryable: true,
      suggestedAction: 'contact_support',
      originalError: err,
      timestamp: Date.now(),
    };

    onError?.(error);
    throw err;
  }
};

export const view = async ({
  contractId,
  methodName,
  args,
  argsBase64,
  blockId,
}: {
  contractId: string;
  methodName: string;
  args?: any;
  argsBase64?: string;
  blockId?: string;
}) => {
  const encodedArgs = argsBase64 || (args ? toBase64(JSON.stringify(args)) : "");
  const queryResult = await sendRpc(
    "query",
    withBlockId(
      {
        request_type: "call_function",
        account_id: contractId,
        method_name: methodName,
        args_base64: encodedArgs,
      },
      blockId
    )
  );

  return parseJsonFromBytes(queryResult.result.result);
};

export const queryAccount = async ({
  accountId,
  blockId,
}: {
  accountId: string;
  blockId?: string;
}) => {
  return sendRpc(
    "query",
    withBlockId({ request_type: "view_account", account_id: accountId }, blockId)
  );
};

export const queryBlock = async ({ blockId }: { blockId?: string }): Promise<BlockView> => {
  return sendRpc("block", withBlockId({}, blockId));
};

export const queryAccessKey = async ({
  accountId,
  publicKey,
  blockId,
}: {
  accountId: string;
  publicKey: string;
  blockId?: string;
}): Promise<AccessKeyWithError> => {
  return sendRpc(
    "query",
    withBlockId(
      { request_type: "view_access_key", account_id: accountId, public_key: publicKey },
      blockId
    )
  );
};

export const queryTx = async ({ txHash, accountId }: { txHash: string; accountId: string }) => {
  return sendRpc("tx", [txHash, accountId]);
};

export const localTxHistory = () => {
  return globalTxHistoryManager.getHistory();
};

export const signOut = async () => {
  const adapter = initializeGlobalAdapter();
  await adapter.signOut();
  await globalStateManager.clearState();
};

export interface SignatureResult {
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface Account {
  accountId: string;
  publicKey?: string;
  active?: boolean;
}

export const signMessage = async ({
  message,
  recipient,
  nonce,
  callbackUrl,
  state,
}: {
  message: string;
  recipient: string;
  nonce?: Uint8Array;
  callbackUrl?: string;
  state?: string;
}): Promise<SignatureResult> => {
  const currentState = await globalStateManager.getState();
  const signerId = currentState?.accountId;
  if (!signerId) throw new Error("Must sign in");

  const messageNonce = nonce || crypto.getRandomValues(new Uint8Array(32));

  try {
    const adapter = initializeGlobalAdapter();
    const result = await adapter.signMessage({
      message,
      recipient,
      nonce: messageNonce as any,
      callbackUrl,
      state,
    });

    return {
      accountId: result.accountId,
      publicKey: result.publicKey,
      signature: result.signature
    };
  } catch (err) {
    console.error('fastnear: error signing message using adapter:', err);
    throw err;
  }
};

export const sendTx = async ({
  receiverId,
  actions,
  waitUntil,
}: {
  receiverId: string;
  actions: Action[];
  waitUntil?: string;
}) => {
  const currentState = await globalStateManager.getState();
  const signerId = currentState?.accountId;
  if (!signerId) throw new Error("Must sign in");

  const publicKeyValue = currentState?.publicKey ?? "";
  const privKey = currentState?.privateKey;
  const txId = generateTxId();

  if (!privKey || receiverId !== currentState?.accessKeyContractId || !canSignWithLAK(actions) || hasNonZeroDeposit(actions)) {
    const jsonTx = { signerId, receiverId, actions };
    globalTxHistoryManager.updateTx({ status: "Pending", txId, tx: jsonTx, finalState: false });

    try {
      const adapter = initializeGlobalAdapter();
      const result = await adapter.sendTransactions({
        transactions: [jsonTx],
      });

      if (result.outcomes?.length) {
        result.outcomes.forEach((r) => {
          const transactionEntry = r.get("transaction");
          globalTxHistoryManager.updateTx({
            txId,
            status: "Executed",
            result: r,
            txHash: transactionEntry?.hash,
            finalState: true,
          });
        });
      } else if (result.rejected) {
        globalTxHistoryManager.updateTx({ txId, status: "RejectedByUser", finalState: true });
      } else if (result.error) {
        globalTxHistoryManager.updateTx({
          txId,
          status: "Error",
          error: tryParseJson(result.error),
          finalState: true,
        });
      }

      return result;
    } catch (err) {
      console.error('fastnear: error sending tx using adapter:', err)
      globalTxHistoryManager.updateTx({
        txId,
        status: "Error",
        error: tryParseJson((err as Error).message),
        finalState: true,
      });

      return Promise.reject(err);
    }
  }

  let nonce = lsGet("nonce") as number | null;
  if (nonce == null) {
    const accessKey = await queryAccessKey({ accountId: signerId, publicKey: publicKeyValue });
    if (accessKey.result.error) {
      throw new Error(`Access key error: ${accessKey.result.error} when attempting to get nonce for ${signerId} for public key ${publicKeyValue}`);
    }
    nonce = accessKey.result.nonce;
    lsSet("nonce", nonce);
  }

  let lastKnownBlock = lsGet("block") as LastKnownBlock | null;
  if (
    !lastKnownBlock ||
    parseFloat(lastKnownBlock.header.timestamp_nanosec) / 1e6 + MaxBlockDelayMs < Date.now()
  ) {
    const latestBlock = await queryBlock({ blockId: "final" });
    lastKnownBlock = {
      header: {
        hash: latestBlock.result.header.hash,
        timestamp_nanosec: latestBlock.result.header.timestamp_nanosec,
      },
    };
    lsSet("block", lastKnownBlock);
  }

  nonce += 1;
  lsSet("nonce", nonce);

  const blockHash = lastKnownBlock.header.hash;

  const plainTransactionObj: PlainTransaction = {
    signerId,
    publicKey: publicKeyValue,
    nonce,
    receiverId,
    blockHash,
    actions,
  };

  const txBytes = serializeTransaction(plainTransactionObj);
  const txHashBytes = sha256(txBytes);
  const txHash58 = toBase58(txHashBytes);

  const signatureBase58 = signHash(txHashBytes, privKey, { returnBase58: true }) as string;
  const signedTransactionBytes = serializeSignedTransaction(plainTransactionObj, signatureBase58);
  const signedTxBase64 = bytesToBase64(signedTransactionBytes);

  globalTxHistoryManager.updateTx({
    status: "Pending",
    txId,
    tx: plainTransactionObj,
    signature: signatureBase58,
    signedTxBase64,
    txHash: txHash58,
    finalState: false,
  });

  try {
    return await sendTxToRpc(signedTxBase64, waitUntil, txId);
  } catch (error) {
    console.error("Error Sending Transaction:", error, plainTransactionObj, signedTxBase64);
  }
};

function hasNonZeroDeposit(actions: Action[]): boolean {
  for (const action of actions) {
    if (action.type === "FunctionCall" || action.type === "Transfer") {
      if (action.params.deposit && action.params.deposit !== "0") {
        return true;
      }
    }
  }
  return false;
}

// exports
export const exp = {
  utils: {},
  borsh: reExportAllUtils.exp.borsh,
};

for (const key in reExportAllUtils) {
  exp.utils[key] = reExportAllUtils[key];
}

export const utils = exp.utils;

// Action helpers
export const actions = {
  functionCall: ({
    methodName,
    gas,
    deposit,
    args,
    argsBase64,
  }: {
    methodName: string;
    gas?: string;
    deposit?: string;
    args?: Record<string, any>;
    argsBase64?: string;
  }): FunctionCallAction => {
    let finalArgs: object = args || {};
    if (!args && argsBase64) {
      try {
        const decoded = fromBase64(argsBase64);
        if (typeof decoded !== 'object' || decoded === null || !(decoded as unknown instanceof Uint8Array)) {
          throw new Error(
            "Failed to decode base64 contract code, or the result was not a valid Uint8Array."
          );
        }
        finalArgs = JSON.parse(new TextDecoder().decode(decoded));
      } catch (e) {
        console.error("Failed to decode or parse argsBase64:", e);
        throw new Error("Invalid argsBase64 provided for functionCall");
      }
    }

    return {
      type: "FunctionCall",
      params: {
        methodName,
        args: finalArgs,
        gas: gas || "30000000000000",
        deposit: deposit || "0",
      },
    };
  },

  transfer: (yoctoAmount: string): TransferAction => ({
    type: "Transfer",
    params: {
      deposit: yoctoAmount,
    },
  }),

  stake: ({ amount, publicKey }: { amount: string; publicKey: string }): StakeAction => ({
    type: "Stake",
    params: {
      stake: amount,
      publicKey,
    },
  }),

  addFullAccessKey: ({ publicKey }: { publicKey: string }): AddKeyAction => ({
    type: "AddKey",
    params: {
      publicKey: publicKey,
      accessKey: { permission: "FullAccess" },
    },
  }),

  addLimitedAccessKey: ({
    publicKey,
    allowance,
    accountId,
    methodNames,
  }: {
    publicKey: string;
    allowance: string;
    accountId: string;
    methodNames: string[];
  }): AddKeyAction => ({
    type: "AddKey",
    params: {
      publicKey: publicKey,
      accessKey: {
        permission: {
          receiverId: accountId,
          allowance: allowance,
          methodNames: methodNames,
        },
      },
    },
  }),

  deleteKey: ({ publicKey }: { publicKey: string }): DeleteKeyAction => ({
    type: "DeleteKey",
    params: {
      publicKey,
    },
  }),

  deleteAccount: ({ beneficiaryId }: { beneficiaryId: string }): DeleteAccountAction => ({
    type: "DeleteAccount",
    params: {
      beneficiaryId,
    },
  }),

  createAccount: (): CreateAccountAction => ({
    type: "CreateAccount",
  }),

  deployContract: ({ codeBase64 }: { codeBase64: string }): DeployContractAction => {
    const codeBytes = fromBase64(codeBase64);
    if (typeof codeBytes !== 'object' || codeBytes === null || !(codeBytes as unknown instanceof Uint8Array)) {
      throw new Error(
        "Failed to decode base64 contract code, or the result was not a valid Uint8Array."
      );
    }
    return {
      type: "DeployContract",
      params: {
        code: codeBytes,
      },
    };
  },
};
