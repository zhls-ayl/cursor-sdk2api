import type { AuthContext } from "../auth/credentials.js";
import { cursorAgentTurnFromParsed, ordinaryReplayKey, type CursorAgentTurn } from "../core/cursor-agent-turn.js";
import type { OrdinaryTurnJournal } from "../core/ordinary-turn-journal.js";
import { decideOrdinaryTurn } from "../core/ordinary-turn.js";
import type { RuntimeProfile } from "../core/runtime-profile.js";
import { sessionConflict } from "../errors.js";
import type { ParsedMessages } from "../protocols/anthropic/types.js";

interface Candidate {
  auth: AuthContext;
  profile: RuntimeProfile;
}

/** Only authenticated managed requests share this process-local routing table.
 * It bridges account selection to the coordinator's journal claim; execution,
 * singleflight and replay remain exclusively owned by RunCoordinator.
 */
export class OrdinaryAccountRouting {
  private readonly claims = new Map<string, { fingerprint: string; users: number }>();

  constructor(private readonly journal: OrdinaryTurnJournal) {}

  forRequest(parsed: ParsedMessages) {
    // This cache lives only through account selection. Long-lived claims below
    // retain digests and fingerprints, never the parsed request or base turns.
    const turns = new Map<RuntimeProfile, CursorAgentTurn>();
    return {
      findOwner: (candidates: Candidate[]) => this.findOwner(parsed, candidates, turns),
      claim: (candidate: Candidate) => this.claim(parsed, candidate, turns),
    };
  }

  private baseTurn(parsed: ParsedMessages, profile: RuntimeProfile, turns: Map<RuntimeProfile, CursorAgentTurn>): CursorAgentTurn {
    let turn = turns.get(profile);
    if (!turn) {
      turn = cursorAgentTurnFromParsed(parsed, { tenantScope: "", runtimeProfile: profile });
      turns.set(profile, turn);
    }
    return turn;
  }

  private findOwner(parsed: ParsedMessages, candidates: Candidate[], turns: Map<RuntimeProfile, CursorAgentTurn>): AuthContext | undefined {
    const matches = new Map<string, AuthContext>();
    let matchRank = 0;
    const match = (auth: AuthContext, rank: number) => {
      if (rank > matchRank) {
        matches.clear();
        matchRank = rank;
      }
      if (rank === matchRank) matches.set(auth.fingerprint, auth);
    };
    for (const { auth, profile } of candidates) {
      // Hash the transcript once per profile, independently of pool size.
      const baseTurn = this.baseTurn(parsed, profile, turns);
      const claim = this.claims.get(ordinaryReplayKey(baseTurn));
      if (claim?.fingerprint === auth.fingerprint) match(auth, 3);
      const turn = { ...baseTurn, tenantScope: auth.fingerprint };
      const decision = decideOrdinaryTurn({
        turn,
        journal: this.journal,
        inflight: new Set(),
        now: this.journal.now(),
        enabled: true,
        hasReplay: false,
      });
      if (
        (decision.action === "resume" || decision.action === "singleflight" || decision.action === "fail_closed") &&
        decision.record?.credentialFingerprint === auth.fingerprint &&
        decision.record.tenantScope === auth.fingerprint &&
        decision.record.sessionPolicyFingerprint === turn.lineage.sessionPolicyFingerprint
      ) {
        // A failover may leave the old account's parent intact. An exact
        // request owner wins over that possible predecessor for future retries.
        match(auth, decision.action === "resume" ? 1 : 2);
      }
    }
    if (matches.size > 1) throw sessionConflict("Ordinary transcript matches more than one configured Cursor account");
    return matches.values().next().value;
  }

  private claim(parsed: ParsedMessages, { auth, profile }: Candidate, turns: Map<RuntimeProfile, CursorAgentTurn>): () => void {
    const key = ordinaryReplayKey(this.baseTurn(parsed, profile, turns));
    let entry = this.claims.get(key);
    if (!entry || entry.fingerprint !== auth.fingerprint) {
      entry = { fingerprint: auth.fingerprint, users: 0 };
      this.claims.set(key, entry);
    }
    entry.users += 1;
    return () => {
      entry.users -= 1;
      if (entry.users === 0 && this.claims.get(key) === entry) this.claims.delete(key);
    };
  }
}
