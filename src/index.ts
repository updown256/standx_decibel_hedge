#!/usr/bin/env node
// ============================================================
//  StandX x Decibel Hedge Volume Bot — Web GUI Entry
// ============================================================

import { startServer } from './server';

startServer().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
