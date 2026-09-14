# Game definitions

**This is a digital prop box, not a rules engine.** A game definition is an optional
YAML (or JSON — same schema) file a room picks at creation. All it does is declare a
specific game's *pieces* — custom dice, character-sheet tracks, card sets and their
images, board tiles and their connectors — and where they start on the table. It does
**not** describe turns, phases, roles, win conditions, or "when X happens, do Y" rules.
A room with no game definition at all is just as playable — it's a blank table with no
pieces on it yet.

Everything about how a game actually *plays* — whose turn it is, who's secretly what,
when the game ends, what a specific card's text means you should do — is left entirely
to the players and the GM, exactly as it would be at a physical table. The engine's job
is to let people move, flip, hide, stack, and roll physical-feeling objects together
over the network; it is deliberately ignorant of what any of it *means*. See "Why no
rules layer?" near the bottom for why this is the right ceiling, not a shortcut.

## Game packages: portable files, not a server-hosted library

A **game package** is a manifest plus the assets it references — a folder (or a zip of
one) shaped like:

```
my-game/
  manifest.yaml        # everything described in this document
  assets/
    event-back.png
    tiles/kitchen.png
    tiles/catacombs.png
```

The manifest references assets by path within the package (`assets/event-back.png`,
exactly as in the examples below); each is also content-hashed for the P2P transfer
layer (see [NETWORKING.md](NETWORKING.md) "Asset distribution"), so two packages that
happen to reuse the same image never cause a redundant transfer.

There is no server-hosted library to upload a package *into*. An admin picks a package
one of two ways when creating a room: one of the handful of examples bundled with this
repo (`game-defs/`, committed as plain static files — see
[ARCHITECTURE.md](ARCHITECTURE.md)), or a package file from their own computer, which
their browser loads and holds in memory for the room — the server only ever records that
the room uses "a custom package," never its content. Any player can export the room's
current package back out as a file at any time (useful for editing rulebook text in a
plain editor, or handing it to a friend to reuse in their own room) — this is a purely
local operation on whatever's already in the client's memory, not a server request.

## Cards are the workhorse, not "decks"

There is no separate authored "deck" type. A card set is just a list of **Card**
definitions (front content, optional shared back), and a deck is what you get when the
starting layout places several of them at the same table position — they merge into a
**Stack** at runtime, the same way dropping physical cards on top of each other does.
Set `count` on an entry when that card has multiple copies in its starting stack; it
defaults to one.

Image-backed card fronts are rendered in a trading-card layout with a preserved-aspect
art window and readable title/rules bands. Authors may set `image_fit: contain` (the
default, showing the whole image) or `image_fit: cover` to crop the edges and fill the
art window.

Piece and mat entries also accept `count` (default `1`) to place multiple copies during
room setup. Text-only mats are valid; when no dimensions are supplied, they auto-size
to fit their text.

```yaml
cards:
  - set: event          # just a label, for organizing the starting layout
    back: assets/event-back.png
    entries:
      - id: creepy-puppet
        count: 3
        front: { title: "Creepy Puppet", text: "The player on your right rolls..." }
      - id: revolver
        front: { title: "Revolver", text: "An old, potent-looking weapon..." }
```

### Stack operations

Any player can move/rotate/flip/hide any single Card at any time (see ARCHITECTURE.md
"Trust model" in NETWORKING.md — manipulation is unlocked, matching a physical table).
When Cards land on each other they become a Stack, which additionally supports:

| Op | Effect |
|---|---|
| `shuffle` | Randomize the Stack's internal order. Resolved by the **host** (not each client independently) so everyone's view of the resulting order matches — this is a consistency requirement, not just an anti-cheat one. |
| `draw(n, from: top\|bottom\|random)` | Pop card(s) off, turning them back into standalone Cards (or moving them into a Zone — see below) |
| `deal(n, to: [zones])` | Draw-and-distribute in one step, round-robin across targets |
| `cut` | Split into two Stacks at a point, optionally recombine in swapped order |
| `peek` | Reveal the top (or all) card faces to whoever the containing Zone permits, without removing them |

