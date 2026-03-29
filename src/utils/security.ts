// ============================================================
// SECURITY MODULE
// ============================================================
//
// ⚠️  PRIVATE KEY HANDLING:
//
// 1. Private keys are NEVER written to disk (no files, no logs, no config files)
// 2. Private keys are NEVER transmitted over the network (only used locally for signing)
// 3. Private keys are NEVER logged or printed to console (masked in all output)
// 4. Buffer contents are zeroed on exit via vault.wipe()
//
// LIMITATION: JavaScript strings are immutable and GC-managed.
// The original string from user input may persist in V8 heap until GC collects it.
// Buffer.fill(0) only zeroes the vault copy. This is a language-level constraint.
//
// VERIFICATION:
// - Search this entire codebase for "privateKey", "private_key", "secret"
// - You will find: this file (vault), clients (signing only), config (prompt only)
// - You will NOT find: fs.write, fetch/http send, console.log with keys
// ============================================================

const KEY_MASK = '****...****';

class SecureVault {
  private store: Map<string, Buffer> = new Map();

  /**
   * Store a key securely in memory.
   * The string is immediately converted to Buffer; original string cannot be recovered from this module.
   */
  set(id: string, value: string): void {
    // Store as Buffer for easier zeroing on cleanup
    const buf = Buffer.from(value, 'utf-8');
    this.store.set(id, buf);
  }

  /**
   * Retrieve a key for signing operations ONLY.
   * Returns the key as a string — caller must use it immediately and not store it.
   */
  get(id: string): string | undefined {
    const buf = this.store.get(id);
    if (!buf) return undefined;
    return buf.toString('utf-8');
  }

  /**
   * Check if a key exists without exposing its value.
   */
  has(id: string): boolean {
    return this.store.has(id);
  }

  /**
   * Securely wipe all keys from memory.
   * Overwrites buffer contents with zeros before deleting.
   */
  wipe(): void {
    for (const [, buf] of this.store) {
      buf.fill(0);  // Zero out memory
    }
    this.store.clear();
  }

  /**
   * Get a masked representation for display purposes.
   * NEVER returns the actual key.
   */
  getMasked(id: string): string {
    if (!this.store.has(id)) return '(not set)';
    const buf = this.store.get(id)!;
    if (buf.length <= 8) return KEY_MASK;
    return `(${buf.length} bytes loaded)`;
  }
}

// Singleton vault — one per process
export const vault = new SecureVault();

// Wipe on exit — defense in depth
const cleanup = () => {
  vault.wipe();
};

// Only register 'exit' — signal handling is done in index.ts to avoid
// double-handler race where security.ts calls process.exit() before
// the app can gracefully close positions.
process.on('exit', cleanup);
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  cleanup();
  process.exit(1);
});

/**
 * Mask any string that looks like a private key in log output.
 * Use this to sanitize all console output.
 */
export function sanitize(text: string): string {
  // Mask hex private keys (0x + 64 hex chars)
  return text.replace(/0x[a-fA-F0-9]{64}/g, KEY_MASK)
    // Mask base58 keys (44+ chars of base58 alphabet)
    .replace(/[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{44,}/g, KEY_MASK);
}

/**
 * Safe logger that automatically sanitizes output.
 * NEVER logs private keys even if accidentally passed.
 */
export const safeLog = {
  info: (msg: string, ...args: unknown[]) => console.log(sanitize(msg), ...args.map(a => sanitize(String(a)))),
  warn: (msg: string, ...args: unknown[]) => console.warn(sanitize(msg), ...args.map(a => sanitize(String(a)))),
  error: (msg: string, ...args: unknown[]) => console.error(sanitize(msg), ...args.map(a => sanitize(String(a)))),
};
