import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { LocalizedError, msg } from "../../i18n/index.mjs";

/**
 * Where one model vendor's API key is kept: encrypted with the system keychain into a file, plain text only in memory.
 * The encryption key lives in the keychain and belongs to this app, so the file can't be decrypted on another machine or by another user.
 *
 * @param {object} options
 * @param {string} options.file the ciphertext file path
 * @param {{ isEncryptionAvailable(): boolean, encryptString(text: string): Buffer, decryptString(data: Buffer): string }} options.safeStorage
 *   Electron's safeStorage; a fake in tests
 */
export function createKeyStore({ file, safeStorage }) {
  return {
    /** @returns {string | null} null when nothing was saved. Throws when the ciphertext can't be decrypted (the keychain key is gone, say) */
    load() {
      if (!existsSync(file)) return null;
      return safeStorage.decryptString(readFileSync(file));
    },

    save(key) {
      // Without the keychain Electron falls back to a fixed key on some platforms, which is as good as plain text, so refuse
      if (!safeStorage.isEncryptionAvailable()) throw new LocalizedError(msg("key.keychainUnavailable"));
      // Delete then write: mode only applies to new files, and overwriting keeps the old permissions
      rmSync(file, { force: true });
      writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
    },

    clear() {
      rmSync(file, { force: true });
    },

    /** Whether a key was saved. Only checks whether the file exists, without decrypting */
    exists() {
      return existsSync(file);
    },
  };
}
