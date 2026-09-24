/**
 * In-Memory Sliding-Window Rate Limiter
 *
 * Implements a strict sliding-window algorithm per identifier (IP, user ID, or API key).
 * Default quota: 30 requests per minute.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly storage: Map<string, number[]>;

  constructor(limit: number = 30, windowMs: number = 60 * 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.storage = new Map();
  }

  /**
   * Check if the request is permitted for the given identifier under the sliding window.
   */
  check(identifier: string, customLimit?: number): RateLimitResult {
    const now = Date.now();
    const effectiveLimit = typeof customLimit === 'number' && customLimit > 0 ? customLimit : this.limit;
    const windowStart = now - this.windowMs;

    const existingTimestamps = this.storage.get(identifier) || [];
    // Keep only timestamps that fall within the current sliding window
    const validTimestamps = existingTimestamps.filter((ts) => ts > windowStart);

    if (validTimestamps.length >= effectiveLimit) {
      const oldestTimestamp = validTimestamps[0] ?? now;
      const resetMs = Math.max(0, oldestTimestamp + this.windowMs - now);

      this.storage.set(identifier, validTimestamps);
      return {
        allowed: false,
        remaining: 0,
        resetMs,
      };
    }

    validTimestamps.push(now);
    this.storage.set(identifier, validTimestamps);

    const oldestTimestamp = validTimestamps[0] ?? now;
    const resetMs = Math.max(0, oldestTimestamp + this.windowMs - now);

    // Opportunistic prune if storage becomes very large
    if (this.storage.size > 5000) {
      this.cleanup(now);
    }

    return {
      allowed: true,
      remaining: Math.max(0, effectiveLimit - validTimestamps.length),
      resetMs,
    };
  }

  /**
   * Reset rate limit records for a single identifier or all identifiers.
   */
  reset(identifier?: string): void {
    if (identifier) {
      this.storage.delete(identifier);
    } else {
      this.storage.clear();
    }
  }

  /**
   * Remove expired timestamps across all keys to prevent unbounded memory growth.
   */
  cleanup(now: number = Date.now()): void {
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.storage.entries()) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        this.storage.delete(key);
      } else {
        this.storage.set(key, active);
      }
    }
  }
}

// Global default limiter: 30 requests / 60,000 ms
export const defaultRateLimiter = new RateLimiter(30, 60 * 1000);

/**
 * Convenience function to check rate limits using the default sliding-window limiter.
 */
export function checkRateLimit(
  identifier: string,
  customLimit?: number
): RateLimitResult {
  return defaultRateLimiter.check(identifier, customLimit);
}
