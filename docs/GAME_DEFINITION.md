# Game definitions

A game definition is an optional YAML (or JSON — same schema) file a room picks at
creation. It describes a specific game's fixed content — card sets, custom dice, tracks,
board layout — and a short list of `when X happens, do Y` triggers for its bookkeeping.
It is layered on top of the object model in [ARCHITECTURE.md](ARCHITECTURE.md); a room
with no game definition at all is still fully playable as a freeform sandbox.

**Design ceiling, stated up front:** this format is data, not a programming language.
It cannot express arbitrary game logic, and that's deliberate — see "Why not just script
it?" at the bottom. What it needs to express is: what the pieces are, how they start out,
and which of the tedious mechanical steps (shuffle, draw, roll, reveal) get automated.
Everything else — the actual judgment calls a specific scenario's rules text asks players
to make — stays with the players, the same way it would at a physical table.

## Cards are the workhorse, not "decks"

There is no separate authored "deck" type. A card set is just a list of **Card**
definitions (front content, optional shared back), and a deck is what you get when the
starting layout places several of them at the same table position — they merge into a
**Stack** at runtime, the same way dropping physical cards on top of each other does.

```yaml
cards:
  - set: event          # a tag, not a type — used to filter/target a stack
    back: assets/event-back.png
    entries:
      - id: creepy-puppet
        front: { title: "Creepy Puppet", text: "The player on your right rolls..." }
      - id: revolver
        front: { title: "Revolver", text: "An old, potent-looking weapon..." }
```

### Stack operations

Any player can move/rotate/flip any single Card at any time (see ARCHITECTURE.md
"Trust model" in NETWORKING.md — manipulation is unlocked, matching a physical table).
When Cards land on each other they become a Stack, which additionally supports:

| Op | Effect |
|---|---|
| `shuffle` | Randomize the Stack's internal order. Resolved by the **host** (not each client independently) so everyone's view of the resulting order matches — this is a consistency requirement, not just an anti-cheat one. |
| `draw(n, from: top\|bottom\|random)` | Pop card(s) off, turning them back into standalone Cards (or moving them into a Zone — see below) |
| `deal(n, to: [zones])` | Draw-and-distribute in one step, round-robin across targets |
| `cut` | Split into two Stacks at a point, optionally recombine in swapped order |
| `peek` | Reveal the top (or all) card faces to whoever the containing Zone permits, without removing them |

Dragging a single card off a Stack (grabbing what's on top, or spreading it to pick a
specific one) is the same "pull a Card out" gesture whether or not a game definition is
loaded — a freeform room and a defined one use identical mechanics here. This merge/split
behavior is specific to Cards — see **Pieces** below for board-building objects, which
deliberately don't work this way.

## Pieces: board tiles, terrain, and anything else you place rather than stack

A **Piece** is a movable/rotatable object that is not a deck member: a room tile, a
terrain hex, a board section, a standee. The distinction from Card matters because
Betrayal-style board-building genuinely behaves differently from a hand of cards: you
draw a tile and *place* it into a growing layout — you never pile two placed tiles on top
of each other the way you'd pile discarded cards. So Pieces never merge into a Stack, even
when they visually overlap (a pawn Token standing on a tile Piece is just an overlap, not
a special object).

A Piece can still start life in a face-down **draw pile** (shuffle/draw work exactly like
a Card Stack), and optionally declares **connectors** so placing it snaps it edge-to-edge
onto an open connector of whatever's already on the board:

```yaml
pieces:
  - set: room-tile
    back: assets/tile-back.png
    draw_pile: true                # starts shuffled face-down; draw() to place one
    entries:
      - id: kitchen
        front: { image: assets/tiles/kitchen.png }
        tags: [floor:ground]        # which draw pile(s) this can come from
        connectors: [north, south, east, west]
        symbol: event                # placing this tile auto-draws from the "event" card set
      - id: catacombs
        front: { image: assets/tiles/catacombs.png }
        tags: [floor:basement]
        connectors: [north]
        barrier: true                # two-part room; crossing needs a trait roll (see triggers)
board:
  prevent_disconnection: true        # opt-in engine rule: don't allow a placement that
                                      # seals a section off with no remaining connector
```

Everything else about a Piece is freeform: any player can pick it up, move it, and rotate
it at any time, same as a Card — the only thing that's different is the absence of
stack/shuffle semantics once it's on the table.

## Tokens

Small markers that cycle between named states instead of a free flip — a player pawn, a
"stunned" flip-marker, an item-pile flag:

```yaml
tokens:
  - id: pawn
    states: [active]
    per-actor: true          # one instance created per Actor, colored to match
  - id: monster-marker
    states: [active, stunned]
  - id: item-pile
    states: [visible]
```

## Dice

