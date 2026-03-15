# Context file examples

## Good vs bad: service context file

### Bad — leaks implementation, too verbose
```markdown
# Matchmaking service

This service uses a Redis sorted set to maintain the queue, with ELO ratings
stored as scores. The `findMatch` function uses a 2-second polling loop via
setInterval, reads the top N players from the sorted set, groups them by mode,
and calls the `pairPlayers` private method which uses a greedy algorithm...

It also imports `PlayerRepository` from `../db/player.repo.ts` and calls
`session.save()` after creating a match...
```

### Good — describes interface only
```markdown
# Matchmaking service

## Purpose
Groups players into matches by skill rating and game mode.

## Exposes
- `findMatch(playerId, mode)` → enqueues player, resolves when match found
- `cancel(playerId)` → removes player from queue
- `status(playerId)` → `{ position: number, estimatedWaitMs: number }`

## Consumes
- Contract: `contracts/matchmaking.md`
- Event consumed: `PLAYER_DISCONNECTED` → auto-cancels active search

## Constraints
- Queue tick is 2s minimum — do not reduce
- ELO delta widens by 50 every 30s (max ±500)
- Match record must be persisted before emitting MATCH_FOUND

## Last updated
2026-01-15
```

---

## Good vs bad: screen context file

### Bad — describes visual layout, not interface
```markdown
# Lobby screen

Has a big header at the top with the game logo. Below that is a grid of
player cards showing avatars. The "Find Match" button is blue and 48px tall,
positioned at the bottom. There's a chat panel on the right side...
```

### Good — describes state, events, and API calls
```markdown
# Lobby screen

## Purpose
Entry point after auth. Shows current players and initiates matchmaking.

## Exposes
- State: `lobbyState: idle | searching | found | error`
- State: `players: PlayerSummary[]`

## Consumes
- `bridge_get_contract("lobby")` for full API surface
- Calls: `lobby.join`, `lobby.leave`, `matchmaking.findMatch`, `matchmaking.cancel`
- Events in: `MATCH_FOUND`, `PLAYER_JOINED`, `PLAYER_LEFT`
- Events out: `PLAYER_READY`, `CHAT_MESSAGE_SENT`

## Constraints
- Auth token must be valid on mount — redirect to auth if expired
- Chat is optimistic: messages appear immediately, reconciled on server ACK

## Last updated
2026-01-15
```

---

## Good vs bad: schema context file

### Bad — just a list of field names
```markdown
# Player schema

id, displayName, avatarUrl, eloRating, rank, gamesPlayed, createdAt
```

### Good — typed with constraints and notes
```markdown
# Player schema

## Purpose
Canonical player record. Source of truth on backend, read-only on client.

## Exposes
| Field        | Type      | Constraints                          |
|--------------|-----------|--------------------------------------|
| id           | uuid      | PK, set by auth service              |
| displayName  | string    | Max 24 chars, UTF-8                  |
| avatarUrl    | string?   | CDN URL, null = default avatar       |
| eloRating    | integer   | Default 1000, authoritative on server|
| rank         | enum      | bronze/silver/gold/diamond           |
| gamesPlayed  | integer   | Incremented on match end             |
| createdAt    | timestamp | ISO 8601                             |

## Subset: PlayerSummary
Used in lobby and match events: `id, displayName, avatarUrl, eloRating, rank`

## Constraints
- `eloRating` is computed server-side — never accept from client input
- Rank boundaries: bronze <1200, silver <1600, gold <2000, diamond ≥2000

## Last updated
2026-01-15
```

---

## Good vs bad: contract file

### Bad — missing direction, types, and errors
```markdown
# Lobby contract

join — players join the lobby
leave — players leave
events: MATCH_FOUND, PLAYER_JOINED
```

### Good — complete, versioned, actionable
```markdown
# Contract: lobby

## Version
1.2

## Parties
- Client exposes: lobby screen state, player actions
- Backend exposes: lobby.join, lobby.leave RPCs + broadcast events

## Interface

### lobby.join
- Direction: client → backend
- Input: `{ playerId: string, authToken: string }`
- Output: `{ lobbyId: string, players: PlayerSummary[], chatHistory: ChatMessage[] }`
- Errors: `AUTH_EXPIRED`, `SERVER_FULL`

### lobby.leave
- Direction: client → backend
- Input: `{ playerId: string }`
- Output: `{ ok: true }`
- Errors: `NOT_IN_LOBBY`

### PLAYER_JOINED (event)
- Direction: backend → all clients in lobby
- Payload: `PlayerSummary`

### MATCH_FOUND (event)
- Direction: backend → matched clients only
- Payload: `{ matchId: string, players: PlayerSummary[], mapId: string, startsInMs: number }`

## Shared types
- `PlayerSummary`: see `.context/schemas/player.md` (subset fields)
- `ChatMessage`: `{ playerId: string, message: string, timestamp: number }`

## Changelog
- 2026-01-15: Added chatHistory to lobby.join response
- 2026-01-01: Initial version
```

---

## Manifest example

```json
{
  "version": "1.0",
  "project": "game-backend",
  "stack": "Node.js / Nakama / PostgreSQL",
  "domains": {
    "services": ["matchmaking", "auth", "inventory"],
    "schemas": ["player", "session", "match"],
    "events": ["game-events"],
    "contracts": ["lobby", "matchmaking", "inventory"]
  }
}
```
