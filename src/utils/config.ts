// ============================================================
// Configuration — Interactive CLI Setup
// ============================================================
// Private keys are entered via interactive prompt (stdin).
// They are stored ONLY in the SecureVault (memory).
// They are NEVER saved to disk, logged, or transmitted.
// ============================================================

import * as readline from 'readline';
import { vault, safeLog } from './security';
import { HedgeConfig } from './types';

function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Prompt user for private keys interactively.
 * Keys go directly into SecureVault — never to disk.
 */
export async function promptCredentials(): Promise<void> {
  const rl = createRL();

  console.log('\n========================================');
  console.log('  🔐 Credential Setup');
  console.log('  Keys are stored IN MEMORY ONLY.');
  console.log('  They are NEVER saved to disk or sent anywhere.');
  console.log('========================================\n');

  // StandX — EVM Private Key
  const evmKey = await ask(rl, '  [StandX] EVM Private Key (0x...): ');
  vault.set('standx_evm_key', evmKey);
  console.log(`  ✓ StandX key loaded: ${vault.getMasked('standx_evm_key')}\n`);

  // Decibel — API Wallet
  const decibelKey = await ask(rl, '  [Decibel] API Wallet Private Key (0x...): ');
  vault.set('decibel_wallet_key', decibelKey);
  console.log(`  ✓ Decibel wallet key loaded: ${vault.getMasked('decibel_wallet_key')}`);

  const decibelAddr = await ask(rl, '  [Decibel] API Wallet Address (0x...): ');
  vault.set('decibel_wallet_addr', decibelAddr);

  const bearerToken = await ask(rl, '  [Decibel] Geomi Bearer Token: ');
  vault.set('decibel_bearer', bearerToken);

  const subaccount = await ask(rl, '  [Decibel] Trading Account Address (optional, Enter to skip): ');
  if (subaccount) vault.set('decibel_subaccount', subaccount);

  console.log('\n  ✓ All credentials loaded into memory.\n');
  rl.close();
}

/**
 * Prompt user for trading configuration.
 */
export async function promptConfig(): Promise<HedgeConfig> {
  const rl = createRL();

  console.log('========================================');
  console.log('  ⚙️  Trading Configuration');
  console.log('========================================\n');

  const symbol = (await ask(rl, '  Symbol [BTC]: ')) || 'BTC';

  const orderSize = await ask(rl, '  Order size (e.g. 0.001): ');
  if (!orderSize || isNaN(Number(orderSize))) {
    throw new Error('Invalid order size');
  }

  const leverageStr = (await ask(rl, '  Leverage [5]: ')) || '5';
  const leverage = parseInt(leverageStr, 10);

  const toleranceStr = (await ask(rl, '  Price tolerance in $ [1]: ')) || '1';
  const priceTolerance = parseFloat(toleranceStr);

  const initialSide = ((await ask(rl, '  StandX initial side (long/short) [long]: ')) || 'long') as 'long' | 'short';
  const initialLongExchange = initialSide === 'long' ? 'standx' : 'decibel';

  const walletMode = ((await ask(rl, '  Wallet mode (shared/separate) [separate]: ')) || 'separate') as 'shared' | 'separate';

  // Rotation
  const rotationMode = ((await ask(rl, '  Rotation mode (fixed/random) [random]: ')) || 'random') as 'fixed' | 'random';

  let rotationIntervalMs = 300000; // 5 min default
  let rotationRandomMinMs = 60000;  // 1 min
  let rotationRandomMaxMs = 600000; // 10 min

  if (rotationMode === 'fixed') {
    const intervalStr = (await ask(rl, '  Rotation interval in seconds (min 60) [300]: ')) || '300';
    rotationIntervalMs = Math.max(60, parseInt(intervalStr, 10)) * 1000;
  } else {
    const minStr = (await ask(rl, '  Random min interval in seconds (min 60) [60]: ')) || '60';
    const maxStr = (await ask(rl, '  Random max interval in seconds [600]: ')) || '600';
    rotationRandomMinMs = Math.max(60, parseInt(minStr, 10)) * 1000;
    rotationRandomMaxMs = Math.max(rotationRandomMinMs, parseInt(maxStr, 10)) * 1000;
  }

  rl.close();

  const config: HedgeConfig = {
    symbol,
    orderSize,
    leverage,
    priceTolerance,
    rotationMode,
    rotationIntervalMs,
    rotationRandomMinMs,
    rotationRandomMaxMs,
    initialLongExchange,
    walletMode,
  };

  console.log('\n  ✓ Configuration ready.\n');
  return config;
}