A die is just a named face list — not limited to d4/d6/d20:

```yaml
dice:
  - key: pip                       # Betrayal's custom die: 3 blank, 2 one-dot, 1 two-dot
    faces: [0, 0, 0, 1, 1, 2]
  - key: d6
    sides: 6                       # shorthand for faces: [1..6]
  - key: fate
    faces: [-1, -1, 0, 0, 1, 1]
```

A **pool** rolls N dice of one type and combines them with an aggregator: `sum` (default),
`count(value_or_predicate)` (count successes, e.g. "count ≥ 4" for a d6 pool), or
`highest(n)`/`lowest(n)` (keep only some dice, e.g. advantage). Pool size N can be a
literal, or driven by a Track's current value (see below) — that one mechanism covers
both "roll 1d20" (literal) and "roll dice equal to your current Might" (track-driven)
without special-casing either game.

## Tracks

A bounded position, not a plain number+modifier — this is what a D&D ability score and a
Betrayal trait have in common, even though they resolve completely differently:

```yaml
tracks:
  - key: dex
    label: Dexterity
    values: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
    resolve_as: "floor((value - 10) / 2)"   # bare `dex` in a roll → the modifier
    # `.raw` accessor (dex.raw) still gets the score itself
  - key: might
    label: Might
    values: [1, 2, 3, 4, 5]
    death_below_min: haunt          # only fatal once the "haunt" phase is active
    allow_overflow: true            # an item can push current past the printed max;
                                     # losing that item removes only the overflow amount
    pool_die: pip                   # bare `might` in a roll → roll `values[current]`
                                     # dice of type `pip`, aggregator `sum`
```

`resolve_as` and `pool_die` are two different ways a bare stat reference can resolve in
the roll grammar below; a track picks whichever (or neither) matches how the game
actually uses it. Both the D&D-style "score → modifier" pattern and the Betrayal-style
"stat → dice pool size" pattern are the *same* Track primitive with a different resolution
rule — no per-game engine code either way.

## Roll grammar

Used after `/roll` in chat and as any `roll:` value in a trigger or macro.

```
expr      := term (("+" | "-") term)*
term      := literal-pool | number | stat-ref
literal-pool := [count] "d" die-key [":" aggregator]
aggregator   := "sum" | "count" COMPARATOR VALUE | "highest" INTEGER | "lowest" INTEGER
stat-ref  := IDENTIFIER ["." "raw"]
```

A bare `stat-ref` expands per its Track's resolution rule: a formula-resolved Track
becomes a number; a pool-die Track becomes `literal-pool` with that track's current value
as the count. Examples:

| Input | Game | Meaning |
|---|---|---|
| `1d20 + dex` | D&D-style | d20 + Dexterity modifier |
| `2d20:highest1 + str + proficiency` | D&D-style | attack with advantage |
| `might` | Betrayal-style | roll `might` pip-dice, sum the dots (a Trait Roll) |
| `4d6:lowest1` (dropped) | either | ability-score-style roll, drop lowest |
| `1d6:count>=4` | generic | a "successes" pool, e.g. a Warhammer-style check |

Opposed rolls (Betrayal's combat: both sides roll their pool, higher wins, damage =
difference) aren't part of the expression grammar — they're a built-in **trigger action**,
`contest(a, b)`, described below, since "who wins and what happens" is a resolution
pattern, not an arithmetic one.

## Zones

A named region with a visibility rule, used for hands, secret roles, and discard piles:

```yaml
zones:
  - key: my-hand
    visibility: owner-only        # per-player instance; only its owner sees contents
  - key: traitors-tome
    visibility: owner-only        # revealed to whoever holds the "traitor" role at runtime
  - key: discard
    visibility: public
```

A Zone's contents are only ever sent over the network to the peers allowed to see them
(unicast to the owner, or kept host-side) — see NETWORKING.md. No encryption is needed
for this: the design assumes cooperating players (this project's target is a private
group, not an adversarial one — see NETWORKING.md "Trust model"), so simply not
broadcasting a Zone's contents to non-owners is sufficient, the same way a hidden role
card face-down on the table is "secure" only because everyone agrees not to peek.

## Phases, turn order, and triggers

```yaml
phases:
  - key: exploration
    default: true
    turn_order: round-robin(explorers)
  - key: haunt
    turn_order: sequence([round-robin(heroes), single(traitor), single(traitor.monsters)])

triggers:
  - when: enter-tile
    if: "tile.symbol != null"
    do: [draw: { set: "{{tile.symbol}}", to: table-faceup }]

  - when: draw-card
    if: "card.set == 'omen'"
    do: [roll: { pool: "6d6", if_lte: omens_drawn_count, then: [trigger: haunt-roll-success] }]

  - when: haunt-roll-success
    do:
      - switch-phase: haunt
      - assign-role: { role: traitor, target: "lookup(haunt-chart, last_omen, current_room)" }
      - reveal-zone: { zone: traitors-tome, to: role(traitor) }
      - reveal-zone: { zone: secrets-of-survival, to: not(role(traitor)) }
```