These are the same handful of things a person does with a physical deck; nothing here
knows what any card *means*, only how piles of cards behave. Dragging a single card off
a Stack (grabbing what's on top, or spreading it to pick a specific one) is the same
"pull a Card out" gesture whether or not a game definition is loaded.

## Pieces: board tiles, terrain, and anything else you place rather than stack

A **Piece** is a movable/rotatable object that is not a deck member: a room tile, a
terrain hex, a board section, a standee. The distinction from Card matters because
board-building genuinely behaves differently from a hand of cards: you draw a tile and
*place* it into a growing layout — you never pile two placed tiles on top of each other
the way you'd pile discarded cards. So Pieces never merge into a Stack, even when they
visually overlap (a pawn Token standing on a tile Piece is just an overlap, not a
special object).

A Piece can still start life in a face-down **draw pile** (shuffle/draw work exactly
like a Card Stack), and optionally declares **connectors**, purely as a placement aid —
dragging it near an open connector on an already-placed Piece snaps it into alignment,
the same convenience a jigsaw piece's shape gives you, nothing more:

```yaml
pieces:
  - set: room-tile
    back: assets/tile-back.png
    draw_pile: true                # starts shuffled face-down; a player draws one by hand
    entries:
      - id: kitchen
        front: { image: assets/tiles/kitchen.png }
        connectors: [north, south, east, west]
      - id: catacombs
        front: { image: assets/tiles/catacombs.png }
        connectors: [north]
```

Whether a given placement is *allowed* by the game's actual rules (matching floors, not
sealing off a section, whatever a specific rulebook says) is for the players to judge —
the same as noticing you've placed a physical tile somewhere that doesn't make sense.
Everything else about a Piece is freeform: any player can pick it up, move it, and
rotate it at any time, same as a Card — the only thing that's different from a Card is
the absence of stack/shuffle semantics once it's on the table.

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

A die is just a named face list — not limited to d4/d6/d20. A standard numeric die
(`1d20`, `8d6`, ...) needs no entry here at all: in the roll grammar below, a numeric
die-key is always an implicit standard die (faces `1..N`), the same way dice notation
works everywhere else. This section is for dice a standard number can't express —
Betrayal's non-numeric pip die, a Fate die with negative faces, or overriding a
distribution:

```yaml
dice:
  - key: pip                       # a custom die: 3 blank faces, 2 one-dot, 1 two-dot
    faces: [0, 0, 0, 1, 1, 2]
  - key: fate
    faces: [-1, -1, 0, 0, 1, 1]
```

A **pool** rolls N dice of one type and combines them with an aggregator: `sum` (default),
`count(value_or_predicate)` (count successes, e.g. "count ≥ 4" for a d6 pool), or
`highest(n)`/`lowest(n)` (keep only some dice, e.g. advantage). Pool size N can be a
literal, or driven by a Track's current value (see below) — that one mechanism covers
both "roll 1d20" (literal) and "roll dice equal to your current stat" (track-driven).
This is just a dice tray that also knows how to add up what it rolled — the equivalent
of a player doing their own arithmetic, not the engine deciding what a roll means.

## Tracks

A bounded slider, not a plain number+modifier — the digital equivalent of a physical
stat clip or a counter dial:

```yaml
tracks:
  - key: dex
    label: Dexterity
    values: "8..20"                  # an inclusive range shorthand — see below
    resolve_as: "floor((value - 10) / 2)"   # bare `dex` in a roll → the modifier
    # `.raw` accessor (dex.raw) still gets the score itself
  - key: might
    label: Might
    values: [1, 2, 3, 4, 5]           # or spell it out — either form works
    pool_die: pip                   # bare `might` in a roll → roll `values[current]`
                                     # dice of type `pip`, aggregator `sum`
```

`values` is either an explicit array, or the quoted string `"start..end"` for a
consecutive-integer range — plain YAML/JSON has no native range syntax (`[8..20]`
*without* quotes isn't valid: it parses as one array element, the literal string
`"8..20"`, not an actual range), so this needs to be a string specifically, not a new
bracket notation.

A Track just clamps to its declared range, the way a physical slider can't move past its
printed ends — it has no opinion on what hitting either end *means* for the game (death,
a level-up, whatever a rulebook says); that's for the players to notice and act on, the
same as watching a physical stat clip hit the skull symbol. `resolve_as` and `pool_die`
are two different conveniences for how a bare stat reference expands in the roll grammar
below — a calculator shortcut for arithmetic a player would otherwise do by hand, not
game logic.

## Roll grammar

Used after `/roll` in chat and as any `roll:` value in a macro.

```
expr      := term (("+" | "-") term)*
term      := literal-pool | number | stat-ref
literal-pool := [count] "d" die-key [":" aggregator]
aggregator   := "sum" | "count" COMPARATOR VALUE | "highest" INTEGER | "lowest" INTEGER
stat-ref  := IDENTIFIER ["." "raw"]
```

A bare `stat-ref` expands per its Track's resolution rule (above). Examples:

