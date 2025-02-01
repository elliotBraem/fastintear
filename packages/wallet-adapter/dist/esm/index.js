/* ⋈ 🏃🏻💨 FastNEAR Wallet Adapter - ESM (@fastnear/wallet-adapter version 0.6.1) */
/* https://www.npmjs.com/package/@fastnear/wallet-adapter/v/0.6.1 */
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
class WalletAdapter {
  static {
    __name(this, "WalletAdapter");
  }
  /** @type {HTMLIFrameElement} */
  #iframe = null;
  /** @type {string} */
  #targetOrigin;
  /** @type {string} */
  #widgetUrl;
  /** @type {Map<string, Function>} */
  #pending = /* @__PURE__ */ new Map();
  /** @type {WalletState} */
  #state;
  /** @type {Function} */
  #onStateUpdate;
  /** @type {string} */
  #callbackUrl;
  /** @type {string} */
  static defaultWidgetUrl = "https://wallet-adapter.fastnear.com";
  /**
   * @param {WalletAdapterConfig} [config]
   */
  constructor({
    widgetUrl = WalletAdapter.defaultWidgetUrl,
    targetOrigin = "*",
    onStateUpdate,
    lastState,
    callbackUrl = window.location.href
  } = {}) {
    this.#targetOrigin = targetOrigin;
    this.#widgetUrl = widgetUrl;
    this.#onStateUpdate = onStateUpdate;
    this.#callbackUrl = callbackUrl;
    this.#state = lastState || {};
    window.addEventListener("message", this.#handleMessage.bind(this));
  }
  /**
   * Creates an iframe for wallet interaction
   * @param {string} path - Path to load in iframe
   * @returns {HTMLIFrameElement}
   */
  #createIframe(path) {
    if (this.#iframe) {
      this.#iframe.remove();
    }
    const url = new URL(path, this.#widgetUrl);
    console.log("aloha wa url", url);
    const iframe = document.createElement("iframe");
    iframe.src = url.toString();
    iframe.allow = "usb";
    iframe.style.border = "none";
    iframe.style.zIndex = "10000";
    iframe.style.position = "fixed";
    iframe.style.display = "block";
    iframe.style.top = "0";
    iframe.style.left = "0";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    document.body.appendChild(iframe);
    this.#iframe = iframe;
    return iframe;
  }
  /**
   * Handles messages from the wallet widget
   * @param {MessageEvent} event
   */
  #handleMessage(event) {
    if (this.#targetOrigin !== "*" && event.origin !== this.#targetOrigin) {
      return;
    }
    const { id, type, action, payload } = event.data;
    if (type !== "wallet-adapter") return;
    if (action === "close") {
      this.#iframe?.remove();
      this.#iframe = null;
      return;
    }
    if (payload?.state) {
      this.#state = { ...this.#state, ...payload.state };
      this.#onStateUpdate?.(this.#state);
    }
    const resolve = this.#pending.get(id);
    if (resolve) {
      this.#pending.delete(id);
      this.#iframe?.remove();
      this.#iframe = null;
      resolve(payload);
    }
  }
  /**
   * Sends a message to the wallet widget
   * @param {string} path - Path to load in iframe
   * @param {string} method - Method to call
   * @param {Object} params - Parameters to pass
   * @returns {Promise<any>}
   */
  async #sendMessage(path, method, params) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.#pending.set(id, resolve);
      const iframe = this.#createIframe(path);
      iframe.onload = () => {
        iframe.contentWindow?.postMessage(
          {
            type: "wallet-adapter",
            method,
            params: {
              id,
              ...params,
              state: this.#state,
              callbackUrl: params.callbackUrl || this.#callbackUrl
            }
          },
          this.#targetOrigin
        );
      };
    });
  }
  /**
   * Get current wallet state
   * @returns {WalletState}
   */
  getState() {
    return { ...this.#state };
  }
  /**
   * Set current wallet state
   * @param state
   */
  setState(state) {
    this.#state = state;
  }
  /**
   * Sign in with a NEAR wallet
   * @param {SignInConfig} config
   * @returns {Promise<SignInResult>}
   */
  async signIn(config) {
    return this.#sendMessage("/public/login.html", "signIn", config);
  }
  /**
   * Send a transaction using connected wallet
   * @param {TransactionConfig} config
   * @returns {Promise<TransactionResult>}
   */
  async sendTransactions(config) {
    return this.#sendMessage("/public/send.html", "sendTransactions", config);
  }
  /**
   * Clean up adapter resources
   */
  destroy() {
    window.removeEventListener("message", this.#handleMessage);
    this.#iframe?.remove();
    this.#iframe = null;
  }
}
export {
  WalletAdapter
};
//# sourceMappingURL=index.js.map