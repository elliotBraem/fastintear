import { defineConfig } from 'tsup'
/* @ts-ignore */
// we'll get this package's name and version for the banner
import pkg from './package.json'

const globalName = 'near'

const footerRedefiningGlobal = `
// Check URL parameters for safety mode
const urlParams = new URLSearchParams(window.location.search);
const useMemory = urlParams.has('memory') || urlParams.has('safe');

// Create global near client with appropriate state management
const globalNearClient = near.createNearClient({ 
  networkId: "mainnet",
  isolateState: useMemory // Safety mode if ?memory or ?safe in URL
});

// Create global near object
const globalNear = {
  // Core methods
  config: globalNearClient.config,
  requestSignIn: globalNearClient.requestSignIn,
  signOut: globalNearClient.signOut,
  sendTx: globalNearClient.sendTx,
  signMessage: globalNearClient.signMessage,
  view: globalNearClient.view,
  queryAccount: globalNearClient.queryAccount,
  queryBlock: globalNearClient.queryBlock,
  queryAccessKey: globalNearClient.queryAccessKey,
  queryTx: globalNearClient.queryTx,
  localTxHistory: globalNearClient.localTxHistory,
  sendRpc: globalNearClient.sendRpc,
  
  // State accessors
  accountId: globalNearClient.accountId,
  publicKey: globalNearClient.publicKey,
  authStatus: globalNearClient.authStatus,
  selected: globalNearClient.selected,
  
  // Action helpers
  actions: globalNearClient.actions,
  
  // Utils and exports
  utils: globalNearClient.utils,
  exp: globalNearClient.exp,
  
  // Event system
  event: {
    onAccount: (callback) => globalNearClient.subscribe((state) => {
      if (state.accountId) callback(state.accountId);
    }),
    onTx: (callback) => globalNearClient.onTx(callback),
    offAccount: () => {}, // Legacy compatibility
    offTx: () => {} // Legacy compatibility
  },
  
  // Client creation function
  createNearClient: near.createNearClient
};

try {
  Object.defineProperty(globalThis, '${globalName}', {
    value: globalNear,    
    enumerable: true,
    configurable: false,
  });
} catch (error) {
  console.error('Could not define global "near" object', error);
  throw error;
}

// Convenience utility
window.$$ = globalNear.utils.convertUnit;

if (useMemory) {
  console.log('🔒 FastINTEAR: Safe mode (memory-only state)');
} else {
  console.log('💾 FastINTEAR: Persistent mode (localStorage)');
  console.log('💡 Use ?memory for safe mode');
}
`;

export default defineConfig([
  // 1) CommonJS (CJS) build (unbundled)
  {
    entry: ['src/**/*.ts'],
    outDir: 'dist/cjs',
    format: ['cjs'],
    bundle: false,
    splitting: false,
    clean: true,
    keepNames: true,
    dts: false,
    sourcemap: true,
    minify: false,
    treeshake: true,
    banner: {
      js: `/* ⋈ 🏃🏻💨 FastNEAR API - CJS (${pkg.name} version ${pkg.version}) */\n` +
        `/* https://www.npmjs.com/package/${pkg.name}/v/${pkg.version} */`,
    },
    esbuildOptions(options) {
      options.keepNames = true;
      options.treeShaking = true;
    },
  },

  // 2) ESM build (unbundled)
  {
    entry: ['src/**/*.ts'],
    outDir: 'dist/esm',
    format: ['esm'],
    shims: true,
    bundle: false,
    splitting: false,
    clean: true,
    keepNames: true,
    outExtension: ({ format }) => ({
      js: '.js',
    }),
    dts: {
      resolve: true,
      entry: 'src/index.ts',
    },
    sourcemap: true,
    minify: false,
    treeshake: true,
    banner: {
      js: `/* ⋈ 🏃🏻💨 FastNEAR API - ESM (${pkg.name} version ${pkg.version}) */\n` +
        `/* https://www.npmjs.com/package/${pkg.name}/v/${pkg.version} */`,
    },
    esbuildOptions(options) {
      options.keepNames = true;
      options.treeShaking = true;
    },
  },

  // 3) IIFE/UMD build with minimal SES lockdown & hardened globalThis.near
  {
    entry: {
      browser: 'src/index.ts',
    },
    outDir: 'dist/umd',
    format: ['iife'],
    globalName,
    bundle: true,
    splitting: false,
    clean: true,
    keepNames: true,
    dts: false,
    sourcemap: true,
    minify: false,
    platform: 'browser',
    banner: {
      js: `/* ⋈ 🏃🏻💨 FastNEAR API - IIFE/UMD (${pkg.name} version ${pkg.version}) */\n` +
        `/* https://www.npmjs.com/package/${pkg.name}/v/${pkg.version} */`,
    },
    footer: {
      js: footerRedefiningGlobal,
    },
  },
])