| Input | Meaning |
|---|---|
| `1d20 + dex` | d20 + Dexterity modifier |
| `2d20:highest1 + str + proficiency` | attack with advantage |
| `might` | roll `might` pip-dice, sum the dots |
| `4d6:lowest1` | ability-score-style roll, drop lowest die |
| `1d6:count>=4` | a "successes" pool, e.g. a Warhammer-style check |

Comparing two rolls to decide a winner, applying damage, deciding whether an attack
"hits" — none of that is part of the grammar. `/roll` prints a number; what it means is,
as ever, up to the people at the table.

## Zones

A named region with a visibility rule, used for hands and discard piles:

```yaml
zones:
  - key: my-hand
    visibility: owner-only        # per-player instance; only its owner sees contents
  - key: discard
    visibility: public
```

That's the whole feature: `public`, `owner-only` (per-player instance), or `owner+host`.
A Zone's contents are only ever sent over the network to the peers allowed to see them
(unicast to the owner, or kept host-side) — see NETWORKING.md. No encryption is needed
for this: the design assumes cooperating players (this project's target is a private
group, not an adversarial one — see NETWORKING.md "Trust model"), so simply not
broadcasting a Zone's contents to non-owners is sufficient, the same way a hidden role
card face-down on the table is "secure" only because everyone agrees not to peek.

A Zone's `owner-only` visibility is this same mechanism formalized for a whole declared
region — a single Card can get the identical treatment ad hoc, with **no Zone or game
definition at all**, via the right-click **Hide** toggle every Card has (see
ARCHITECTURE.md "Hiding a card"). This covers the common hidden-role case completely: a
werewolf/Mafia role card or an Avalon character card is just a Card, dealt face-down,
that its owner Hides — the player knows their own role because they looked at their own
hidden card, the same way they would at a physical table. Anything beyond
"know your own secret" (a physical Avalon table's ritual for evil players to learn who
else is evil, or Merlin learning who's evil) is **not something the engine automates** —
see "Why no rules layer?" below for why, and how the group handles it instead.

### Chat commands

| Command | Effect |
|---|---|
| `/roll <expr>` (alias `/r`) | Evaluate the roll grammar above and post the result, attributed to the sender |
| `/whisper <player> <text>` | A private message, visible only to sender + recipient |
| plain text | An ordinary public chat message |

## Why no rules layer?

An earlier version of this design had a `when X happens, do Y` trigger system, game
phases, an engine-level notion of "roles," win-condition checks, and a way to compute
"which other players does this player secretly know about." All of that got cut, and
it's worth being explicit about why, since it's a meaningfully smaller scope than "a
generic rules engine":

**The goal was never to simulate any specific game — it's to let players move things
around the way they would at a physical table.** A trigger system, however small and
data-only, is still the engine developing an opinion about what a card's text means or
what should happen next. That's a different (and much bigger, and ultimately
unbounded) project from a tabletop's actual missing piece, which is just: *a shared
surface, and physical-feeling objects on it that behave the way their real counterparts
do.* Whose turn it is, what a card's printed text tells you to do, when the game ends,
who's secretly the traitor and what they're allowed to do about it — a GM and a group of
players already handle every bit of that at a physical table with zero digital help
beyond the pieces themselves. Once cards can be moved/flipped/hidden/stacked, dice can be
rolled, and stats can be tracked, the tool has already provided everything a physical
table provides. Anything past that — the trigger vocabulary, phases, computed hidden-role
knowledge — was solving a problem that only exists if the goal is automation, and it
isn't.

Concretely, this means a game like Avalon or Betrayal is fully playable with nothing
this document describes beyond cards/dice/tracks/pieces/zones as plain content:

- Dealing hidden roles = dealing Cards, each player Hides their own.
- "Evil knows evil," "Merlin knows evil" = something the GM arranges by voice/DM/whatever
  the group prefers, the same as the physical ritual (or more simply, since there's no
  paper involved: the GM just tells the relevant players privately). The engine has no
  idea any of this happened, and doesn't need to.
- Turn order, phases, votes, win conditions = the group's own convention, same as always.
- A haunt's special rules, a card's printed effect, an attack's outcome = read by a human,
  applied by a human — tracks and dice are there so that applying it (sliding a stat,
  rolling a pool) doesn't require physical props, not so the engine adjudicates it.

The one place a *little* automation earns its keep without becoming a rules engine is
letting a bare stat name expand into the right dice/formula in `/roll` (Tracks' `resolve_as`
/`pool_die`) — that's arithmetic, not game logic, and it stays.

## Example: minimal generic package (`game-defs/generic-freeform.yaml`)

