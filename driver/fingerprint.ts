/**
 * Deterministic fingerprint for eval run comparison.
 *
 * Produces a SHA-256 hash from the five components that define
 * a comparable run: task_id, task_version, rubric_version,
 * profile_id, and model. Two runs with the same fingerprint
 * are directly comparable for regression detection.
 *
 * Components are joined with a pipe delimiter before hashing.
 * This prevents collisions between values that contain
 * substrings of other values (e.g., "a|b" + "c" vs "a" + "b|c").
 */

import { createHash } from "node:crypto"

// ── Types ────────────────────────────────────────────────────

/** The five components that uniquely identify a comparable eval run. */
export interface FingerprintParts {
  task_id: string
  task_version: string
  rubric_version: string
  profile_id: string
  model: string
}

// ── Fingerprint function ─────────────────────────────────────

/**
 * Compute a SHA-256 fingerprint from the given parts.
 *
 * @param parts - The five components that define run comparability.
 * @returns Hex-encoded SHA-256 hash string (64 characters).
 */
export function fingerprint(parts: FingerprintParts): string {
  const input = [
    parts.task_id,
    parts.task_version,
    parts.rubric_version,
    parts.profile_id,
    parts.model,
  ].join("|")
  return createHash("sha256").update(input).digest("hex")
}
