#!/usr/bin/env node
// ============================================================
//  StandX x Decibel Hedge Volume Bot — CLI Entry
// ============================================================

import { startServer } from './server';

startServer().then((port) => {
  console.log(`Hedge Bot running at http://localhost:${port}`);
}).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
