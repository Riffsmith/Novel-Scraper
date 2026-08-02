// ─────────────────────────────────────────────────────────────────────────────
//  Error taxonomy for the scrape pipeline.
//  SecurityChallengeError is the one error type the queue inspects: a caught
//  challenge that never cleared triggers a 45 s backoff multiplier (v1
//  behaviour documented in queue/index.ts:20,159-167).  All other errors
//  get the normal retry × delayMax backoff.
// ─────────────────────────────────────────────────────────────────────────────

export class SecurityChallengeError extends Error {
  constructor(url: string) {
    super(`Security challenge did not clear: ${url}`);
    this.name = "SecurityChallengeError";
  }
}