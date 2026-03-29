# Security Audit Report — StandX x Decibel Hedge Bot

**Date**: 2026-03-28
**Auditor**: Security Engineer Agent
**Scope**: All files under `src/` (8 TypeScript modules), `package.json`, `tsconfig.json`, `.gitignore`
**Risk Context**: Production crypto trading bot handling real EVM and Aptos private keys

---

## Executive Summary

The codebase demonstrates above-average security awareness for a crypto trading bot. The vault pattern, key masking, signal-handler cleanup, and interactive CLI input are sound design decisions. However, I found **3 Critical**, **5 Warning**, and **6 Informational** issues that must be addressed before production use, especially before packaging as an EXE for distribution.

---

## Findings

### [C-01] CRITICAL — `safeLog` bypass: `...args` are NOT sanitized

**File**: `src/utils/security.ts:113-116`

```typescript
info: (msg: string, ...args: unknown[]) => console.log(sanitize(msg), ...args),
```

Only the first argument (`msg`) is sanitized. The rest (`...args`) pass through to `console.log` **raw**. If any caller ever passes a key as a secondary argument (e.g., `safeLog.info('connecting', someObject)` where `someObject` has a key field), it will be printed verbatim.

**Impact**: Private key leakage to stdout/stderr. In an EXE distribution, stdout may be redirected to a file or captured by a parent process.

**Remediation**:
```typescript
info: (msg: string, ...args: unknown[]) =>
  console.log(sanitize(msg), ...args.map(a =>
    typeof a === 'string' ? sanitize(a) : a
  )),
```
Also consider deep-sanitizing objects with `JSON.stringify` + `sanitize` for object arguments.

---

### [C-02] CRITICAL — Bearer token sent as WebSocket subprotocol (visible in network headers)

**File**: `src/clients/decibel.ts:457`

```typescript
this.ws = new WebSocket(this.wsUrl, [`decibel`, this.bearerToken], {
```

The `ws` library sends the second argument as the `Sec-WebSocket-Protocol` header. This header is:
1. **Logged by proxies, CDNs, and load balancers** (unlike `Authorization` which many systems redact)
2. **Visible in browser dev tools** if this ever runs in a browser context
3. **Not encrypted at the HTTP layer** before the TLS handshake completes
4. **Potentially cached** by intermediate HTTP infrastructure

**Impact**: Bearer token exposure in network infrastructure logs. If a proxy or WAF logs headers, the token is in plaintext.

**Remediation**: Send the bearer token as an `Authorization` header instead, or authenticate after the WebSocket connection is established:
```typescript
this.ws = new WebSocket(this.wsUrl, {
  headers: {
    'Origin': ORIGIN_HEADER,
    'Authorization': `Bearer ${this.bearerToken}`,
  },
});
// Then authenticate via a WS message after 'open'
```

---

### [C-03] CRITICAL — `evmKey` string remains in V8 heap after vault stores it

**File**: `src/utils/config.ts:40-41`

```typescript
const evmKey = await ask(rl, '  [StandX] EVM Private Key (0x...): ');
vault.set('standx_evm_key', evmKey);
```

The `evmKey` local variable is a JavaScript string. Strings in V8 are **immutable and cannot be zeroed**. Even after `vault.set()` converts it to a Buffer, the original string lives in the V8 heap until garbage collection. The same issue applies to all keys collected via `ask()` (lines 40, 45, 49, 52).

Additionally, in `vault.get()` (security.ts:47), a new string is created from the Buffer each time, and each returned string also persists in heap until GC.

**Impact**: In a memory dump (crash dump, core file, process memory read), the private keys are recoverable as strings even after `vault.wipe()`. For an EXE distributed to third parties, this is a real attack vector via tools like `strings` or process memory scanners.

**Remediation**:
- Minimize the window: set `evmKey` to `''` immediately after vault.set, though V8 may still retain the original
- Avoid `vault.get()` returning strings. Instead, provide sign-only methods on the vault that accept a callback operating directly on the Buffer:
```typescript
// vault.signWith(id, (keyBuf) => nacl.sign.detached(msg, keyBuf))
signWith<T>(id: string, fn: (key: Buffer) => T): T {
  const buf = this.store.get(id);
  if (!buf) throw new Error(`Key ${id} not found`);
  return fn(buf);
}
```
- For the ethers.Wallet: pass the key as a hex string once to create the wallet, then hold only the wallet object (which ethers manages internally)

---

### [W-01] WARNING — `getMasked()` leaks first 4 and last 4 characters of every key

**File**: `src/utils/security.ts:73-78`

```typescript
getMasked(id: string): string {
  // ...
  return str.slice(0, 4) + '...' + str.slice(-4);
}
```

For a 64-character hex private key, this reveals 8 hex characters (32 bits). While not enough to reconstruct the key, it:
1. Enables fingerprinting which key is in use
2. Provides a known-prefix/suffix for brute-force narrowing
3. Violates the principle that partial secrets are still secrets

**Impact**: Partial key disclosure. Low direct risk but violates defense-in-depth.

