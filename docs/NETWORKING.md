# Networking: signaling, sync model, recovery

## Topology: host-authoritative star, not full mesh

Every peer connects directly to the **host** over one WebRTC data channel each — a star,
not an N² mesh. This is simpler (N connections instead of N(N-1)/2), matches "the GM is
the source of truth" naturally, and keeps bandwidth on the host predictable (a VTT map
session tops out around 4-8 players in practice).

- The host holds canonical table state in memory: every Card/Piece/Token's position,
  rotation and face state, Stacks, Track values, Zone contents, and the chat/roll log.
- Players send **input actions** to the host (move/rotate/flip a card or piece, shuffle
  or draw a stack, edit a track, post chat, roll) over their data channel.
- The host validates/applies the action and **broadcasts the resulting state delta** to
  every connected player (including an echo back to the sender).
- Players render whatever the host broadcasts; they never mutate shared state locally
  without host confirmation. (Client-side prediction for token drag is a local rendering
  nicety, not a trust boundary — see "Trust model" below.)

## Transport layers

| Layer | Transport | Lifetime | Purpose |
|---|---|---|---|
| Signaling | WebSocket to FastAPI, `/ws/room/{slug}` | Duration of the tab's room membership | Presence, SDP/ICE exchange, host election, recovery snapshot upload |
| Game sync | WebRTC `RTCDataChannel` (unordered/unreliable for cursor/drag ticks, ordered/reliable for actions & chat — two channels per peer) | Duration of the P2P session | Actual gameplay: tokens, chat, rolls, sheets |
| Asset transfer | WebRTC `RTCDataChannel`, binary, chunked | Once per joining peer, up front | The game package (rules + every image) — see "Asset distribution" below. Never touches the server. |
| Relay fallback | Same signaling WebSocket, message-relayed | Only while P2P is unreachable for a given peer | Substitutes for game sync (and asset transfer) when WebRTC connection setup fails |

## Asset distribution

A room's rules plus every card/tile/token/board image they use never touch the server
(see [GAME_DEFINITION.md](GAME_DEFINITION.md) "Game packages" and
[ARCHITECTURE.md](ARCHITECTURE.md) principle 6) — but only a **custom** package (one an
admin loaded from a local file rather than picking a bundled example) actually needs P2P
transfer at all. A **bundled** package (one of the examples shipped with the server,
e.g. `game-defs/poker-5-card-draw.yaml`) is just a static file every peer fetches for
itself, identically, with no game-specific content ever flowing peer to peer.

