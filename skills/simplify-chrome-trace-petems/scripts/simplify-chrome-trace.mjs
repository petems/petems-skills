#!/usr/bin/env node
// Summarise a Chrome DevTools performance trace. See ../references/spec.md.

const MIN_NODE_MAJOR = 22;
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE_MAJOR) {
  process.stderr.write(
    `simplify-chrome-trace: Node ${MIN_NODE_MAJOR} or newer is required (found ${process.versions.node}).\n`,
  );
  process.exit(1);
}

// Imported dynamically so the version check above runs first.
const { main } = await import('./lib/cli.mjs');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`simplify-chrome-trace: internal error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
