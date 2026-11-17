#!/usr/bin/env node
// Summarise a Chrome DevTools performance trace. See ../references/spec.md.
import { main } from './lib/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`simplify-chrome-trace: internal error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
