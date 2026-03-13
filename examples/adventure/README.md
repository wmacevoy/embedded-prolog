# The Obsidian Tower

A text adventure game where the world model — rooms, items, NPCs, movement,
inventory, and dialogue — is entirely Prolog facts and rules.

## What it demonstrates

- **World as facts**: `room(Id, Name, Desc)`, `connection(From, Dir, To)`,
  `item_at(Item, Room)`, `npc(Id, Room, Name)`
- **Dynamic state via assert/retract**: `player_at(Room)`, `holding(Item)`,
  `locked(Door)` change as the player explores
- **Context-sensitive dialogue**: the raven NPC says different things depending
  on what you're carrying and where you've been
- **Action validation**: movement, take, drop, use — all validated by Prolog
  queries before applying

## Files

| File | Description |
|------|-------------|
| `adventure-kb.js` | Knowledge base — world model, items, NPCs, dialogue |
| `adventure.html` | Complete browser app (HTML + CSS + JS inlined) |

## Run

Open directly in a browser:

```bash
open examples/adventure/adventure.html
```
