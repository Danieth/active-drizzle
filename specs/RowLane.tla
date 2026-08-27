---------------------------- MODULE RowLane ----------------------------
(***************************************************************************)
(* RowLane -- the ROW LANE of the transport model: the client entry store  *)
(* under Rule M.  Formalizes DESIGN-transport-proof.md (rev 3, including   *)
(* the M4/T3 per-field 304-guard amendment that THIS model's checking      *)
(* forced -- see ambiguity note (2)); this is the row-lane half of         *)
(* obligation O8 (WS6).  The doc lane (A4/A5, prefix cursor) is a          *)
(* separate module.                                                        *)
(*                                                                         *)
(* The model:                                                              *)
(*   - One server holding ONE identity's lineage of committed states.      *)
(*     A single lineage suffices: the proof doc's A1 makes every theorem   *)
(*     per-identity ("No axiom asserts a global order across records"),    *)
(*     so a second pk is an independent product that multiplies the state  *)
(*     space without adding checkable behavior.  The lineage includes      *)
(*     destroy and re-creation of the same pk (A1: tokens are per-lineage, *)
(*     strictly increasing across ALL commits including destroys and       *)
(*     re-creates; a physical delete must not restart the counter).       *)
(*     Refinement note: tokens here are consecutive 1..Len(hist).  A1      *)
(*     requires only "strictly increasing"; consecutive is a legitimate    *)
(*     refinement -- gaps add no behavior because every interval check     *)
(*     ((W,V] in A2') is made against the explicit event history.          *)
(*   - A weak channel Cw (Definition 1.1): arbitrary loss, reorder,        *)
(*     duplication.  Modeled as a grow-only SET of sent frames from which  *)
(*     any element may be delivered any number of times, or never.  That   *)
(*     covers loss (never delivered), duplication (delivered repeatedly),  *)
(*     and reorder (any delivery order).                                   *)
(*   - The RPC channel Cr (Definition 1.2) carries pulls and validation.   *)
(*     BOTH are split into issue / server-process / client-apply so that   *)
(*     Cw traffic and further commits can interleave while a response is   *)
(*     in flight (the T3 "case L >= V" race, and its pull twin).  A        *)
(*     response may also be dropped ("a response, IF delivered at all,     *)
(*     ...").  Three-phase pulls close a gap an earlier revision only      *)
(*     argued: a DELAYED full-projection pull response computed at token   *)
(*     V merges (ValueAt(f,V), V) even for a field f NOT written at V --   *)
(*     advancing certification (lastSeen) of UNCHANGED fields to V, a      *)
(*     cell shape no per-commit partial frame carries (frames carry        *)
(*     exactly the fields written at their token), so no stale-live-frame  *)
(*     argument covers it.  It is now modeled, not argued: TLC beats       *)
(*     delayed pull responses against destroys, re-creates, newer pushes,  *)
(*     and L3 GC, under every invariant and action property below.        *)
(*   - N >= 2 clients, each holding entry = (floor, cells with per-field   *)
(*     lastSeen) plus knownVersion (Section 3), merging via Rule M.        *)
(*   - Subscription epochs (T9/O16): every push frame is stamped with the  *)
(*     sending channel's epoch; RESET bumps the client's current epoch;    *)
(*     frames with epoch < current are dropped.  Validation and pulls run  *)
(*     on Cr and are NOT epoch-filtered (epochs are a per-channel frame    *)
(*     mechanism).                                                         *)
(*                                                                         *)
(* Value representation (A0 -- canonical representation): the value of     *)
(* field f written by commit t IS the token t.  Distinct commits carry     *)
(* distinct values, so Lemma L1 (agreement: same (f,V) => same value) is   *)
(* the statement val = ValueAt(f, V), checked by ComponentwiseTruth.       *)
(* Frames do not store values; a frame at token V recomputes               *)
(* ValueAt(f, V) at merge time.  This is sound because hist is             *)
(* append-only and ValueAt(f, V) depends only on the prefix up to V:       *)
(* the recomputed value equals the send-time snapshot value (A2 + L1       *)
(* determinism).  It also keeps the channel state small.                   *)
(*                                                                         *)
(* O8 invariant map (numbered as in the tasking / proof-doc Section 7):    *)
(*   (1) no-regression ................ NoRegression      (action prop)    *)
(*   (2) no-resurrection .............. NoResurrection + FloorIsMaxDestroy *)
(*   (3) 304 never freshens unheld .... No304Freshen      (action prop)    *)
(*   (4) 304 never crosses lifecycle .. No304AcrossLifecycle               *)
(*   (5) no pre-epoch frame accepted .. NoPreEpochAccept                   *)
(*   (6) componentwise truth (T4) ..... ComponentwiseTruth                 *)
(*                                                                         *)
(* Not modeled (out of row-lane scope, or non-theorems by Section 6):      *)
(* A4/A5/T5 doc lane; A6 fair pull (liveness -- safety only here);         *)
(* T6 own-write floor (needs mutation RPCs); T7 overlay; T8 membership;    *)
(* door masking / auth content of T9 (the epoch FILTER is modeled, the     *)
(* leak bound is not); session snapshots (deliberately refused);           *)
(* door-masked SUB-slice frames                                            *)
(* (A3) -- emitted frames always carry the full written set; harmless      *)
(* because every invariant here is componentwise, so a masked frame is a   *)
(* frame with a smaller F.                                                 *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Clients,   \* N >= 2 client replicas
  Fields,    \* fields of the modeled identity (2-3)
  MaxToken,  \* bound on the lineage token chain (A1); ~5-6
  MaxEpoch   \* bound on subscription epochs (T9/O16); 2

ASSUME /\ Cardinality(Clients) >= 2
       /\ Cardinality(Fields) >= 2
       /\ MaxToken \in Nat \ {0}
       /\ MaxEpoch \in Nat \ {0}

NoTok  == 0            \* encodes -infinity / "absent" (real tokens start at 1)
Tokens == 1..MaxToken
TokOpt == 0..MaxToken
Epochs == 1..MaxEpoch

Max2(a, b) == IF a >= b THEN a ELSE b
MaxS(S)    == IF S = {} THEN 0 ELSE CHOOSE m \in S : \A x \in S : m >= x
MinS(S)    == CHOOSE m \in S : \A x \in S : m =< x   \* callers guarantee S # {}

VARIABLES
  hist,           \* server: the lineage, Seq of events; token t = index t (A1)
  chan,           \* the weak channel Cw: grow-only set of frames (loss/reorder/dup)
  srvEpoch,       \* server-side per-client channel epoch (frames stamped with it)
  cells,          \* per client: f |-> [val, ls]  (ls = lastSeen; 0 = absent/-inf)
  floor,          \* per client: the deletion floor (monotone; 0 = -inf)   [Sec 3]
  known,          \* per client: knownVersion -- a rumor bound, never a freshness claim
  epoch,          \* per client: current subscription epoch (T9/O16)
  vstate,         \* per client: validation state machine (idle/req/304/gone/slice)
  pstate,         \* per client: pull state machine (idle/req/live/gone) -- Cr,
                  \* three-phase like vstate so responses can be delayed/dropped
  destroysMerged, \* HISTORY per client: every destroy token ever applied via M2.
                  \* Auxiliary only -- no rule reads it.  Gives NoResurrection
                  \* real teeth: floor-vs-visibility alone is true by definition
                  \* of Visible; against this log, rev-2's replace-a-tombstone
                  \* semantics (the L2 counterexample) is caught by TLC.
  acceptedPairs   \* HISTORY per client: {<<frame epoch, client epoch at accept>>}
                  \* for every accepted push frame.  Auxiliary; gives
                  \* NoPreEpochAccept teeth if someone deletes the epoch guard.

vars == <<hist, chan, srvEpoch, cells, floor, known, epoch, vstate, pstate,
          destroysMerged, acceptedPairs>>

(***************************************************************************)
(* Server derived state.                                                   *)
(***************************************************************************)
STok  == Len(hist)                                  \* current lineage token v(r)
Alive == STok > 0 /\ hist[STok].kind /= "destroy"
  \* Only "create" can follow "destroy" (writes require Alive), so a dead
  \* record's last event is its destroy: the destroy token D is then STok.
  \* NB: hist[STok] is defined only under the first conjunct; TLC's lazy
  \* left-to-right /\ makes this fine for model checking, but under TLAPS
  \* or a reordering tool rewrite as
  \* IF STok = 0 THEN FALSE ELSE hist[STok].kind /= "destroy".

\* A0/A2: commit t writes field f (create writes every field -- an INSERT
\* provides every column; defaults are writes).  See ambiguity note (3) at
\* the bottom.
WritesField(t, f) ==
  \/ hist[t].kind = "create"
  \/ hist[t].kind = "write" /\ f \in hist[t].flds

\* Server-side per-field last_write as of token v  (A2' clause (i) input)
LastWriteUpTo(f, v) == MaxS({t \in 1..v : WritesField(t, f)})

\* The value of field f at lineage token v (values ARE write tokens; A0/L1)
ValueAt(f, v) == LastWriteUpTo(f, v)

\* r is live at token v (writes/creates only happen while live, so any
\* non-destroy commit leaves the record live)          (A2' clause (iii) input)
LiveAtTok(v) == hist[v].kind /= "destroy"

\* A2' clause (ii): a lifecycle event -- destroy or (re-)create -- in (w, v]
LifecycleIn(w, v) == \E t \in (w+1)..v : hist[t].kind \in {"create", "destroy"}

(***************************************************************************)
(* Frames on Cw.  Uniform record shape; unused fields zeroed.              *)
(*   k = "live"  : live payload, fields flds at token tok        (-> M1)   *)
(*   k = "dest"  : destroy payload at token tok                  (-> M2)   *)
(*   k = "sig"   : bare signal carrying token tok                (-> M3)   *)
(*   k = "reset" : RESET establishing epoch ep                   (T9/O16)  *)
(* Data frames are stamped with the sending channel's epoch (ep).          *)
(***************************************************************************)
FrameT == [k: {"live", "dest", "sig", "reset"}, dst: Clients,
           tok: TokOpt, ep: Epochs, flds: SUBSET Fields]

EmitTo(knd, t, F) ==
  { [k |-> knd, dst |-> c, tok |-> t, ep |-> srvEpoch[c], flds |-> F]
    : c \in Clients }

(***************************************************************************)
(* Server actions.  Each commit appends one event (A1: the token chain is  *)
(* strictly increasing across writes, destroys, and re-creates of the same *)
(* pk -- one lineage) and emits, per client, a push frame plus a bare      *)
(* signal onto Cw (A2: each payload is computed from the one committed     *)
(* snapshot at its token).  Push is prepaid pull; emission is best-effort  *)
(* because Cw may drop everything (C1).                                    *)
(***************************************************************************)
SrvCreate ==            \* create, or RE-create after a destroy (same lineage, A1)
  /\ ~Alive
  /\ STok < MaxToken
  /\ hist' = Append(hist, [kind |-> "create", flds |-> Fields])
  /\ chan' = chan \cup EmitTo("live", STok + 1, Fields)
                  \cup EmitTo("sig", STok + 1, {})
  /\ UNCHANGED <<srvEpoch, cells, floor, known, epoch, vstate, pstate,
                 destroysMerged, acceptedPairs>>

SrvWrite(F) ==
  /\ Alive
  /\ STok < MaxToken
  /\ F /= {}
  /\ hist' = Append(hist, [kind |-> "write", flds |-> F])
  /\ chan' = chan \cup EmitTo("live", STok + 1, F)     \* frame carries only the
                  \cup EmitTo("sig", STok + 1, {})     \* written fields (a door
                                                        \* slice; absence /= null)
  /\ UNCHANGED <<srvEpoch, cells, floor, known, epoch, vstate, pstate,
                 destroysMerged, acceptedPairs>>

SrvDestroy ==
  /\ Alive
  /\ STok < MaxToken
  /\ hist' = Append(hist, [kind |-> "destroy", flds |-> {}])
  /\ chan' = chan \cup EmitTo("dest", STok + 1, {})
                  \cup EmitTo("sig", STok + 1, {})
  /\ UNCHANGED <<srvEpoch, cells, floor, known, epoch, vstate, pstate,
                 destroysMerged, acceptedPairs>>

\* T9/O16: a RESET establishes a new epoch for one client's channel.  The
\* RESET itself travels on Cw (it can be lost, duplicated, reordered).
SrvReset(c) ==
  /\ srvEpoch[c] < MaxEpoch
  /\ srvEpoch' = [srvEpoch EXCEPT ![c] = @ + 1]
  /\ chan' = chan \cup {[k |-> "reset", dst |-> c, tok |-> 0,
                         ep |-> srvEpoch[c] + 1, flds |-> {}]}
  /\ UNCHANGED <<hist, cells, floor, known, epoch, vstate, pstate,
                 destroysMerged, acceptedPairs>>

(***************************************************************************)
(* Rule M -- client merges (Section 3).  Note for auditing against L2: no  *)
(* rule ever lowers or removes the floor, and no rule's guard reads        *)
(* another component (knownVersion is read by NO guard anywhere).          *)
(***************************************************************************)

\* M1 (live payload F at V): for each f in F, cell(f) := (payload.f, V) iff
\* V >= lastSeen(f) (a missing cell has lastSeen = -inf = 0).  The floor is
\* untouched.  Fields not in F are untouched -- absence is projection,
\* never null.
M1Cells(c, F, v) ==
  [f \in Fields |->
     IF f \in F /\ v >= cells[c][f].ls
     THEN [val |-> ValueAt(f, v), ls |-> v]
     ELSE cells[c][f]]

\* --- Cw deliveries.  Frames stay in chan: re-delivery models duplication,
\* --- never delivering models loss, arbitrary choice models reorder.

DeliverLive(c, m) ==
  /\ m \in chan /\ m.k = "live" /\ m.dst = c
  /\ m.ep >= epoch[c]      \* T9/O16 epoch filter: pre-epoch frames are dropped
  /\ cells' = [cells EXCEPT ![c] = M1Cells(c, m.flds, m.tok)]         \* M1
  /\ known' = [known EXCEPT ![c] = Max2(@, m.tok)]
       \* "every payload also performs M3's knownVersion update"
  /\ acceptedPairs' = [acceptedPairs EXCEPT
                         ![c] = @ \cup {<<m.ep, epoch[c]>>}]
  /\ UNCHANGED <<hist, chan, srvEpoch, floor, epoch, vstate, pstate,
                 destroysMerged>>

DeliverDest(c, m) ==
  /\ m \in chan /\ m.k = "dest" /\ m.dst = c
  /\ m.ep >= epoch[c]      \* T9/O16 epoch filter
  /\ floor' = [floor EXCEPT ![c] = Max2(@, m.tok)]
       \* M2 (destroy at D): floor := max(floor, D).  Cells are untouched
       \* (L3 garbage collection may drop dead cells; see DropDeadCell).
  /\ destroysMerged' = [destroysMerged EXCEPT ![c] = @ \cup {m.tok}]
  /\ known' = [known EXCEPT ![c] = Max2(@, m.tok)]                    \* M3 rider
  /\ acceptedPairs' = [acceptedPairs EXCEPT
                         ![c] = @ \cup {<<m.ep, epoch[c]>>}]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, epoch, vstate, pstate>>

DeliverSig(c, m) ==
  /\ m \in chan /\ m.k = "sig" /\ m.dst = c
  /\ m.ep >= epoch[c]      \* T9/O16 epoch filter (signals ride the push channel)
  /\ known' = [known EXCEPT ![c] = Max2(@, m.tok)]
       \* M3 (bare signal at V): knownVersion := max(knownVersion, V).
       \* Nothing else.  Signals never certify.
  /\ acceptedPairs' = [acceptedPairs EXCEPT
                         ![c] = @ \cup {<<m.ep, epoch[c]>>}]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, epoch, vstate, pstate,
                 destroysMerged>>

\* T9/O16: processing a RESET bumps the client's current epoch.  Joined via
\* max so a duplicated/reordered stale RESET can never lower it (Cw!).
DeliverReset(c, m) ==
  /\ m \in chan /\ m.k = "reset" /\ m.dst = c
  /\ epoch' = [epoch EXCEPT ![c] = Max2(@, m.ep)]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, known, vstate, pstate,
                 destroysMerged, acceptedPairs>>

\* L3 -- garbage collection: physically dropping a dead cell
\* (lastSeen <= floor) never changes the interpretation of any reachable
\* future state.  Modeled so TLC checks L3 against every invariant.
DropDeadCell(c, f) ==
  /\ cells[c][f].ls > 0
  /\ cells[c][f].ls =< floor[c]
  /\ cells' = [cells EXCEPT ![c][f] = [val |-> 0, ls |-> 0]]
  /\ UNCHANGED <<hist, chan, srvEpoch, floor, known, epoch, vstate, pstate,
                 destroysMerged, acceptedPairs>>

(***************************************************************************)
(* Pull (Cr) -- three-phase, exactly like validation:                      *)
(*   issue (client) -> process (server: token V recorded, payload          *)
(*   determined by the CURRENT committed snapshot) -> apply-or-drop        *)
(*   (client, after arbitrary interleaving).                               *)
(* A GET response is a payload satisfying A0-A3 like any frame; pulls      *)
(* bypass the epoch filter (Cr, not the push channel).  The projection P   *)
(* is an arbitrary nonempty field set; P = Fields is the full-slice GET    *)
(* and the load-bearing case: a DELAYED full-projection response           *)
(* certifies fields UNCHANGED at V (lastSeen -> V with the same value),    *)
(* a cell shape no per-commit Cw frame produces.                           *)
(*                                                                         *)
(* The payload {f \in P |-> ValueAt(f, V)} is recomputed at apply time     *)
(* from (P, V): sound because hist is append-only and ValueAt(f, V)        *)
(* depends only on hist[1..V], so the recomputed value equals the          *)
(* process-time snapshot value (the same argument as the slice response).  *)
(*                                                                         *)
(* Bounded in-flight discipline (state-space control, same as vstate):     *)
(* pstate is ONE record per client, so at most one pull is in flight per   *)
(* client.  Two concurrent pulls by the SAME client interleave their       *)
(* applies, but each apply is an independent max-join merge of an          *)
(* independently computed (P, V); the one-at-a-time machine plus Cw        *)
(* traffic already produces every apply-time client state a second         *)
(* in-flight pull could meet, so a larger cap multiplies the space         *)
(* without new checkable behavior.                                         *)
(***************************************************************************)
IdleP == [st |-> "idle", P |-> {}, V |-> 0]

IssuePull(c) ==
  /\ pstate[c].st = "idle"
  /\ \E P \in (SUBSET Fields) \ {{}} :
       pstate' = [pstate EXCEPT ![c] = [st |-> "req", P |-> P, V |-> 0]]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, known, epoch, vstate,
                 destroysMerged, acceptedPairs>>

\* The server answers from its CURRENT state (V = STok), like A2'
\* processing: a live record yields the P-projection payload at V; a
\* destroyed record yields gone(D), D = STok (a dead record's last
\* lineage event is its destroy).  A pull issued before any create
\* (STok = 0) pends until a lineage exists -- there is no token to
\* answer with; the pending request is inert and can only wait.
SrvProcessPull(c) ==
  /\ pstate[c].st = "req"
  /\ STok > 0
  /\ pstate' = [pstate EXCEPT ![c] =
                  [st |-> IF Alive THEN "live" ELSE "gone",
                   P  |-> pstate[c].P, V |-> STok]]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, known, epoch, vstate,
                 destroysMerged, acceptedPairs>>

\* M1 merge of the recorded payload -- possibly long after V: the server
\* may have advanced through pushes, destroys, and re-creates since the
\* response was computed, and the client may have merged newer frames or
\* GC'd dead cells (L3) in between.  The per-field max-join makes stale
\* components no-ops, and a pre-destroy V can never lift a cell over the
\* floor (the floor only rises).  This is the pull twin of T3's
\* in-flight race, now checked rather than argued.
ApplyPullLive(c) ==
  /\ pstate[c].st = "live"
  /\ cells' = [cells EXCEPT ![c] = M1Cells(c, pstate[c].P, pstate[c].V)] \* M1
  /\ known' = [known EXCEPT ![c] = Max2(@, pstate[c].V)]          \* M3 rider
  /\ pstate' = [pstate EXCEPT ![c] = IdleP]
  /\ UNCHANGED <<hist, chan, srvEpoch, floor, epoch, vstate,
                 destroysMerged, acceptedPairs>>

\* M2 merge of a gone(D) response (delayed like any other response).
ApplyPullGone(c) ==
  /\ pstate[c].st = "gone"
  /\ floor' = [floor EXCEPT ![c] = Max2(@, pstate[c].V)]                 \* M2
  /\ destroysMerged' = [destroysMerged EXCEPT ![c] = @ \cup {pstate[c].V}]
  /\ known' = [known EXCEPT ![c] = Max2(@, pstate[c].V)]          \* M3 rider
  /\ pstate' = [pstate EXCEPT ![c] = IdleP]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, epoch, vstate, acceptedPairs>>

\* Cr may lose a response ("a response, IF delivered at all, ...", Def 1.2)
DropPullResponse(c) ==
  /\ pstate[c].st \in {"live", "gone"}
  /\ pstate' = [pstate EXCEPT ![c] = IdleP]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, known, epoch, vstate,
                 destroysMerged, acceptedPairs>>

(***************************************************************************)
(* Validation (Cr) -- M4 + A2'.  Three-phase to let Cw interleave:         *)
(*   issue (client) -> process (server, A2') -> apply-or-drop (client).    *)
(***************************************************************************)
IdleV == [st |-> "idle", P |-> {}, W |-> 0, V |-> 0]

HeldFields(c) == {f \in Fields : cells[c][f].ls > 0}

\* M4 precondition: the client holds a cell for every f in P -- W is
\* computed from held cells, so the request is well-formed by construction.
\* W = min lastSeen over P = projFreshAt(P) (Interpretation I).  P may
\* include DEAD cells (ls <= floor): deliberately allowed, to check that
\* A2' stays sound even for adversarial projections over dead cells.
IssueValidation(c) ==
  /\ vstate[c].st = "idle"
  /\ \E P \in (SUBSET HeldFields(c)) \ {{}} :
       vstate' = [vstate EXCEPT ![c] =
                    [st |-> "req", P |-> P,
                     W  |-> MinS({cells[c][f].ls : f \in P}), V |-> 0]]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, known, epoch, pstate,
                 destroysMerged, acceptedPairs>>

\* A2' -- the validation predicate (lifecycle-aware), evaluated against the
\* server's CURRENT state (V = v(r) = STok).  The gap between issue and
\* process lets the server advance in between (the destroyed-at-11 attempt).
SrvProcessValidation(c) ==
  /\ vstate[c].st = "req"
  /\ LET P == vstate[c].P
         W == vstate[c].W
     IN
     IF ~Alive
     THEN \* A2' case gone(D): r is destroyed; D is the destroy token
          \* (= STok: a dead record's last lineage event is its destroy)
          vstate' = [vstate EXCEPT ![c] =
                       [st |-> "gone", P |-> P, W |-> W, V |-> STok]]
     ELSE IF /\ \A f \in P : LastWriteUpTo(f, STok) =< W  \* A2' clause (i):
                                        \* per-field last_write(f) <= W
             /\ ~LifecycleIn(W, STok)                     \* A2' clause (ii):
                                        \* no destroy/re-create in (W, V]
             /\ Alive                                     \* A2' clause (iii):
                                        \* r is live at V (V = STok; redundant
                                        \* in this branch, kept for audit)
          THEN \* A2' case 304 carrying V
               vstate' = [vstate EXCEPT ![c] =
                            [st |-> "304", P |-> P, W |-> W, V |-> STok]]
          ELSE \* A2' case dirty slice (fields of P written since W, at V).
               \* The slice is recomputed at apply time from (P, W, V):
               \* sound because hist is append-only and the dirty set and
               \* values depend only on hist[1..V].
               vstate' = [vstate EXCEPT ![c] =
                            [st |-> "slice", P |-> P, W |-> W, V |-> STok]]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, known, epoch, pstate,
                 destroysMerged, acceptedPairs>>

\* M4 case 304 (carrying V): lastSeen(f) := max(lastSeen(f), V) for each
\* f in P whose cell still satisfies lastSeen(f) >= W.  The per-field
\* guard re-establishes AT APPLY TIME the "W <= L" step of T3's case
\* L < V: A2'(i) gives last_write(f) <= W <= lastSeen and A2'(ii)
\* excludes lifecycle events in (W, V] \supseteq (lastSeen, V], so the
\* held value is the value at V and the advance is a certification; for
\* lastSeen >= V the max-join is a no-op (the fresher-payload-in-flight
\* race).  A cell whose lastSeen fell BELOW W since issue -- L3 GC of a
\* dead cell (ls = 0), possibly followed by a re-merge from a STALER
\* frame at a token < W -- gets NO certification: without the guard,
\* GC + stale re-merge lets the 304 stamp an old value with token V, a
\* (value, token) pair that never existed in the lineage (TLC finds the
\* ComponentwiseTruth violation in 11 steps at MaxToken = 3).  The guard
\* subsumes the old "client still holds the cell" test (ls > 0), since
\* W >= 1 on any issued request.  See ambiguity note (2) at the bottom.
Apply304(c) ==
  /\ vstate[c].st = "304"
  /\ LET P == vstate[c].P
         W == vstate[c].W
         V == vstate[c].V
     IN
     /\ cells' = [cells EXCEPT ![c] =
                    [f \in Fields |->
                       IF f \in P /\ cells[c][f].ls >= W
                       THEN [val |-> cells[c][f].val,
                             ls  |-> Max2(cells[c][f].ls, V)]
                       ELSE cells[c][f]]]
     /\ known' = [known EXCEPT ![c] = Max2(@, V)]        \* M3 rider
     /\ vstate' = [vstate EXCEPT ![c] = IdleV]
  /\ UNCHANGED <<hist, chan, srvEpoch, floor, epoch, pstate, destroysMerged,
                 acceptedPairs>>

\* M4 case gone(D): apply M2.
ApplyGone(c) ==
  /\ vstate[c].st = "gone"
  /\ floor' = [floor EXCEPT ![c] = Max2(@, vstate[c].V)]              \* M2
  /\ destroysMerged' = [destroysMerged EXCEPT ![c] = @ \cup {vstate[c].V}]
  /\ known' = [known EXCEPT ![c] = Max2(@, vstate[c].V)]              \* M3 rider
  /\ vstate' = [vstate EXCEPT ![c] = IdleV]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, epoch, pstate, acceptedPairs>>

\* M4 case slice: apply M1 with the dirty fields at V.  Note the doc's M4
\* says slice -> M1, and M1 touches only carried fields: the CLEAN fields
\* of P get no certification from a slice response (fidelity over
\* cleverness -- see ambiguity note (1)).
ApplySlice(c) ==
  /\ vstate[c].st = "slice"
  /\ LET P     == vstate[c].P
         W     == vstate[c].W
         V     == vstate[c].V
         Dirty == {f \in P : LastWriteUpTo(f, V) > W}
     IN
     /\ cells' = [cells EXCEPT ![c] = M1Cells(c, Dirty, V)]           \* M1
     /\ known' = [known EXCEPT ![c] = Max2(@, V)]                     \* M3 rider
     /\ vstate' = [vstate EXCEPT ![c] = IdleV]
  /\ UNCHANGED <<hist, chan, srvEpoch, floor, epoch, pstate, destroysMerged,
                 acceptedPairs>>

\* Cr may lose a response ("a response, IF delivered at all, ...", Def 1.2)
DropValidationResponse(c) ==
  /\ vstate[c].st \in {"304", "gone", "slice"}
  /\ vstate' = [vstate EXCEPT ![c] = IdleV]
  /\ UNCHANGED <<hist, chan, srvEpoch, cells, floor, known, epoch, pstate,
                 destroysMerged, acceptedPairs>>

(***************************************************************************)
(* Spec.                                                                   *)
(***************************************************************************)
Init ==
  /\ hist = <<>>
  /\ chan = {}
  /\ srvEpoch = [c \in Clients |-> 1]
  /\ cells = [c \in Clients |-> [f \in Fields |-> [val |-> 0, ls |-> 0]]]
  /\ floor = [c \in Clients |-> 0]                     \* -infinity
  /\ known = [c \in Clients |-> 0]
  /\ epoch = [c \in Clients |-> 1]
  /\ vstate = [c \in Clients |-> IdleV]
  /\ pstate = [c \in Clients |-> IdleP]
  /\ destroysMerged = [c \in Clients |-> {}]
  /\ acceptedPairs = [c \in Clients |-> {}]

Next ==
  \/ SrvCreate
  \/ \E F \in (SUBSET Fields) \ {{}} : SrvWrite(F)
  \/ SrvDestroy
  \/ \E c \in Clients :
       \/ SrvReset(c)
       \/ \E m \in chan : \/ DeliverLive(c, m)
                          \/ DeliverDest(c, m)
                          \/ DeliverSig(c, m)
                          \/ DeliverReset(c, m)
       \/ \E f \in Fields : DropDeadCell(c, f)
       \/ IssuePull(c)
       \/ SrvProcessPull(c)
       \/ ApplyPullLive(c)
       \/ ApplyPullGone(c)
       \/ DropPullResponse(c)
       \/ IssueValidation(c)
       \/ SrvProcessValidation(c)
       \/ Apply304(c)
       \/ ApplyGone(c)
       \/ ApplySlice(c)
       \/ DropValidationResponse(c)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Interpretation I (rendering, not state): cell f is visible iff          *)
(* lastSeen(f) > floor.                                                    *)
(***************************************************************************)
Visible(c, f) == cells[c][f].ls > floor[c]

(***************************************************************************)
(* Invariants (the six O8 targets) + typing.                               *)
(***************************************************************************)
CellT   == [val: TokOpt, ls: TokOpt]
EventT  == [kind: {"create", "write", "destroy"}, flds: SUBSET Fields]
VStateT == [st: {"idle", "req", "304", "gone", "slice"},
            P: SUBSET Fields, W: TokOpt, V: TokOpt]
PStateT == [st: {"idle", "req", "live", "gone"},
            P: SUBSET Fields, V: TokOpt]

TypeOK ==
  /\ hist \in Seq(EventT) /\ Len(hist) =< MaxToken
  /\ chan \subseteq FrameT
  /\ srvEpoch \in [Clients -> Epochs]
  /\ cells \in [Clients -> [Fields -> CellT]]
  /\ floor \in [Clients -> TokOpt]
  /\ known \in [Clients -> TokOpt]
  /\ epoch \in [Clients -> Epochs]
  /\ vstate \in [Clients -> VStateT]
  /\ pstate \in [Clients -> PStateT]
  /\ destroysMerged \in [Clients -> SUBSET Tokens]
  /\ acceptedPairs \in [Clients -> SUBSET (Epochs \X Epochs)]

\* --- O8 invariant (2): no-resurrection (T2(ii), including pk
\* re-creation).  Once a destroy at D has merged at a client, no cell with
\* token <= D is ever visible at that client again.  Checked against the
\* destroysMerged history log, so rev-2's replaceable-tombstone semantics
\* (the L2 counterexample: order D.B.A re-admitting a pre-delete cell)
\* would be caught, not defined away.  Re-created cells carry tokens > D
\* by A1 and are legitimately visible.
NoResurrection ==
  \A c \in Clients : \A f \in Fields :
    Visible(c, f) => \A d \in destroysMerged[c] : cells[c][f].ls > d

\* Supporting characterization: the floor is exactly the join of the
\* destroy tokens merged so far (M2 is the only rule that touches it, and
\* no rule ever lowers it -- L2's "no rule lowers or removes the floor").
FloorIsMaxDestroy ==
  \A c \in Clients : floor[c] = MaxS(destroysMerged[c])

\* --- O8 invariant (4): "a 304 never certifies across a lifecycle event"
\* (rejected-predicate (d); the destroyed-at-11 example).  Every pending
\* 304 response satisfies all three A2' clauses -- stated against the
\* explicit history, so dropping clause (ii) or (iii) from
\* SrvProcessValidation is caught here directly (and, for clause (iii),
\* by ComponentwiseTruth once applied).  hist is append-only, so a
\* response computed earlier still satisfies this at every later state.
No304AcrossLifecycle ==
  \A c \in Clients :
    vstate[c].st = "304" =>
      /\ vstate[c].V \in 1..Len(hist)
      /\ LiveAtTok(vstate[c].V)                        \* A2' clause (iii)
      /\ ~LifecycleIn(vstate[c].W, vstate[c].V)        \* A2' clause (ii)
      /\ \A f \in vstate[c].P :
           LastWriteUpTo(f, vstate[c].V) =< vstate[c].W  \* A2' clause (i)

\* --- O8 invariant (5): no pre-epoch frame is ever accepted after its
\* RESET processes (T9(ii)/O16).  Every accepted push frame's stamp was
\* >= the client's epoch at accept time.  Delivery order is NOT the
\* boundary -- Cw legally delivers old frames after the RESET -- the epoch
\* filter is.  Checked against the acceptedPairs history log, so deleting
\* the "m.ep >= epoch[c]" guard from any Deliver* action is caught.
NoPreEpochAccept ==
  \A c \in Clients : \A p \in acceptedPairs[c] : p[1] >= p[2]

\* --- O8 invariant (6): componentwise truth (T4, valid stale state).
\* Every held cell's (value, lastSeen) equals the server's value for that
\* field at that lineage token, at a token where the record was live;
\* every floor corresponds to a real destroy at its token; knownVersion
\* is a rumor bound on real tokens.  NOT snapshot isolation: cells of one
\* entry may sit at different lastSeen -- deliberately.
ComponentwiseTruth ==
  \A c \in Clients :
    /\ \A f \in Fields :
         cells[c][f].ls > 0 =>
           /\ cells[c][f].ls =< Len(hist)
           /\ LiveAtTok(cells[c][f].ls)
           /\ cells[c][f].val = ValueAt(f, cells[c][f].ls)
    /\ floor[c] > 0 =>
         /\ floor[c] =< Len(hist)
         /\ hist[floor[c]].kind = "destroy"
    /\ known[c] =< Len(hist)

(***************************************************************************)
(* Action properties (checked as PROPERTY -- over every step).             *)
(***************************************************************************)

\* --- O8 invariant (1): no-regression (T2(i)).  lastSeen, floor,
\* knownVersion (and the subscription epoch) never decrease.  The only
\* permitted "drop" of a lastSeen is L3 garbage collection of a DEAD cell
\* (lastSeen <= floor), which never changes interpretation.
NoRegressionStep ==
  \A c \in Clients :
    /\ floor'[c] >= floor[c]
    /\ known'[c] >= known[c]
    /\ epoch'[c] >= epoch[c]
    /\ \A f \in Fields :
         \/ cells'[c][f].ls >= cells[c][f].ls
         \/ (cells'[c][f].ls = 0 /\ cells[c][f].ls =< floor[c])  \* L3 GC only

NoRegression == [][NoRegressionStep]_vars

\* --- O8 invariant (3): "a 304 never freshens a cell the client does not
\* hold" (rejected-predicate (c): If-None-Match: knownVersion, the one
\* forbidden corruption).  Whenever any step advances a lastSeen, either
\* the client already held that cell (a certification of a held value --
\* the M4-304 case), or the step installed the true server value at the
\* new token (a payload merge -- the M1 case).  A 304 carries no value, so
\* a 304 that "freshened" an unheld cell would advance ls without
\* installing the true value and fail both disjuncts.  (Steps that change
\* cells never change hist, so ValueAt below reads the right history.)
No304FreshenStep ==
  \A c \in Clients : \A f \in Fields :
    cells'[c][f].ls > cells[c][f].ls =>
      \/ cells[c][f].ls > 0
      \/ cells'[c][f].val = ValueAt(f, cells'[c][f].ls)

No304Freshen == [][No304FreshenStep]_vars

(***************************************************************************)
(* MODEL-CHECKING RESULTS (TLC).  The jar IS vendored                      *)
(* (specs/tla2tools.jar); run via specs/run-tlc.sh.                        *)
(*                                                                         *)
(* PRE-FIX VIOLATION (the reason for the Apply304 ls >= W guard): with    *)
(* the earlier ls > 0 guard, TLC violates ComponentwiseTruth with an      *)
(* 11-state trace (found at the then-shipped MaxToken = 5 config after    *)
(* ~18 min / 400M generated states; reproduces at MaxToken = 3,           *)
(* MaxEpoch = 2 in ~5 min): create@1,                                     *)
(* write{fa}@2; c1 merges fa=(2,2); IssueValidation P={fa} W=2; server    *)
(* answers 304 V=2 (sound at that instant); SrvDestroy@3; DeliverDest ->  *)
(* floor 3; DropDeadCell(fa) (L3); the stale create frame @1 re-merges    *)
(* fa=(1,1); Apply304 then produced fa=(val 1, ls 2) -- a value-token     *)
(* pair that never existed (T4 violated; invisible -- floor 3 > 2 --      *)
(* but manufactured).  See ambiguity note (2).                            *)
(*                                                                         *)
(* POST-FIX RUNS (atomic-pull revision -- before pulls were made          *)
(* three-phase; TLC 2.19, vendored jar,                                   *)
(* Apple Silicon, 2026-08-27).  Neither run was carried to exhaustion --  *)
(* the reachable space even at the minimum constants is order 10^8        *)
(* distinct states (see the .cfg header) -- but TLC's search is BFS and   *)
(* checks every state as it is generated, so each run covers ALL          *)
(* behaviors up to its frontier depth; the pre-fix violation sits at      *)
(* depth 10 (an 11-state trace):                                          *)
(*   - MaxToken = 3, MaxEpoch = 2 (the pre-fix repro config): NO          *)
(*     violation of any invariant or action property in 140.7M distinct   *)
(*     states (1.37B generated), BFS frontier at depth 16 (every state    *)
(*     reachable in <= 15 steps checked), stopped at 59 min on 6          *)
(*     workers with ~64M states still queued.                             *)
(*   - MaxToken = 3, MaxEpoch = 3 (the shipped constants): NO violation   *)
(*     in 89.8M distinct states (530M generated), frontier at depth 15,   *)
(*     stopped at 17 min on 14 workers.                                   *)
(*                                                                         *)
(* THREE-PHASE-PULL REVISION (this file: pstate + IssuePull /             *)
(* SrvProcessPull / ApplyPullLive / ApplyPullGone / DropPullResponse      *)
(* enabled alongside everything above).  SMOKE RUN ONLY so far            *)
(* (TLC 2.19, vendored jar, Apple Silicon, 14 workers, 2026-08-27,        *)
(* shipped constants MaxToken = 3, MaxEpoch = 3): killed after ~2 min     *)
(* wall.  Last checkpoint at 1 min: 46,196,199 states generated,          *)
(* 10,223,069 distinct, BFS frontier at depth 12 -- i.e. every state      *)
(* reachable in <= 11 steps checked, past the depth-10 pre-fix            *)
(* violation -- with NO violation of any invariant or action property     *)
(* reported at any point before the kill (TLC checks each state/step as   *)
(* generated and halts on violation).  That is ALL this run establishes:  *)
(* the pull actions do not trip TypeOK or any invariant in the early      *)
(* frontier.  Full exhaustion with the pull actions is still an           *)
(* overnight job and has NOT been done: run specs/run-tlc.sh RowLane      *)
(* and let it finish.                                                     *)
(*                                                                         *)
(* MUTATION COVERAGE (why the .cfg says MaxEpoch = 3): replacing          *)
(* DeliverReset's Max2 join with blind assignment epoch' := m.ep -- a     *)
(* real T9(ii) regression: a reordered stale RESET lowers the epoch and   *)
(* re-admits revoked-epoch frames -- is caught by NoRegression in a       *)
(* 5-state trace at MaxEpoch = 3 (two resets to one client, delivered    *)
(* ep-3-then-ep-2) and is UNDETECTABLE at MaxEpoch = 2, where one reset   *)
(* makes assignment and max indistinguishable.                            *)
(***************************************************************************)

(***************************************************************************)
(* WORKED TRACES (hand-walked illustrations of the definitions; kept as    *)
(* documentation.  TLC, not these, is the evidence: the pre-fix violation  *)
(* above is exactly the kind of interleaving hand-walking missed).         *)
(*                                                                         *)
(* ---- Trace 1: the L2 counterexample, {a@10} . D15 . {b@20}, two orders. *)
(* (Proof doc Section 4, "Why rev 2's L2 was false".)  Token mapping:      *)
(* 10 -> 2, 15 -> 3, 20 -> 5.  Fields = {fa, fb}; MaxToken = 5.            *)
(*                                                                         *)
(* Server run: SrvCreate (t1, live{fa,fb}@1), SrvWrite({fa}) (t2,          *)
(* live{fa}@2), SrvDestroy (t3, dest@3), SrvCreate (t4, live{fa,fb}@4      *)
(* -- the pk RE-creation in the same lineage, A1), SrvWrite({fb}) (t5,     *)
(* live{fb}@5).  chan now holds, for client c1: L1 = live({fa,fb},1),      *)
(* L2 = live({fa},2), D3 = dest(3), L4 = live({fa,fb},4),                  *)
(* L5 = live({fb},5), all ep 1, plus signals.  Cw drops L1 and L4 for c1   *)
(* (never delivered) -- exactly the proof doc's three payloads remain.     *)
(*                                                                         *)
(* Order A.D.B  (DeliverLive(c1,L2); DeliverDest(c1,D3);                   *)
(*               DeliverLive(c1,L5)):                                      *)
(*   after L2 : cells fa=(val 2, ls 2), fb absent; floor 0; known 2        *)
(*   after D3 : floor 3 (M2; cells untouched); destroysMerged {3};         *)
(*              fa now DEAD (2 <= 3); known 3                              *)
(*   after L5 : fb=(5,5) (M1: 5 >= -inf); known 5                          *)
(*   final    : (floor 3, fa=(2,2) invisible, fb=(5,5) visible)            *)
(*                                                                         *)
(* Order D.B.A  (DeliverDest(c1,D3); DeliverLive(c1,L5);                   *)
(*               DeliverLive(c1,L2)) -- rev 2's resurrection order:        *)
(*   after D3 : floor 3                                                    *)
(*   after L5 : fb=(5,5)                                                   *)
(*   after L2 : fa=(2,2) admitted into cells (M1: 2 >= -inf) but           *)
(*              INVISIBLE: 2 <= floor 3, and the floor only rises          *)
(*   final    : (floor 3, fa=(2,2), fb=(5,5)) -- identical to A.D.B.       *)
(* Every order of these three payloads joins to the same entry (L2);       *)
(* fa@2 is invisible forever (NoResurrection: visible fb has 5 > 3;        *)
(* fa is not visible).  Rev 2's replaceable tombstone would have shown     *)
(* {fa@2, fb@5} BOTH visible here -- caught by NoResurrection against      *)
(* destroysMerged = {3}.  ComponentwiseTruth holds throughout:             *)
(* ValueAt(fa,2)=2, ValueAt(fb,5)=5, hist[3].kind="destroy".               *)
(*                                                                         *)
(* ---- Trace 2: the destroyed-at-11 stale-304 attempt (A2' rejected       *)
(* predicate (d); Section 2 note under A2').  Token mapping: 10 -> 2,      *)
(* 11 -> 3.                                                                *)
(*                                                                         *)
(* SrvCreate (t1); SrvWrite({fa}) (t2); DeliverLive(c1, live({fa},2)):     *)
(* c1 holds fa=(2,2).  IssueValidation(c1) with P={fa}: W = min lastSeen   *)
(* = 2 (M4 precondition: W computed from held cells).  NOW SrvDestroy      *)
(* (t3).  SrvProcessValidation(c1) evaluates A2' at V = STok = 3:          *)
(* ~Alive, so the answer is gone(3) -- NEVER a 304.  A clause-(i)-only     *)
(* server (last_write(fa)=2 <= W=2) would have answered 304 carrying 3,    *)
(* certifying fa at a token where the record does not exist: that state    *)
(* violates No304AcrossLifecycle (LiveAtTok(3) is FALSE) and, once         *)
(* applied, ComponentwiseTruth (cells fa.ls = 3 with hist[3] a destroy).   *)
(* ApplyGone(c1): floor 3, fa dead.  Correct end state.                    *)
(*                                                                         *)
(* In-flight variant (T3 case L >= V mirrored onto the floor):             *)
(* SrvProcessValidation runs BEFORE the destroy, at V=2 -> "304" P={fa}    *)
(* W=2 V=2 pending; then SrvDestroy (t3) and DeliverDest(c1, dest@3):      *)
(* floor 3.  Apply304(c1): fa passes the per-field guard (ls 2 >= W 2)     *)
(* and joins max(2,2) = 2 -- a no-op; the 304 cannot lift the cell over    *)
(* the floor, and fa stays dead.  All six invariants hold at every step.   *)
(* (Had L3 GC'd fa first -- ls 0 -- or GC'd it and a stale frame           *)
(* re-merged it at 1, the guard skips fa: ls < W = 2.  That branch is the  *)
(* pre-fix violation in the results block above.)                          *)
(*                                                                         *)
(* ---- Trace 3 (epoch filter, brief -- T9/O16): live({fa},2) stamped      *)
(* ep 1 sits undelivered in chan.  SrvReset(c1) -> srvEpoch[c1]=2, reset   *)
(* frame ep 2; DeliverReset(c1) -> epoch[c1]=2.  The stale ep-1 live       *)
(* frame is now permanently undeliverable to c1 (guard m.ep >= epoch[c1]   *)
(* fails): Cw may present it forever, the filter -- not delivery order --  *)
(* excludes it.  acceptedPairs[c1] can only ever gain pairs with           *)
(* p[1] >= p[2] (NoPreEpochAccept).  A duplicated old RESET (ep 2          *)
(* redelivered, or a hypothetical ep-1 reset) cannot lower epoch[c1]:      *)
(* DeliverReset joins via max.                                             *)
(***************************************************************************)

(***************************************************************************)
(* AMBIGUITY NOTES -- the three places where this spec makes a choice the  *)
(* proof doc's text does not fully determine, each justified here.         *)
(*                                                                         *)
(* (1) A slice response does not certify the CLEAN fields of P             *)
(*     (ApplySlice).  The doc's M4 says "On a slice: apply M1", and M1     *)
(*     touches only carried fields; a cleverer client could argue the      *)
(*     clean fields of P were implicitly validated at V (the server        *)
(*     computed the dirty set against W), but the doc does not say so,     *)
(*     and this spec follows the doc's letter.  Cost is only lost          *)
(*     freshness (a later validation re-asks); soundness is unaffected     *)
(*     either way -- fidelity over cleverness.                             *)
(*                                                                         *)
(* (2) A 304 certifies per-field only where lastSeen(f) >= W (Apply304).   *)
(*     The doc's M4 precondition ("the client holds a cell for every       *)
(*     f in P") is an ISSUE-time statement, and rev 3's T3 case L < V      *)
(*     silently assumed W <= L still held at APPLY time.  That holds       *)
(*     without garbage collection (lastSeen is monotone) but L3 GC of a    *)
(*     dead cell followed by a re-merge from a staler Cw frame lowers      *)
(*     lastSeen below W, and an unguarded 304 then stamps the re-merged    *)
(*     old value with V -- a manufactured pair, found by TLC (results      *)
(*     block above).  The A2'(ii)-forced ordering (the GC-enabling         *)
(*     destroy d must satisfy d > V, so floor >= d > V forever) makes the  *)
(*     corrupted cell permanently invisible, so nothing ever rendered      *)
(*     wrong -- but T4 quantifies over sigma, not over what renders.       *)
(*     Resolution: the per-field ls >= W guard, amended into the proof     *)
(*     doc's M4 and T3 (case L < W).  The guard subsumes the earlier       *)
(*     "still holds the cell" reading (ls > 0), since W >= 1 on any        *)
(*     issued request.                                                     *)
(*                                                                         *)
(* (3) Create writes every field (WritesField).  A0/A2 do not literally    *)
(*     say an INSERT writes every column, but a create payload carries     *)
(*     the full slice and defaults are values, so the created snapshot     *)
(*     defines every field; SrvCreate accordingly emits live frames with   *)
(*     flds = Fields.  Without this choice ValueAt(f, v) would be          *)
(*     undefined (0) for a field never explicitly written after a          *)
(*     re-create, and L1 agreement would be vacuous there.                 *)
(***************************************************************************)
=============================================================================