```yaml
name: "Generic Freeform"
tracks:
  - { key: bonus1, label: "Bonus 1", values: [0,1,2,3,4,5] }
```

For rooms that just want a shared table, a couple of number tracks, and `/roll 1d20`-style
dice (any standard numeric die is implicit — no `dice:` entry needed) — no card sets at all.

## Example: excerpt of a D&D 5e-flavored package (`game-defs/dnd5e-srd.yaml`)

```yaml
name: "D&D 5e (SRD)"
tracks:
  - { key: str, label: Strength, values: "8..20", resolve_as: "floor((value-10)/2)" }
  - { key: dex, label: Dexterity, values: "8..20", resolve_as: "floor((value-10)/2)" }
  - { key: level, label: Level, values: "1..20" }
  - key: proficiency
    label: "Proficiency Bonus"
    formula: "ceil(level.raw / 4) + 1"   # a derived, non-slidable track
macros:
  - { label: "Initiative", roll: "1d20 + dex" }
  - { label: "Attack (Str)", roll: "1d20 + str + proficiency" }
```

This ships as a starting point, not a full SRD implementation — more skills/saves/spell
slots are just more tracks/macros, no engine changes. A macro button is pure UI sugar:
it fills in and runs a `/roll` string, nothing more.

## Design-validation references (not shipped content)

Two real, well-known games were used to pressure-test this scope — checking that "just
give people physical-feeling pieces" is actually enough, without shipping either game's
copyrighted text/art as real data in this repo:

**Betrayal at House on the Hill** — a dynamically-built board, custom (non-d20) dice
whose pool size comes from a stat, stat *tracks* rather than number+modifier, three
separate card sets, and (in the physical game) a mid-game reveal that one player is a
secret traitor with a private booklet. Every one of those is plain content in this
format — custom `dice`, `tracks` with `pool_die`, three `cards` sets, `pieces` with
`connectors` for the room tiles. The traitor reveal is just: the GM deals that player a
face-down "Traitor" Card, which they Hide; the GM (or the traitor, reading their own
booklet) tells the rest of the group what changes, exactly as the physical rulebook
already expects a human to do.

**The Resistance: Avalon** — up to seven roles with different, overlapping knowledge of
each other (evil knows evil; Merlin knows evil except Mordred; Percival knows
{Merlin, Morgana} but not which is which), and a physical ritual whose entire purpose is
letting people learn secrets about *other* players safely without a computer. Dealing
each player a hidden role Card they Hide covers "know your own role" completely. The
cross-player knowledge (evil knowing evil, Merlin knowing evil) is exactly the part this
engine deliberately does not automate — see "Why no rules layer?" above — and the group
arranges it themselves (the GM tells the relevant players privately, which is strictly
easier online than the physical ritual it replaces, not harder).

**Coup** — the cleanest fit of the three, and a good check that the simplification holds:
no board, no dice, just a deck of hidden Influence cards, a per-player coin count, and a
bluffing/challenge layer that's pure conversation. Every mechanic is content the players
operate manually, needing nothing new:

- Two hidden Influence cards per player = two Cards dealt from a shuffled Stack, each
  Hidden by its owner — the same primitive used for every other hidden hand.
- Coins = an ordinary per-player Track (e.g. `values: "0..30"`). "Steal 2 coins" is just
  the two players involved adjusting their own Tracks — Tracks aren't ownership-locked
  any more than Cards are (see NETWORKING.md "Trust model"), so this needs no new
  mechanism, the same as a thief and a mark each moving their own coin pile at a
  physical table. (The physical game's shared bank running out is an edge case this
  design doesn't model at all — not a gap, since enforcing scarcity is exactly the kind
  of rule the engine isn't meant to referee; the group would just notice and handle it.)
- Swapping influence with the deck (the Ambassador's action: draw 2, mix with your hand,
  return 2, reshuffle) = draw 2 Cards from the Stack, Hide them into your existing hand,
  pick which 2 of your 4 to keep, drop the other 2 back onto the Stack, `shuffle`. Exactly
  the Stack operations already defined for every other deck.
- Challenges, blocks, and losing a challenge (flip one of *your own* Influence cards
  face-up, your choice) = ordinary chat plus un-hiding a Card you already own and were
  already the only one able to see. No new mechanism, and no engine involvement in who's
  bluffing or who wins a challenge — that's the entire game, and it's exactly the part
  left to the humans, same as everything else in this document.
- Win condition (only one player has any Influence left) = visible to everyone once
  opponents' last cards are face-up; nothing to track.

Like Betrayal and Avalon, Coup's specific character names, card art, and rules text are
copyrighted, so this stays a design-validation note, not shipped content.
