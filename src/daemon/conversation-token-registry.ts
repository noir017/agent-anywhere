import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ConversationId } from '../types.js';

/**
 * Bidirectional registry of per-session stable token ↔ conversationId.
 *
 * Extracted from SessionRegistry: token bookkeeping is a separate concern (reverse-command auth +
 * locate) and shouldn't mix with session-lifecycle/turn-orchestration state in one class.
 *
 * Under the ACP resident process the token is fixed at spawn; reverse commands connect back with it and
 * resolve the current channel via token→session→activeChannel.
 */
export class SessionTokenRegistry {
  private bySession = new Map<ConversationId, string>();
  private byToken = new Map<string, ConversationId>();

  /** Get/build a session's stable token (fixed on first call; reused on later turns). */
  tokenFor(conversationId: ConversationId): string {
    let token = this.bySession.get(conversationId);
    if (!token) {
      token = `sess_${randomUUID()}`;
      this.bySession.set(conversationId, token);
      this.byToken.set(token, conversationId);
    }
    return token;
  }

  /**
   * Reverse-lookup conversationId by token (reverse-command entry); undefined if unregistered.
   *
   * Compares against each registered token in constant time (timingSafeEqual) rather than a plain
   * Map.get, so a timing side-channel can't reveal how many leading characters of a guessed token
   * are correct. Defense in depth — tokens are 122-bit random UUIDs and the socket is 0600 — but
   * cheap (the live-session set is small) and removes the foot-gun. Length is compared first
   * (timingSafeEqual requires equal length); leaking only the length is acceptable.
   */
  conversationFor(token: string): ConversationId | undefined {
    const probe = Buffer.from(token);
    for (const [known, sid] of this.byToken) {
      const candidate = Buffer.from(known);
      if (candidate.length === probe.length && timingSafeEqual(candidate, probe)) return sid;
    }
    return undefined;
  }

  /** Release a session's token registration (clear both directions). */
  release(conversationId: ConversationId): void {
    const token = this.bySession.get(conversationId);
    if (token) this.byToken.delete(token);
    this.bySession.delete(conversationId);
  }
}
