// ============================================================
// Adventure Game Knowledge Base
//
// "The Obsidian Tower" — a text adventure driven by
// ephemeral/react. Commands are events, reactions are game logic.
// ============================================================

export const ADVENTURE_KB = `
% ============================================
% The Obsidian Tower — Adventure in Prolog
% ============================================

% --- Room descriptions ---
room_desc(courtyard, 'A crumbling courtyard. Moonlight catches on shattered flagstones. A massive obsidian tower looms to the north. An iron gate bars the way east.').
room_desc(tower_base, 'The base of the tower. Spiral stairs wind upward into darkness. Strange glyphs pulse faintly on the walls. A doorway leads south to the courtyard.').
room_desc(tower_top, 'The top of the tower. Wind howls through empty windows. A stone pedestal stands in the center, covered in dust. Stairs lead down.').
room_desc(garden, 'An overgrown garden behind a rusted iron gate. Phosphorescent mushrooms glow among the weeds. A stone well sits in the corner. The courtyard is to the west.').
room_desc(well_chamber, 'You descend into the well. Cool air rises. A narrow tunnel leads into a hidden chamber. Jewels glitter in the walls. A ladder leads up to the garden.').

% --- Connections ---
connection(courtyard, north, tower_base).
connection(tower_base, south, courtyard).
connection(tower_base, up, tower_top).
connection(tower_top, down, tower_base).
connection(courtyard, east, garden).
connection(garden, west, courtyard).
connection(garden, down, well_chamber).
connection(well_chamber, up, garden).

% --- Items ---
item_desc(rusty_key, 'A heavy iron key, flecked with rust.').
item_desc(crystal_orb, 'A shimmering crystal orb that hums with inner light.').
item_desc(old_scroll, 'A brittle scroll. The text reads: Place the orb upon the pedestal to open the way.').
item_desc(glowing_gem, 'A gem that pulses with deep violet light. It feels warm.').

% --- Initial state ---
player_at(courtyard).
item_at(rusty_key, tower_base).
item_at(old_scroll, tower_top).
item_at(crystal_orb, well_chamber).
item_at(glowing_gem, garden).
locked(garden).

% --- NPC ---
npc_at(raven, tower_top).
npc_desc(raven, 'A large raven perches on the windowsill, watching you with knowing eyes.').

npc_talk(raven, 'The raven caws: The orb... place it on the pedestal. Quickly!') :-
    holding(crystal_orb).
npc_talk(raven, 'The raven tilts its head: The scroll speaks of the deep places. Try the well.') :-
    holding(old_scroll), not(holding(crystal_orb)).
npc_talk(raven, 'The raven caws: Seek the key. The garden holds secrets beneath.') :-
    not(holding(old_scroll)), not(holding(crystal_orb)).

% --- Queries ---
items_here(Room, Items) :- findall(I, item_at(I, Room), Items).
npcs_here(Room, NPCs) :- findall(N, npc_at(N, Room), NPCs).
exits(Room, Dirs) :- findall(D, connection(Room, D, _To), Dirs).
inventory(Items) :- findall(I, holding(I), Items).
game_won :- orb_placed.

% --- React to player commands ---

react({action: go, dir: Dir}) :-
    player_at(Here),
    connection(Here, Dir, Dest),
    not(locked(Dest)),
    retract(player_at(Here)),
    assert(player_at(Dest)),
    send(ui, {event: moved, to: Dest}).

react({action: go, dir: Dir}) :-
    player_at(Here),
    connection(Here, Dir, Dest),
    locked(Dest),
    send(ui, {event: blocked, dir: Dir, reason: locked}).

react({action: take, item: Item}) :-
    player_at(Here),
    item_at(Item, Here),
    retract(item_at(Item, Here)),
    assert(holding(Item)),
    send(ui, {event: took, item: Item}).

react({action: drop, item: Item}) :-
    holding(Item),
    player_at(Here),
    retract(holding(Item)),
    assert(item_at(Item, Here)),
    send(ui, {event: dropped, item: Item}).

react({action: unlock, dir: Dir}) :-
    holding(rusty_key),
    player_at(Here),
    connection(Here, Dir, Dest),
    locked(Dest),
    retract(locked(Dest)),
    send(ui, {event: unlocked, dir: Dir}).

react({action: use_orb}) :-
    player_at(tower_top),
    holding(crystal_orb),
    retract(holding(crystal_orb)),
    assert(orb_placed),
    send(ui, {event: won}).

react({action: talk, npc: NPC}) :-
    player_at(Here),
    npc_at(NPC, Here),
    npc_talk(NPC, Msg),
    send(ui, {event: dialogue, npc: NPC, text: Msg}).
`;
