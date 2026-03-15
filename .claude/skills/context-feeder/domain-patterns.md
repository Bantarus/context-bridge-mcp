# Domain naming patterns

## Principle

Domain names are folder names under `.context/`. They should be:
- **Plural nouns** — `screens/`, `services/`, `events/` not `screen/`, `service/`
- **Stable** — don't rename domains often, other repos reference them
- **Meaningful to outsiders** — someone reading from another repo should understand what's in there

## Common patterns by architecture type

### Frontend (React, Flutter, SwiftUI, etc.)
```
screens/       Full pages or routes
components/    Reusable UI pieces
hooks/         Shared stateful logic (React)
stores/        State management (Riverpod, Zustand, etc.)
contracts/     API contracts consumed by this frontend
```

### Backend API (REST/RPC)
```
routes/        HTTP route handlers (thin layer)
services/      Business logic
schemas/       Request/response shapes, DB models
events/        Events emitted or consumed
contracts/     Interface exposed to callers
```

### Backend (event-driven / queue-based)
```
consumers/     Queue or event consumers
producers/     Event emitters
schemas/       Event payload shapes
contracts/     Event contracts shared with other services
```

### Game server (Nakama, Colyseus, etc.)
```
rooms/         Game room / session logic
rpcs/          Remote procedure calls exposed to clients
schemas/       State shapes (player, match, lobby)
events/        Real-time events dispatched to clients
contracts/     Client-facing contracts
```

### Mobile app
```
screens/       Screen-level components
widgets/       Reusable UI widgets
services/      Local services (auth, storage, network)
models/        Local data models
contracts/     Backend contracts consumed
```

### Shared library / SDK
```
api/           Public API surface
models/        Shared data models
events/        Event definitions
```

## Naming conflicts to avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| `utils/` | Split into relevant domains | Too vague |
| `misc/` | Split into relevant domains | Too vague |
| `data/` | `schemas/` or `models/` | Ambiguous |
| `logic/` | `services/` | Non-standard |
| `pages/` | `screens/` | Inconsistent with mobile |
| `controllers/` | `services/` or `routes/` | Framework-specific |

## When to split vs merge domains

**Split** when:
- Two groups of files are consumed by different callers
- The domain has grown beyond ~8 component files
- There's a clean conceptual boundary

**Merge** when:
- The domain has fewer than 3 files
- Every file is always consumed together
- Splitting would create empty directories

## Contracts domain

Every repo that communicates with another should have a `contracts/` domain.
This is the only domain other repos should read without `bridge_get_from`.
It is the public API of the repo's context.
