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
| Relay fallback | Same signaling WebSocket, message-relayed | Only while P2P is unreachable for a given peer | Substitutes for game sync when WebRTC connection setup fails |

## Signaling protocol (over the WS)

JSON messages, one `type` field each. The server only routes these by room + target
peer id — it never inspects `sdp`/`candidate`/`snapshot` payloads.

```
→ hello            { name }                        client → server, on connect
← welcome          { peerId, hostPeerId|null, roomInfo }
← peer-joined       { peerId, name }                broadcast to existing peers
← peer-left         { peerId }
→ offer / ← offer   { to, from, sdp }                relayed verbatim
→ answer / ← answer { to, from, sdp }
→ ice / ← ice        { to, from, candidate }
→ promote-ack       { }                              new host confirms it has taken over
← you-are-host      { snapshot|null }                server tells a peer it's now host
→ snapshot          { blob }                         host → server, periodic + on major change
→ relay / ← relay    { to, payload }                 opaque game-sync fallback (see below)
```

Flow for a new joiner:

1. Client opens the WS, sends `hello`.
2. Server replies `welcome` with the current host's peer id (or `null` if the room is
   empty — this client becomes host) and the room's game definition, if any.
3. If there's a host: joiner creates an `RTCPeerConnection`, sends `offer` addressed to
   the host; server relays it; host replies `answer`; both sides trickle `ice`.
4. Once the data channel opens, the host pushes a full state snapshot directly over it.
   The signaling WS then only carries presence and future ICE restarts.

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

1. Server picks the peer with the oldest `peer-joined` timestamp still connected as the
   candidate, sends it `you-are-host` with the last snapshot the old host uploaded.
2. That client promotes its local WebRTC role (it already has direct connections to no
   one — peers were only ever connected to the old host — so it must re-signal fresh
   offers to every other currently-connected peer). Server broadcasts the new host id so
   remaining peers initiate offers to it.
3. New host resumes from the snapshot (possibly seconds stale — anything the old host
   hadn't flushed yet is lost). Sends `promote-ack`.
4. If no snapshot exists yet (host left within seconds of room creation), the new host
   starts a fresh empty state.

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
