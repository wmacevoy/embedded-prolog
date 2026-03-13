// ============================================================
// Adventure Game Knowledge Base
//
// "The Obsidian Tower" — a small text adventure driven entirely
// by Prolog inference.  The world state lives in the clause
// database via assert/retract.  The UI queries the engine for
// descriptions, available actions, and processes commands.
// ============================================================

import { loadString } from "../../src/loader.js";

const ADVENTURE_KB = `
% ============================================
% The Obsidian Tower — Adventure in Prolog
% ============================================

% --- Room descriptions (static facts) ---
room_desc(courtyard, 'A crumbling courtyard. Moonlight catches on shattered flagstones. A massive obsidian tower looms to the north. An iron gate bars the way east.').
room_desc(tower_base, 'The base of the tower. Spiral stairs wind upward into darkness. Strange glyphs pulse faintly on the walls. A doorway leads south to the courtyard.').
room_desc(tower_top, 'The top of the tower. Wind howls through empty windows. A stone pedestal stands in the center, covered in dust. Stairs lead down.').
room_desc(garden, 'An overgrown garden behind a rusted iron gate. Phosphorescent mushrooms glow among the weeds. A stone well sits in the corner. The courtyard is to the west.').
room_desc(well_chamber, 'You descend into the well. Cool air rises. A narrow tunnel leads into a hidden chamber. Jewels glitter in the walls. A ladder leads up to the garden.').

% --- Connections (bidirectional) ---
connection(courtyard, north, tower_base).
connection(tower_base, south, courtyard).
connection(tower_base, up, tower_top).
connection(tower_top, down, tower_base).
connection(courtyard, east, garden).
connection(garden, west, courtyard).
connection(garden, down, well_chamber).
connection(well_chamber, up, garden).

% --- Items (static descriptions) ---
item_desc(rusty_key, 'A heavy iron key, flecked with rust.').
item_desc(crystal_orb, 'A shimmering crystal orb that hums with inner light.').
item_desc(old_scroll, 'A brittle scroll. The text reads: ''Place the orb upon the pedestal to open the way.''').
item_desc(glowing_gem, 'A gem that pulses with deep violet light. It feels warm.').

% --- Dynamic state (initial assertions) ---
player_at(courtyard).
item_at(rusty_key, tower_base).
item_at(old_scroll, tower_top).
item_at(crystal_orb, well_chamber).
item_at(glowing_gem, garden).
locked(garden).

% --- NPC ---
npc_at(raven, tower_top).
npc_desc(raven, 'A large raven perches on the windowsill, watching you with knowing eyes.').

% --- NPC dialogue (context-sensitive) ---
npc_talk(raven, 'The raven caws: ''You found it! The orb... place it on the pedestal. Quickly, before the tower sleeps again.''') :-
    holding(crystal_orb).
npc_talk(raven, 'The raven tilts its head: ''The scroll speaks of the deep places. Have you tried the well in the garden?''') :-
    holding(old_scroll), not(holding(crystal_orb)).
npc_talk(raven, 'The raven caws: ''Seek the key. The garden holds secrets beneath.''') :-
    not(holding(old_scroll)), not(holding(crystal_orb)).

% --- Rules ---
items_here(Room, Items) :-
    findall(I, item_at(I, Room), Items).

npcs_here(Room, NPCs) :-
    findall(N, npc_at(N, Room), NPCs).

exits(Room, Dirs) :-
    findall(D, connection(Room, D, _To), Dirs).

inventory(Items) :-
    findall(I, holding(I), Items).

can_go(Dir, Dest) :-
    player_at(Here),
    connection(Here, Dir, Dest),
    not(locked(Dest)).

can_go_locked(Dir, Dest) :-
    player_at(Here),
    connection(Here, Dir, Dest),
    locked(Dest).

% --- Actions ---
do_go(Dir) :-
    can_go(Dir, Dest),
    player_at(Here),
    retract(player_at(Here)),
    assert(player_at(Dest)).

do_take(Item) :-
    player_at(Here),
    item_at(Item, Here),
    retract(item_at(Item, Here)),
    assert(holding(Item)).

do_drop(Item) :-
    holding(Item),
    player_at(Here),
    retract(holding(Item)),
    assert(item_at(Item, Here)).

do_unlock(Dir) :-
    holding(rusty_key),
    player_at(Here),
    connection(Here, Dir, Dest),
    locked(Dest),
    retract(locked(Dest)).

do_use_orb() :-
    player_at(tower_top),
    holding(crystal_orb),
    retract(holding(crystal_orb)),
    assert(orb_placed()).

game_won() :- orb_placed().
`;

export function buildAdventureKB(PrologEngine) {
  const engine = new PrologEngine();
  loadString(engine, ADVENTURE_KB);
  return engine;
}

// ── Prolog source for display ──────────────────────────────
export const ADVENTURE_PROLOG_SOURCE = ADVENTURE_KB;