The action vocabulary is intentionally small and fixed: `draw`, `roll`, `contest`,
`move-token`, `set-track`, `switch-phase`, `assign-role`, `reveal-zone`. A trigger is
`when` (an event the engine already emits: enter-tile, draw-card, roll-result, turn-start,
...) + optional `if` (a boolean expression over visible state) + `do` (a list of those
actions). This covers the mechanical bookkeeping a rulebook is full of; it does not try
to cover a specific scenario's unique narrative logic (see below).

## Worked example: enough of Betrayal at House on the Hill to prove the model

This isn't a full implementation of all 50 haunts — see "Why not just script it?" — but
it shows every one of Betrayal's unusual mechanics maps onto the primitives above with no
new engine concepts:

| Betrayal mechanic | How it maps |
|---|---|
| Custom pip dice, pool size = current stat | `dice: [{key: pip, faces: [0,0,0,1,1,2]}]` + `tracks[].pool_die: pip` |
| Traits are a track you slide, with a death floor and item overflow | `tracks[].values`, `death_below_min: haunt`, `allow_overflow: true` |
| Board built live from a tile stack, per floor | `pieces[].set: room-tile` with `tags: [floor:*]`; drawing = pulling the top tile off the (per-floor-filtered) draw pile and placing it, connector-to-connector; placed tiles never re-stack |
| A floor can't be sealed off by a bad placement | `board.prevent_disconnection: true` — a generic board-graph rule, not Betrayal-specific |
| Event/Item/Omen decks | Three `cards[].set` groups; each starts as a shuffled Stack; `draw` trigger action per entry symbol |
| Haunt roll → mid-game rule change | `switch-phase` trigger action, changing `turn_order` for the rest of the game |
| Traitor gets a secret rulebook | `reveal-zone` to `role(traitor)` only — a Zone the other players' clients never receive |
| Opposed attack rolls | `contest(attacker_pool, defender_pool)` trigger action, difference = damage |
| A specific haunt's unique win condition and special powers | **Not encoded as triggers.** The `reveal-zone` for that haunt's booklet page is just text — the traitor reads it and the group plays it out manually, exactly as the physical rulebook expects. The engine automates *getting the right secret to the right player at the right time*; it doesn't try to referee 50 bespoke scenarios. |

## Why not just script it?

A general scripting layer (à la Tabletop Simulator's per-game Lua) could express
Betrayal's full 50 haunts, but at a real cost: it's a sandboxing/security problem for
uploaded, untrusted rulesets, and it's a huge surface to build and maintain for a benefit
most games don't need. The alternative embraced here is the same one physical tabletop
games already rely on: automate the *mechanical* bookkeeping (shuffle, draw, roll, track
math, who-sees-what) and trust the players to read and apply the rest, the same way they
would with a physical rulebook or a haunt booklet. Given the target use case is a
cooperating private group (see NETWORKING.md "Trust model"), that's not a compromise
forced by security — it's how these games are actually designed to be played. If a
specific game later needs more automation than triggers can express, the escape hatch is
a bigger trigger vocabulary (more built-in actions), not a general-purpose scripting
language.

## Example: minimal generic ruleset (`game-defs/generic-freeform.yaml`)

```yaml
name: "Generic Freeform"
tracks:
  - { key: bonus1, label: "Bonus 1", values: [0,1,2,3,4,5] }
dice:
  - { key: d20, sides: 20 }
```

For rooms that just want a shared table, a couple of number tracks, and dice — no card
sets, no triggers.

## Example: excerpt of a D&D 5e-flavored ruleset (`game-defs/dnd5e-srd.yaml`)

```yaml
name: "D&D 5e (SRD)"
tracks:
  - { key: str, label: Strength, values: [8..20], resolve_as: "floor((value-10)/2)" }
  - { key: dex, label: Dexterity, values: [8..20], resolve_as: "floor((value-10)/2)" }
  - { key: level, label: Level, values: [1..20] }
  - key: proficiency
    label: "Proficiency Bonus"
    formula: "ceil(level.raw / 4) + 1"   # a derived, non-slidable track
dice:
  - { key: d20, sides: 20 }
macros:
  - { label: "Initiative", roll: "1d20 + dex" }
  - { label: "Attack (Str)", roll: "1d20 + str + proficiency" }
```

This ships as a starting point, not a full SRD implementation — more skills/saves/spell
slots are just more tracks/macros, no engine changes.