**Remediation**: Show only the first 4 characters + `****` or a fixed mask:
```typescript
return str.slice(0, 4) + '...****';
```

---

### [W-02] WARNING — `readline` echoes private key input to terminal

**File**: `src/utils/config.ts:13-18, 40`

The `readline.Interface` with `output: process.stdout` echoes all input characters. When the user types their private key, it appears in plaintext on the terminal. This is visible to:
1. Anyone looking at the screen (shoulder surfing)
2. Terminal recording software
3. Terminal scrollback buffers that may persist on disk

**Impact**: Key visible in terminal during entry.

**Remediation**: Use a library like `read` or implement raw stdin with echo disabled:
```typescript
import read from 'read';
const evmKey = await read({ prompt: '  [StandX] EVM Private Key: ', silent: true, replace: '*' });
```
Or set `process.stdin.setRawMode(true)` and manually handle input.

---

### [W-03] WARNING — No TLS certificate verification configuration

**Files**: `src/clients/standx.ts`, `src/clients/decibel.ts`

Neither client configures TLS certificate verification. While Node.js verifies certificates by default with `fetch()`, when packaged with `pkg`:
1. The bundled Node.js may have outdated CA certificates
2. `pkg` may not bundle the system CA store correctly
3. No certificate pinning is implemented for the exchange APIs

**Impact**: Potential MITM attack if the packaged binary has stale CAs or runs in an environment with a compromised CA store.

**Remediation**:
- Pin the TLS certificates for `api.standx.com`, `perps.standx.com`, and `api.mainnet.aptoslabs.com`
- Or at minimum, verify that `pkg` bundles current CA certificates
- Add a startup check that validates TLS connections before prompting for keys

---

### [W-04] WARNING — No input validation on private key format before use

**File**: `src/utils/config.ts:40-53`

Keys are passed directly to `vault.set()` without format validation. If a user pastes garbage, the error only surfaces when `ethers.Wallet(evmKey)` or `Ed25519PrivateKey(walletKey)` is called later. Worse, if the input is a very long string or contains control characters, it could cause unexpected behavior.

**Impact**: Poor UX and potential for unexpected errors mid-operation.

**Remediation**: Validate immediately after input:
```typescript
const evmKey = await ask(rl, '  [StandX] EVM Private Key (0x...): ');
if (!/^0x[a-fA-F0-9]{64}$/.test(evmKey)) {
  throw new Error('Invalid EVM private key format. Expected 0x + 64 hex characters.');
}
```

---

### [W-05] WARNING — `unhandledRejection` not caught — keys may survive in memory

**File**: `src/utils/security.ts:84-96`

The cleanup handler covers `exit`, `SIGINT`, `SIGTERM`, and `uncaughtException` but **not `unhandledRejection`**. An unhandled promise rejection (common in async WebSocket/fetch code) could crash the process without wiping keys.

**Impact**: Keys remain in process memory after crash, potentially in a core dump file.

**Remediation**:
```typescript
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  cleanup();
  process.exit(1);
});
```

---

### [I-01] INFO — Source maps enabled in production build

**File**: `tsconfig.json`

```json
"sourceMap": true,
"declarationMap": true
```

Source maps will be bundled into the `dist/` folder and potentially into the `pkg` binary. This gives anyone with the EXE access to the full original TypeScript source code.

**Remediation**: Disable source maps for production builds. Create a separate `tsconfig.prod.json`:
```json
{ "extends": "./tsconfig.json", "compilerOptions": { "sourceMap": false, "declarationMap": false, "declaration": false } }
```

---

### [I-02] INFO — `pkg` (v5.8.1) is deprecated and unmaintained

**File**: `package.json:30`

The `pkg` npm package by Vercel was **deprecated in September 2023** and has received no security patches since. Known issues:
1. It may not bundle Node.js security patches
2. The bundled Node 18 will be EOL
3. No support for newer Node.js versions

**Remediation**: Migrate to a maintained alternative:
- **`@yao-pkg/pkg`** (community fork, actively maintained)
- **`nexe`** (alternative single-executable bundler)
- **Node.js SEA** (Single Executable Applications, built into Node 20+)

---

### [I-03] INFO — `sanitize()` regex may produce false positives

**File**: `src/utils/security.ts:102-107`

The base58 regex `[123456789ABCDEF...]{44,}` will match any string of 44+ base58 characters, including:
- Transaction hashes
- Order IDs
- Aptos addresses
- Base64-encoded data

This may mask legitimate operational data in logs, making debugging difficult.

**Remediation**: Make the sanitize function smarter by only masking strings that match known key formats more precisely, or accept the over-masking as acceptable defense-in-depth.

---

### [I-04] INFO — Trade log CSV written to disk without encryption

**File**: `src/core/tracker.ts:79-99`

Trade history (timestamps, sizes, prices, order IDs) is written as plaintext CSV to `./logs/`. This is not a key exposure issue but:
1. Reveals trading strategy and position sizes
2. Could be used to front-run or replicate the strategy
3. On shared machines, other users can read the file

