export const LsPrefix = "__fastnear_";

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

// Default: Use `localStorage` if available, otherwise an in-memory fallback
export const createDefaultStorage = (): StorageBackend =>
  typeof localStorage !== "undefined"
    ? localStorage
    : {
      getItem: (key) => memoryStore.get(key) || null,
      setItem: (key, value) => memoryStore.set(key, value),
      removeItem: (key) => memoryStore.delete(key),
      clear: () => memoryStore.clear(),
    };

export const memoryStore = new Map<string, string>(); // Internal memory storage

let storageBackend: StorageBackend = createDefaultStorage();

// Functional storage module
export const storage = {
  setBackend: (customBackend: StorageBackend) => {
    storageBackend = customBackend;
  },

  set: (key: string, value: any) => {
    if (value === null || value === undefined) {
      storageBackend.removeItem(LsPrefix + key);
    } else {
      storageBackend.setItem(LsPrefix + key, JSON.stringify(value));
    }
  },

  get: (key: string): any => {
    const value = storageBackend.getItem(LsPrefix + key);
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value; // Return raw string if not JSON
    }
  },

  remove: (key: string) => storageBackend.removeItem(key),
  clear: () => storageBackend.clear(),
};