For a custom package (net/packageTransfer.ts's `PackageDistributor`):

- Images are already embedded in the package as data: URIs (see GAME_DEFINITION.md /
  D14) rather than separate files, so "asset transfer" and "package transfer" are the
  same operation: the whole package, serialized to JSON, chunked, and sent — well under
  a data channel's practical per-message size ceiling per chunk — to whoever doesn't
  already have it.
- **The package is sent as soon as it's asked for.** A joining peer that doesn't already
  hold the package locally (see roomPackageChoice.ts — the picker's own browser skips
  this whole path) requests it from whoever's currently host; the host answers
  immediately if its own package is already loaded, or once it becomes available if not
  (e.g. a newly-promoted host still finishing its own reassembly from the *previous*
  host).
- Whoever finishes reassembling a package this way is immediately ready to serve it to
  someone else too — including if they're later promoted to host themselves (see "Host
  migration" below) — since receiving one and being asked for one both just mean "I now
  have (or don't yet have) the content," regardless of current host/peer role.
- This deliberately rides the *same* link as table-sync traffic rather than a second,
  dedicated data channel — see [DECISIONS.md](DECISIONS.md) D17 for why, and for the
  content-hash caching this intentionally doesn't build for v1 (a nice-to-have, not
  required for a working v1).
- A custom package exists only in whichever browsers currently hold it — there's no
  server copy to fall back to. If every peer who ever held it leaves, the package is
  gone unless someone exported it back out as a file first (see GAME_DEFINITION.md "Game
  packages"). This is an accepted consequence of keeping the server genuinely
  asset-free, not an oversight.

## Signaling protocol (over the WS)

JSON messages, one `type` field each. The server only routes these by room + target
peer id — it never inspects `sdp`/`candidate`/`snapshot` payloads.

```
→ hello            { name, ownerSessionToken? }     client → server, on connect;
                                                      ownerSessionToken present only when
                                                      this tab is logged in as the room's
                                                      owning account
← welcome          { peerId, hostPeerId|null, gmPeerId|null, roomInfo }
← peer-joined       { peerId, name, isGM }          broadcast to existing peers
← peer-left         { peerId }
→ offer / ← offer   { to, from, sdp }                relayed verbatim
→ answer / ← answer { to, from, sdp }
→ ice / ← ice        { to, from, candidate }
→ promote-ack       { }                              new host confirms it has taken over
← you-are-host      { snapshot|null }                server tells a peer it's now host
← host-changed      { hostPeerId }                   broadcast to survivors, excluding the new host
→ snapshot          { blob }                         host → server, periodic + on major change
→ relay / ← relay    { to, payload }                 opaque game-sync fallback (see below)
```

Flow for a new joiner:

1. Client opens the WS, sends `hello`.
2. Server replies `welcome` with the current host's peer id (`null` only if the room is
   empty — this client becomes host) and the room's game definition, if any. If this
   joiner is the room's GM and someone else was already host, `hostPeerId` in this same
   `welcome` is already the joiner's own id — see "Host election" below — and every
   already-connected peer separately receives `host-changed`.
3. If this client isn't host: it creates an `RTCPeerConnection`, sends `offer` addressed
   to the host; server relays it; host replies `answer`; both sides trickle `ice`.
4. Once the data channel opens, the host pushes a full state snapshot directly over it.
   The signaling WS then only carries presence and future ICE restarts.

## Host election

The room's creator is always its host when connected — see
[DECISIONS.md](DECISIONS.md) D13. Concretely, on every join (`RoomState.elect_host_on_join`
in app/signaling.py):

- An empty room: the joiner becomes host, GM or not (someone has to, and a room no one
  has opened yet has nothing to protect by waiting).
- A room with an existing host, joiner is not the GM: nothing changes — they connect to
  the current host like any other peer, exactly as "Flow for a new joiner" above
  describes.
- A room with an existing host who isn't the GM, joiner *is* the GM: hosting moves to
  the joiner immediately. They get `you-are-host` (with whatever snapshot the previous
  host had most recently uploaded, same as a disconnect-triggered migration) instead of
  connecting out to anyone; every other already-connected peer gets `host-changed` and
  re-signals a fresh offer to the GM.
- A room where the GM is already host: joining doesn't disturb anything, GM or not.

This makes join-time promotion the mirror image of "Host migration" below (a join
instead of a disconnect triggers it), and the two share a peer id once the GM has ever
connected: `pick_next_host`'s temporary replacement only ever holds the role until the
GM's next join.

## GM attestation

Every other flag in this protocol is peer-asserted (a client says its own display name,
its own SDP) and the server just relays it — but `isGM`/`gmPeerId` is the one exception:
the **server** decides it, by checking whether the connecting session belongs to the
room's `owner_user_id`, the same way it already knows who owns the room for the admin
dashboard. A peer cannot claim GM status itself; the flag only ever arrives *from* the
server in `welcome`/`peer-joined`, never asserted in `hello`.

The host applies this the same way it applies any other fact broadcast over signaling:
before executing a GM-gated input action (`spawn`, `despawn`, or an unowned peek — see
ARCHITECTURE.md "Roles: GM vs. players"), it checks the sender's
peer id against the `gmPeerId` it was told. This is enforcement by
convention between cooperating peers, not a cryptographic guarantee — consistent with
this whole design's trust model (a malicious host could ignore the check, but that's
already out of scope; see "Trust model" below). What the server *is* trusted for here is
narrow and specific: correctly identifying which peer, if any, is logged in as the room's
owner — not adjudicating anything about gameplay itself.