**Remediation**: Consider encrypting the CSV or restricting file permissions:
```typescript
fs.writeFileSync(csvPath, content, { encoding: 'utf-8', mode: 0o600 });
```

---

### [I-05] INFO — `ethers.Wallet` holds private key internally

**File**: `src/clients/standx.ts:50`

```typescript
const wallet = new ethers.Wallet(evmKey);
```

The `ethers.Wallet` object holds the private key internally for the lifetime of `connect()`. This is a local variable, so it's eligible for GC after `connect()` returns. However, ethers may keep internal references.

Since the wallet is only used to sign one message (the login challenge), this is acceptable. The key is not held long-term in StandX client state.

**Remediation**: No action required. The wallet object is scoped to `connect()` and will be GC'd. Document this as intentional.

---

### [I-06] INFO — No rate limiting or retry backoff on auth failures

**Files**: `src/clients/standx.ts:52-92`, `src/clients/decibel.ts:116-143`

Authentication failures throw immediately with no retry logic. An attacker who can cause transient auth failures (DNS poisoning, network disruption) could prevent the bot from operating. Conversely, if the bot retries auth too aggressively, it could trigger IP-based rate limiting.

**Remediation**: Implement exponential backoff for auth retries with a maximum attempt count.

---

## Dependency Assessment

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| `ethers` | ^6.13.0 | OK | Widely audited. No known critical CVEs in v6. |
| `tweetnacl` | ^1.0.3 | OK | Stable, audited. No dependencies. |
| `@aptos-labs/ts-sdk` | ^1.33.1 | REVIEW | Large dependency tree. Verify latest version. |
| `ws` | ^8.18.0 | OK | Well-maintained. Ensure >= 8.17.1 (CVE fixes). |
| `bs58` | ^5.0.0 | OK | No known issues. |
| `uuid` | ^10.0.0 | OK | Cryptographically random (uses crypto.getRandomValues). |
| `chalk` | ^4.1.2 | OK | Display only. |
| `inquirer` | ^8.2.6 | UNUSED | Listed in dependencies but not imported anywhere in src/. Remove. |
| `cli-table3` | ^0.6.5 | UNUSED | Listed in dependencies but not imported anywhere in src/. Remove. |
| `pkg` | ^5.8.1 | DEPRECATED | See I-02. Migrate to maintained alternative. |

**Action**: Remove unused dependencies (`inquirer`, `cli-table3`) to reduce attack surface. Run `npm audit` before every release.

---

## EXE Distribution Security (pkg)

Packaging with `pkg` introduces specific risks:

1. **Bundled Node.js version** — `node18` target means the binary ships with Node 18 internals, which reached EOL in April 2025. Security patches will not be applied.

2. **Source code extraction** — Source maps (I-01) plus `pkg`'s bundling format mean the JavaScript source can be extracted from the binary with tools like `pkg-unpack`.

3. **No code signing** — The EXE is unsigned. On Windows, SmartScreen will warn users. On macOS, Gatekeeper will block it. More importantly, users cannot verify the binary hasn't been tampered with.

4. **Memory forensics** — An EXE running on a user's machine is subject to memory scanning by malware, debugging tools, or other processes running as the same user or root.

**Remediation**:
- Sign the binary with a code signing certificate
- Target Node 20+ (LTS until April 2026)
- Publish SHA-256 checksums alongside each release
- Disable source maps in production
- Add anti-debugging checks (optional, defense-in-depth)
- Consider using Node.js SEA (built-in, no third-party bundler)

---

## Summary Table

| ID | Severity | Category | Title |
|----|----------|----------|-------|
| C-01 | **CRITICAL** | Key Exposure | `safeLog` rest args not sanitized |
| C-02 | **CRITICAL** | Network | Bearer token in WebSocket subprotocol header |
| C-03 | **CRITICAL** | Memory | String keys persist in V8 heap after vault.wipe() |
| W-01 | WARNING | Key Exposure | getMasked leaks first/last 4 chars |
| W-02 | WARNING | Key Exposure | readline echoes key input to terminal |
| W-03 | WARNING | Network | No TLS pinning / stale CAs in pkg |
| W-04 | WARNING | Input | No private key format validation |
| W-05 | WARNING | Process | unhandledRejection not caught |
| I-01 | INFO | Distribution | Source maps in production build |
| I-02 | INFO | Dependencies | pkg is deprecated |
| I-03 | INFO | Logging | Sanitize regex false positives |
| I-04 | INFO | Data | Trade logs written unencrypted |
| I-05 | INFO | Memory | ethers.Wallet holds key transiently |
| I-06 | INFO | Availability | No auth retry backoff |

---

## Priority Remediation Order

1. **Today**: C-01 (sanitize all safeLog args), C-02 (move bearer token out of subprotocol), W-05 (add unhandledRejection handler)
2. **This week**: W-02 (silent key input), W-04 (validate key format), I-01 (disable source maps), I-02 (replace pkg)
3. **Before distribution**: C-03 (minimize string key exposure), W-03 (TLS verification), code signing, unused dependency removal
