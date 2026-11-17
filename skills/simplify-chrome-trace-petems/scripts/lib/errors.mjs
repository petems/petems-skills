// Error types that the CLI turns into clean one-line messages.

/** A problem with the input trace (exit code 1). */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.exitCode = 1;
  }
}

/** A problem with the command line (exit code 2). */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}
