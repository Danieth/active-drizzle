--------------------------------- MODULE DocLane ---------------------------------
(***************************************************************************)
(* DOC LANE of DESIGN-transport-proof.md (rev 3).                          *)
(*                                                                         *)
(* Models: the per-document gapless append-only ledger (A4), frame        *)
(* delivery over the weak channel Cw (Definition 1.1: loss, reorder,       *)
(* duplication), catch-up pulls over the RPC channel Cr (Definition 1.2),  *)
(* and per-client doc state: a received seq-set plus the PREFIX cursor     *)
(* of section 3 / O3'.                                                     *)
(*                                                                         *)
(* Abstraction of Loro (A5): the document state IS the received set of    *)
(* update seqs.  A5 says import is a join that is idempotent, commutative, *)
(* associative, buffering causally premature updates, and SEC gives        *)
(* "equal received sets imply equal states" -- so set union over seq ids   *)
(* is a faithful abstraction and no CRDT internals are modeled.  The       *)
(* "out-of-order holding set" of the client is DERIVED state here:         *)
(*     holding(c) == received[c] \ (1..cursor[c])                          *)
(* A5's pending-buffer makes a separate holding variable redundant in the  *)
(* model: buffered-but-not-yet-causally-applied updates are still in the   *)
(* received set for coverage purposes, which is exactly what the cursor    *)
(* and catch-up range care about (T5).                                     *)
(*                                                                         *)
(* One document is modeled.  A4 and T5 are per-document; documents do not  *)
(* interact, so one suffices.                                              *)
(*                                                                         *)
(* SCOPE vs O8: O8 mandates ONE mechanization of Rule M (floor semantics)  *)
(* + both lanes + prefix cursor + A2' + epochs, with six checked           *)
(* properties.  This module discharges ONLY no-cursor-skip (plus           *)
(* convergence, monotone cursor, and received-soundness as doc-lane        *)
(* shadows of T2(i)/T4/T5).  The other five checks -- no-regression,       *)
(* no-resurrection (incl. recreation), "304 never freshens a cell the      *)
(* client does not hold," "304 never certifies across a lifecycle event,"  *)
(* and "no pre-epoch frame is ever accepted" -- belong to a row-lane       *)
(* module (RowLane.tla) that does NOT exist yet; O8 is not discharged by   *)
(* this file alone.  Doors/epochs (A3, T9, O16) apply to ALL frames, doc   *)
(* frames included; omitting them HERE is sound only because a client's    *)
(* discard of a pre-epoch doc frame is behaviorally identical to Drop      *)
(* (Cw loss), which this model already covers.  When the channel layer is  *)
(* modeled explicitly, the epoch property must be checked there.           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Clients,   \* model values, e.g. {c1, c2}
  MaxSeq     \* bound on ledger length so TLC's state space is finite

ASSUME MaxSeq \in Nat /\ MaxSeq >= 1

VARIABLES
  ledgerLen, \* A4: the committed ledger is EXACTLY 1..ledgerLen -- gapless,
             \* append-only, appends linearized under the advisory lock held
             \* through commit.  Representing the ledger as its length is the
             \* whole content of A4: the committed seq set is always {1..k}.
             \* (O3: seq := max+1 under the lock; a bigserial would make the
             \* committed set a proper subset of 1..max and this encoding
             \* would be UNSOUND -- that is landmine 1 of the work doc.)
  chan,      \* Definition 1.1 (weak channel Cw): a set of pending frames
             \* <<client, seq>>.  Loss = Drop removes one undelivered.
             \* Reorder = free, since Deliver picks ANY element.
             \* Duplication = Deliver may leave the frame in the channel
             \* to be delivered again.
  received,  \* per client: set of seqs whose update payload has been
             \* imported (A5 join = set union of update ids)
  cursor     \* per client: the PREFIX cursor of section 3, Interpretation I:
             \*   cursor = max { n | 1..n \subseteq received }
             \* NEVER the high-water mark (O3', landmine 2).  T5: this makes
             \* catch-up over (cursor, ledgerLen] a complete range scan.

vars == <<ledgerLen, chan, received, cursor>>

Seqs == 1..MaxSeq

(* Interpretation I (section 3): the contiguous received prefix.           *)
(* Well-defined and unique for any S \subseteq 1..MaxSeq.                  *)
Prefix(S) ==
  CHOOSE n \in 0..MaxSeq : /\ \A i \in 1..n : i \in S
                           /\ (n + 1) \notin S

(* The out-of-order holding set -- derived, see header comment.            *)
Holding(c) == received[c] \ (1..cursor[c])

TypeOK ==
  /\ ledgerLen \in 0..MaxSeq
  /\ chan \subseteq (Clients \X Seqs)
  /\ received \in [Clients -> SUBSET Seqs]
  /\ cursor \in [Clients -> 0..MaxSeq]

Init ==
  /\ ledgerLen = 0
  /\ chan = {}
  /\ received = [c \in Clients |-> {}]
  /\ cursor = [c \in Clients |-> 0]

(***************************************************************************)
(* A4 -- append.  Appends are linearized (one at a time, under the         *)
(* advisory lock held through commit); the committed set stays gapless     *)
(* 1..k.  The server pushes a frame to every client: push is prepaid pull  *)
(* (C1) -- the frame may then be lost, duplicated, or reordered by Cw,     *)
(* and no safety property below depends on its fate.                       *)
(***************************************************************************)
Append ==
  /\ ledgerLen < MaxSeq
  /\ ledgerLen' = ledgerLen + 1
  /\ chan' = chan \cup { <<c, ledgerLen + 1>> : c \in Clients }
  /\ UNCHANGED <<received, cursor>>

(***************************************************************************)
(* Cw delivery of a frame (Definition 1.1).  The client imports the        *)
(* update: A5 join = set union, idempotent (re-delivery of a held seq is   *)
(* a no-op on received).  The cursor is then recomputed as the contiguous  *)
(* prefix (O3').  The nondeterministic keep/remove of the frame models     *)
(* duplication: a kept frame can be delivered again later.                 *)
(* Note: when s is already in received[c] and the keep branch is taken,    *)
(* the step is a pure self-loop (all four variables unchanged).  That is   *)
(* benign: [][Next]_vars allows it, it adds no states, and it cannot fake  *)
(* a Convergence counterexample -- any infinite behavior that idles while  *)
(* some Pull(c) stays enabled violates the WF conjunct and is excluded     *)
(* from Spec.                                                              *)
(***************************************************************************)
Deliver ==
  \E m \in chan :
    LET c == m[1]
        s == m[2]
        newRcv == received[c] \cup {s}
    IN
      /\ received' = [received EXCEPT ![c] = newRcv]
      /\ cursor' = [cursor EXCEPT ![c] = Prefix(newRcv)]   \* O3': prefix, not max
      /\ \/ chan' = chan \ {m}   \* frame consumed
         \/ chan' = chan         \* frame stays: Cw duplication
      /\ UNCHANGED ledgerLen

(***************************************************************************)
(* BROKEN ALTERNATIVE -- the high-water-mark cursor (landmine 2 / O3').    *)
(* Substitute DeliverHighWater for Deliver in Next and TLC finds the       *)
(* permanent-gap counterexample within seconds:                            *)
(*   Append x5 (ledger = 1..5); Drop the frames for seqs 3 and 4 to c1;    *)
(*   Deliver 1, 2, 5 to c1  ==>  cursor[c1] = 5 = ledgerLen, so Pull(c1)   *)
(*   is never enabled again, received[c1] = {1,2,5} forever.               *)
(*   Convergence is violated (a lasso: the system quiesces short of        *)
(*   1..ledgerLen), and NoCursorSkip is violated already at the delivery   *)
(*   of seq 5 (cursor 5 > prefix 2; seqs 3,4 not in received).  This is    *)
(*   exactly T5's "frames arriving 1, 2, 5 with a high-water cursor of 5   *)
(*   make catch-up over (5, k] omit 3 and 4 forever."                      *)
(*                                                                         *)
(* DeliverHighWater ==                                                     *)
(*   \E m \in chan :                                                       *)
(*     LET c == m[1]                                                       *)
(*         s == m[2]                                                       *)
(*     IN                                                                  *)
(*       /\ received' = [received EXCEPT ![c] = @ \cup {s}]                *)
(*       /\ cursor' = [cursor EXCEPT                                       *)
(*                       ![c] = IF s > @ THEN s ELSE @]  \* BROKEN: max    *)
(*       /\ \/ chan' = chan \ {m}                                          *)
(*          \/ chan' = chan                                                *)
(*       /\ UNCHANGED ledgerLen                                            *)
(***************************************************************************)

(***************************************************************************)
(* Cw loss (Definition 1.1): an undelivered frame vanishes.  Safety must   *)
(* be unaffected (C1: push is a latency optimization of pull).             *)
(***************************************************************************)
Drop ==
  \E m \in chan :
    /\ chan' = chan \ {m}
    /\ UNCHANGED <<ledgerLen, received, cursor>>

(***************************************************************************)
(* Catch-up pull over (cursor, ledgerLen] -- T5's "pure range scan",       *)
(* legitimate ONLY because the cursor is the prefix (every seq <= cursor   *)
(* is already held) and the ledger is gapless (A4: nothing between         *)
(* cursor and ledgerLen is missing from the server).  Runs on Cr           *)
(* (Definition 1.2): request/response, so the range arrives whole and      *)
(* reflects a ledger length >= the one at request time; modeled atomically.*)
(* Seqs in the holding set above the cursor are re-sent by the range scan  *)
(* and re-imported -- harmless by A5 idempotence.                          *)
(* A6 (fair pull) appears as weak fairness on this action in Spec; no      *)
(* safety invariant depends on it.                                         *)
(***************************************************************************)
Pull(c) ==
  /\ cursor[c] < ledgerLen    \* something to fetch
  /\ LET newRcv == received[c] \cup { s \in Seqs :
                                        cursor[c] < s /\ s <= ledgerLen }
     IN /\ received' = [received EXCEPT ![c] = newRcv]
        /\ cursor' = [cursor EXCEPT ![c] = Prefix(newRcv)]  \* = ledgerLen here
  /\ UNCHANGED <<ledgerLen, chan>>

Next ==
  \/ Append
  \/ Deliver
  \/ Drop
  \/ \E c \in Clients : Pull(c)

(* A6 -- fair pull: a client that keeps attempting a pull eventually       *)
(* completes one.  Liveness only; no safety result may use it.             *)
Fairness == \A c \in Clients : WF_vars(Pull(c))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(***************************************************************************)
(* PROPERTIES                                                              *)
(***************************************************************************)

(* Invariant (1) -- no-cursor-skip (O3', T5's load-bearing definition):    *)
(* the cursor never exceeds the contiguous received prefix, and every      *)
(* seq <= cursor is in the received set.                                   *)
NoCursorSkip ==
  \A c \in Clients :
    /\ cursor[c] <= Prefix(received[c])
    /\ \A s \in 1..cursor[c] : s \in received[c]

(* Soundness side-invariant: a client never receives a seq the ledger      *)
(* never committed (Cw can lose/reorder/duplicate but not invent -- the    *)
(* doc-lane shadow of T4's "no step manufactures a value").                *)
ReceivedSound ==
  \A c \in Clients : received[c] \subseteq 1..ledgerLen

(* Invariant (3) -- monotone cursor (doc-lane shadow of T2(i)): checked as *)
(* an action property under PROPERTIES in the .cfg.                        *)
MonotoneCursor ==
  [][ \A c \in Clients : cursor'[c] >= cursor[c] ]_vars

(* Property (2) -- convergence under fair pulls (T5 + A6): eventually,     *)
(* permanently, every client's received set equals the committed ledger    *)
(* 1..ledgerLen.  Stated <>[] because ledgerLen may still be growing when  *)
(* a client first catches up; appends are finite (bounded by MaxSeq), so   *)
(* after the last append fair pulls close every gap and set-union (A5)     *)
(* never un-receives anything.  By A5/SEC, equal received sets imply       *)
(* equal Loro documents, so this IS doc convergence.                       *)
Convergence ==
  <>[] (\A c \in Clients : received[c] = 1..ledgerLen)

-----------------------------------------------------------------------------
(***************************************************************************)
(* HAND-SIMULATED TRACES.  The mechanized check is specs/run-tlc.sh (TLC   *)
(* from specs/tla2tools.jar): with Clients = {c1, c2}, MaxSeq = 5 it       *)
(* exhausts the state space (1,118,481 distinct states, depth 16) with     *)
(* every invariant and both temporal properties satisfied.  The traces     *)
(* below are kept as worked examples of the two load-bearing scenarios.    *)
(*                                                                         *)
(* Trace 1 -- deliveries 1, 2, 5, then catch-up (the T5/O3' scenario).     *)
(* Constants: Clients = {c1, c2}, MaxSeq = 5.  Only c1 shown; c2 idle.     *)
(*                                                                         *)
(*  step                        ledgerLen  received[c1]  cursor[c1] chan(c1 part) *)
(*  Init                        0          {}            0          {}            *)
(*  Append x5                   5          {}            0          {1,2,3,4,5}   *)
(*  Deliver <<c1,1>> (remove)   5          {1}           1          {2,3,4,5}     *)
(*  Deliver <<c1,2>> (remove)   5          {1,2}         2          {3,4,5}       *)
(*  Drop <<c1,3>>               5          {1,2}         2          {4,5}         *)
(*  Drop <<c1,4>>               5          {1,2}         2          {5}           *)
(*  Deliver <<c1,5>> (remove)   5          {1,2,5}       2          {}            *)
(*      ^ Prefix({1,2,5}) = 2: seq 5 sits in Holding(c1) = {5}.            *)
(*        NoCursorSkip holds: cursor 2 = prefix; 1,2 both received.        *)
(*  Pull(c1): enabled (2 < 5); fetch (2,5] = {3,4,5}                       *)
(*                              5          {1,2,3,4,5}   5          {}            *)
(*      ^ seq 5 re-imported by the range scan: no-op by A5 idempotence.    *)
(*  => received[c1] = 1..ledgerLen; with WF(Pull(c2)) c2 converges the     *)
(*     same way; Convergence's <>[] target is reached and (received only   *)
(*     grows, appends exhausted) never left.                               *)
(*                                                                         *)
(*  Same prefix-trace under the BROKEN DeliverHighWater: after             *)
(*  Deliver <<c1,5>>, cursor[c1] = 5.  NoCursorSkip already violated       *)
(*  (5 > Prefix({1,2,5}) = 2; 3 <= 5 not received).  Pull(c1) is disabled  *)
(*  forever (cursor = ledgerLen), so WF(Pull(c1)) is vacuous, the system   *)
(*  quiesces with received[c1] = {1,2,5} != 1..5, and TLC reports the      *)
(*  Convergence lasso.  Permanent gap, exactly landmine 2.                 *)
(*                                                                         *)
(* Trace 2 -- duplication + reorder + loss repaired by pull (Cw's full     *)
(* menu, Definition 1.1).  Only c1 shown.                                  *)
(*                                                                         *)
(*  step                        ledgerLen  received[c1]  cursor[c1] chan(c1 part) *)
(*  Init                        0          {}            0          {}            *)
(*  Append x3                   3          {}            0          {1,2,3}       *)
(*  Deliver <<c1,2>> (KEEP)     3          {2}           0          {1,2,3}       *)
(*      ^ reorder: 2 before 1.  Holding(c1) = {2}; cursor stays 0.         *)
(*  Deliver <<c1,2>> (remove)   3          {2}           0          {1,3}         *)
(*      ^ duplication: second delivery of seq 2 is a no-op on received     *)
(*        (A5 idempotent join); cursor recomputed to the same 0.           *)
(*        MonotoneCursor: 0 >= 0.                                          *)
(*  Drop <<c1,1>>               3          {2}           0          {3}           *)
(*      ^ loss of the only frame for seq 1.                                *)
(*  Deliver <<c1,3>> (remove)   3          {2,3}         0          {}            *)
(*      ^ Holding(c1) = {2,3}; prefix still 0 -- the cursor never jumped,  *)
(*        so the coming pull's range still covers the lost seq 1.          *)
(*  Pull(c1): enabled (0 < 3); fetch (0,3] = {1,2,3}                       *)
(*                              3          {1,2,3}       3          {}            *)
(*  => the lost frame was repaired by pull with zero special-casing: C1,   *)
(*     push is prepaid pull.  All of NoCursorSkip, ReceivedSound,          *)
(*     MonotoneCursor hold at every step above.                            *)
(***************************************************************************)
=============================================================================