## Relay fallback (no TURN server required)

Symmetric NAT can prevent direct WebRTC connectivity even with STUN. Rather than
operating a TURN server (which server-watcher's no-root, no-Docker host can't run —
see [DECISIONS.md](DECISIONS.md) D3), a peer whose data channel fails to open within a
timeout falls back to relaying game-sync messages through the same signaling WebSocket:
the server forwards opaque `relay` payloads between that peer and the host, byte for
byte, without parsing them. From the app layer's point of view it's the same protocol,
just tunneled through the server instead of a data channel — slower and it costs the
server bandwidth, but it's a pure fallback path, not the common case, and needs no
extra infrastructure.

## Host migration

If the host's WS disconnects:

1. Server picks a promotion candidate — a *different* connected GM peer if one somehow
   exists, otherwise whoever has the oldest `peer-joined` timestamp still connected —
   and sends it `you-are-host` with the last snapshot the old host uploaded. If the
   disconnecting host was the GM (the normal case per D13/"Host election" above), this
   promotion is only ever temporary: the moment the GM reconnects, join-time election
   hands hosting straight back to them. GM-gated actions work the same regardless of who
   currently holds the role in the meantime, since the current host just checks
   `gmPeerId` before applying one — see "GM attestation" above.
2. That client promotes its local WebRTC role (it already has direct connections to no
   one — peers were only ever connected to the old host — so it must re-signal fresh
   offers to every other currently-connected peer). Server broadcasts the new host id so
   remaining peers initiate offers to it.
3. New host resumes from the snapshot (possibly seconds stale — anything the old host
   hadn't flushed yet is lost). Sends `promote-ack`.
4. If no snapshot exists yet (host left within seconds of room creation), the new host
   starts a fresh empty state.

This also covers a room going fully empty for a while (e.g. the sole player reloading
or briefly closing their tab) and then being reopened: the server keeps the last
snapshot around rather than clearing it just because `state.peers` was momentarily
empty, so reopening the room resumes from it the same way a live handoff would, not a
blank table. The snapshot only ever really disappears if the server process itself
restarts (it's in-memory only, per D14 — no game state is written to disk).

This means a mid-session host disconnect costs a brief reconnect pause and up to a few
seconds of the most recent state, not the whole session — acceptable for a tabletop game,
and avoids needing the server to understand game state to reconstruct it.

## Trust model (explicit design assumption, not just a tradeoff)

This system is built for a private, cooperating group — the same trust level as sitting
around a physical table — and that assumption is load-bearing for several design choices,
not an afterthought:

- The host's client is trusted completely — it's normally the GM's/first player's own
  browser, and every other peer trusts what it broadcasts.
- Any player can move/rotate/flip any Card, Piece, or Token at any time — there's no
  per-object ownership lock to enforce "only you may touch your own cards." A physical
  table doesn't enforce that either; the group does, socially, and that's assumed to
  carry over.
- Roll results are computed on the roller's client and sent as a fait accompli
  (`"rolled might → [1,0,2] = 3"`) rather than the host re-rolling; the host/other peers
  just display them.
- **Secret Zones need no cryptography.** A Zone's contents are only ever sent, over the
  data channel, to the peer(s) its visibility rule allows (unicast to the owner, or kept
  host-side and never forwarded at all) — never broadcast-then-hidden-by-the-UI. Given
  cooperating players, "the network message simply never arrives" is exactly as private
  as a physical secret role card turned face down; there's no adversary model where a
  peer would sniff another peer's WebRTC traffic to cheat.
- This is not suitable as-is for adversarial/tournament play, where a malicious client
  could fake a roll or peek at another peer's traffic. That's out of scope by design, not
  an oversight — see [GAME_DEFINITION.md](GAME_DEFINITION.md) "Why not just script it?"
  for the same principle applied to rules enforcement. If host-arbitrated rolls are ever
  needed for a specific room, the protocol already supports it (roll becomes an "input
  action" the host resolves instead of an assertion) — just not the default, to keep
  rolls feeling instant and not host-bandwidth-bound.
