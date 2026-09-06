# 15. Admin Subsystem

This section documents the ChessAlive **Admin** subsystem — the operator console
embedded inside the player app itself. There is no separate admin app: the Admin screen
is just another route in the player app (`/admin`), gated by the signed-in user's email.
It bundles four distinct surfaces:

1. **Animation Studio** (`AnimationStudioAdmin.tsx`, ~2,016 lines) — the embedded GLB /
   piece-set / ceremony-animation authoring tool (the largest admin surface by far).
2. **Database Browser** (`AdminScreen.tsx`) — a read-only inspector over the realtime
   server's durable data and the browser's own `localStorage`, grouped into product
   domains.
3. **Realtime Ops / Rooms** (`AdminScreen.tsx`) — live server status, DB cost,
   and active-room cards.
4. **Character Releases + OG Pack** (`CharacterReleasesAdmin.tsx`, `OgPackAdmin.tsx`) —
   the monthly release calendar curator and the Progression-portrait uploader, both
   rendered under the Animation Studio's *Character Releases* tab.

Source roots:
- `apps/player-app/src/features/admin/AdminScreen.tsx` (473 lines) — shell, DB browser, ops/rooms.
- `apps/player-app/src/features/admin/AnimationStudioAdmin.tsx` (2,016 lines) — the Animation Studio.
- `apps/player-app/src/features/admin/CharacterReleasesAdmin.tsx` (425 lines) — release calendar.
- `apps/player-app/src/features/admin/OgPackAdmin.tsx` (172 lines) — OG starter-pack uploader.
- `apps/player-app/src/features/admin/routes.ts` — the two admin routes.
- Gating: `apps/player-app/src/shared/AppModel.ts` (`adminEmail`, `isAdminUser`),
  `apps/player-app/src/app/RouteContent.tsx` (line 488), `apps/player-app/src/app/hooks/useAppData.ts` (`userIsAdmin`).
- Data shapes: `packages/types/src/index.ts` (`DatabaseHealth`, `DatabaseTableSummary`,
  `DatabaseTableRow`, `MultiplayerRoom`), `packages/funny-mode/src/types.ts`
  + `registry.ts` + `checkmateFinisher.ts`, `apps/player-app/src/features/progression/characterCatalog.ts` (`OgPackManifest`).
- Endpoints/env: `apps/player-app/src/app/shell/env.ts` (`assetServerHttpEndpoint`).

Cross-references: the realtime server side of these endpoints lives in **§10**; the
underlying GLB / ceremony pipeline in **§12**; the funny-mode effect/choreography types in
**§07**; the `ChessAliveServices` contract (incl. `database`, `multiplayer`,
`animationStudio`, `characterReleases`) in **§11**; the Progression / character-catalog UI
in **§14.2**.

---

## 15.1 How admin is gated & accessed

### 15.1.1 The admin identity is a single hard-coded email

There is **no** role table, no admin flag stored per user, and no admin token managed in
the client. Admin access is decided purely by email match against one constant
(`apps/player-app/src/shared/AppModel.ts`):

```ts
export const adminEmail = "lakshminathanlaky@gmail.com";

export function isAdminUser(userProfile: UserProfile | null | undefined) {
  return userProfile?.email?.trim().toLowerCase() === adminEmail;
}
```

The same email is the `localhostDevProfile` (`AppModel.ts`), so any localhost dev session
is automatically an admin:

```ts
export const localhostDevProfile: GoogleAuthProfile = {
  sub: "localhost-dev-user",
  email: adminEmail,
  name: "Localhost Dev",
};
```

### 15.1.2 Client gate — the route is registered for everyone but blocks the body

`userIsAdmin` is derived once in `apps/player-app/src/app/hooks/useAppData.ts`:

```ts
const userIsAdmin = isAdminUser(data.user);
```

`RouteContent.tsx` (line 488) then refuses to render the screen body for non-admins,
returning a panel instead of `<AdminScreen>`:

```ts
if (targetScreen === "Admin" && !userIsAdmin)
  return <Panel title="Admin">Sign in with the admin account to view operations.</Panel>;
return <AdminScreen data={data} reload={...} services={services} settings={settings} setSettings={setSettings} />;
```

> **Copy string (verbatim):** the non-admin block reads **"Sign in with the admin account
> to view operations."**

`useAppData.ts` also keeps admin-only network calls out of the home boot so non-admins
never trigger `403` noise, and — on localhost only — ensures a *real* admin session exists
(not just a persisted client stub) so admin-gated endpoints like asset upload accept the
request instead of 403-ing (`useAppData.ts` comments at lines 115, 169–172).

### 15.1.3 Server side — the admin token is a server concern, not a client one

The client never holds an "admin token". Admin-gated mutations (asset upload, KV write,
piece-set save) are authorized server-side via the **session auth header** attached by
`sessionAuthHeaders()` (`@chessalive/services`); the realtime server checks whether the
session's email is in its admin list (see **§10** for the server's admin endpoints and the
admin allow-list). On localhost the issued session is flagged admin because the dev profile
email matches `adminEmail`.

### 15.1.4 The two admin routes

`apps/player-app/src/features/admin/routes.ts` registers two `ScreenDefinition` entries,
both under `module: "admin"`:

| Caption | path | screen | primary | icon (lucide) | rune | tone | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Admin | `/admin` | `Admin` | yes | `Database` | `DB` | `slate` | The console documented here. |
| Events | `/tournaments` | `Tournaments` | no | `Trophy` | `♚` | `gold` | Tournaments screen (rendered by `TournamentsScreen` from `@features/social/SocialScreens`, `RouteContent.tsx` line 440). |

> The `Events` route is owned by the admin module but its screen is the social
> `TournamentsScreen`; this section documents the `/admin` console only.

**How to access (clone note):** sign in with the Google account
`lakshminathanlaky@gmail.com`, or run the app on `localhost` (any port) where the dev
session is auto-promoted to admin. Then open the **Admin** primary-nav destination (Database
icon, rune `DB`). Non-admins see only the "Sign in with the admin account…" panel.

---

## 15.2 Admin shell & top-level sections (`AdminScreen.tsx`)

`AdminScreen` renders a `<FeatureGrid>` (a `View` with `styles.featureGrid`) containing a
`Panel title="Admin"` whose body is a three-pill segmented control (`styles.adminSectionTabs`).
The selected pill picks one of three section bodies via the `adminSection` state
(`"studio" | "database" | "ops"`, default `"studio"`):

| Pill label (verbatim) | `adminSection` value | Renders |
| --- | --- | --- |
| `Piece Sets + Animations` | `studio` | `<AnimationStudioAdmin>` (§15.5) |
| `Database` | `database` | `<AdminDatabaseBrowser>` (§15.3) |
| `Ops, Rooms` | `ops` | `<AdminOpsPanel>` + `Room Admin` panels (§15.4) |

Each pill uses `styles.actionPill` (+ `actionPillActive` when selected, `pressed` while
pressed). The whole screen receives `{ data, reload, services, settings, setSettings }`
from `RouteContent`; `reload` re-fetches feature data via `refreshFeatureData(snapshot)`.

A small shared `StudioLikeTab` component (used inside the DB browser) is a `Pressable`
rendering `styles.actionPill` / `actionPillActive` with `actionPillText` / `actionPillTextActive`.

---

## 15.3 Database Browser (`AdminDatabaseBrowser`)

The Database Browser is a 3-column inspector over either the **remote** realtime server's
durable data or **this browser's** `localStorage`. It groups raw tables/collections into
logical product domains, lets the operator drill group → object → rows, and previews each
row as pretty-printed JSON. It is **read-only** (no edits/deletes here).

### 15.3.1 Two `Panel`s, the source toggle, and the status grid

The component renders two stacked `Panel`s:

1. **`Panel title="Database Browser"`** — a 4-card status grid + a one-line description +
   the source toggle row.
2. **`Panel title={source === "remote" ? "Remote Data Groups" : "Browser LocalStorage Groups"}`** —
   the 3-column group/object/rows browser.

The status grid (`styles.databaseStatusGrid`, four `databaseStatusCard`s) shows, each with a
lucide icon, a label, and a value derived from `data.databaseHealth`:

| Card | Icon (lucide) | Icon color | Label | Value source |
| --- | --- | --- | --- | --- |
| Driver | `Database` | `aiBlue` | `Driver` | `data.databaseHealth?.driver ?? "browser-local"` |
| Mode | `Shield` | `aiTeal` | `Mode` | `persistenceMode` (below) |
| Assets | `Layers` | `#9b6bdf` | `Assets` | `assetStore` (below) |
| Records | `Gauge` | `#c47b17` | `Records` | `String(data.databaseHealth?.records ?? 0)` |

Derived values:
- `persistenceMode = data.databaseHealth?.driver?.startsWith("gcp") ? "Permanent GCP storage" : "Local fallback"`
- `assetStore = data.databaseHealth?.driver === "gcp-firestore-gcs" ? "Cloud Storage bucket" : "Local uploads folder"`

Below the grid, a `styles.muted` description string (verbatim):

> **"Chat events, game snapshots, profiles, puzzle progress, uploaded asset metadata,
> piece sets, and animation sets are visible here when the selected backend is reachable."**

The `driver` enum (from `DatabaseHealth`, `packages/types/src/index.ts`) is one of:
`"browser-local" | "memory" | "jsonl" | "postgres-ready" | "gcp-firestore" | "gcp-firestore-gcs"`.

The full `DatabaseHealth` shape consumed here:

```ts
export interface DatabaseHealth {
  driver: "browser-local" | "memory" | "jsonl" | "postgres-ready" | "gcp-firestore" | "gcp-firestore-gcs";
  hotStore: string;
  durableStore: string;
  estimatedMonthlyCostUsd: number;
  latencyBudgetMs: number;
  records: number;
}
```

### 15.3.2 Source toggle + Refresh

The toggle row (`styles.rowWrap`) has two `StudioLikeTab`s and one `ActionButton`:

| Control | Label (verbatim) | Effect |
| --- | --- | --- |
| Tab | `Remote / Server` | `setSource("remote")` |
| Tab | `This Browser` **or** `This Browser Disabled` | `setSource("local")` — label is `localStorageDisabled ? "This Browser Disabled" : "This Browser"` |
| Button | `Refresh Database` (or `Refreshing...` while loading) | `refreshTables()` |

`refreshTables()` behaviour by source:
- **remote:** `await services.database.listTables()`, store, clear selection, then `await reload()`.
- **local:** re-runs `collectBrowserLocalTables()` and clears selection (no network).

Errors set `error` state, shown in red via `styles.saveFeedbackError`. Failure copy:
- `"Could not refresh database tables."` (table refresh)
- `"Could not load table rows."` (row load)

### 15.3.3 Table-grouping logic (`databaseGroupForTable` / `groupDatabaseTables`)

Raw tables (remote `DatabaseTableSummary[]` or browser-local synthetic tables) are bucketed
into **10 logical groups** by keyword-matching the table's `id`/`name` (both lowercased).
`databaseGroupForTable(table)` returns the first matching group; order of the `if` chain is
the match priority:

| Order | Group `id` | Group `name` | Match keywords (in `id` or `name`) | Description (verbatim) |
| --- | --- | --- | --- | --- |
| 1 | `assets` | `Assets` | `assets`, `asset` | "Uploaded piece images, GLB metadata, and object-storage references." |
| 2 | `users` | `Users + Profiles` | `users`, `user`, `profile`, `setting` | "Player profiles, settings, auth-derived records, puzzle ratings, and user state." |
| 3 | `leaderboards` | `Leaderboards` | `leaderboard` | "Computed leaderboard snapshots and ranking tables." |
| 4 | `learn` | `Learn + Puzzles` | `puzzle`, `learn` | "Puzzle progress, rating state, attempts, and learning records." |
| 5 | `games` | `Games + Rooms` | `room`, `game` | "Game rooms, snapshots, move records, and match event streams." |
| 6 | `social` | `Social + Chat` | `chat`, `social` | "Chat, private room, friend, and social event data." |
| 7 | `events` | `Event Streams` | `event` | "Durable append-only event streams grouped away from main records." |
| 8 | `kv` | `Key/Value + Cache` | `kv`, `key/value`, `cache` | "Low-level key/value records and browser cache state." |
| 9 | `app` | `App Configuration` | `app` | "Global app state such as piece sets, animation sets, and configuration." |
| 10 (fallback) | `other` | `Other` | (no match) | "Other records not yet mapped to a product domain." |

`groupDatabaseTables(tables)` then:
1. Walks every table, resolves its group meta, and either appends to an existing group or
   creates a new one, accumulating `recordCount` (`Number(table.recordCount ?? 0)`) and
   `tableCount` per group.
2. Sorts the resulting groups by a **fixed preferred order**, *not* by the match-priority
   order above:

```ts
const preferredOrder = ["app", "users", "games", "learn", "social", "leaderboards", "assets", "events", "kv", "other"];
```

A `DatabaseGroup` is `{ id, name, description, recordCount, tableCount, tables[] }`.

> **Note on "leaderboard recompute":** the Database Browser surfaces leaderboard data as the
> `leaderboards` group (computed leaderboard snapshots / ranking tables). The recompute
> *operation* itself is a server concern (see the realtime server's leaderboard endpoints in
> **§10**); the admin console only inspects the resulting snapshot tables here.

### 15.3.4 The 3-column browser

Inside the second `Panel`, `styles.databaseBrowserGrid` lays out three columns:

**Column 1 — Groups** (`styles.databaseTableList`): one `Pressable`
`databaseTableCard` per group (active → `databaseTableCardActive`). Each card shows:
- `group.name` (1 line) + `group.recordCount` badge (top header, `databaseTableHeader`).
- `group.description` (2 lines, `databaseTableDescription`).
- A footer line: `` `${group.tableCount} object group${group.tableCount === 1 ? "" : "s"}` `` (`databaseTablePath`).

Empty state (`databaseEmptyState`): title **"No data groups detected"**, with the muted
body depending on context:
- remote: **"Start the realtime server or configure GCP persistence to inspect durable data."**
- local + disabled: **"The gameplay database KV mirror is disabled by EXPO_PUBLIC_CHESSALIVE_DISABLE_DATABASE_KV_MIRROR. Other required identity and preference storage has separate controls."**
- local + enabled: **"No ChessAlive localStorage records exist in this browser yet."**

Selecting a group sets `selectedGroupId` and clears table/rows.

**Column 2 — Objects** (`styles.databaseTableList`): when no group selected, an empty state
with title **"Select a group"** and body **"Rows are hidden until you pick a logical object
group, then one concrete table or stream."** When a group is selected, one `Pressable`
`databaseTableCard` per `table` in the group, each showing `table.name` + `table.recordCount`
badge, `table.description ?? table.type` (2 lines), and `table.id` (footer path). Selecting a
table sets `selectedTableId`.

**Column 3 — Rows** (`styles.databaseRowsPanel`): a header (`databaseRowsHeader`) with the
selected table's name (`selectedTable?.name ?? "Select an object"`) + `id`
(`selectedTable?.id ?? "No table selected"`), and a badge (`databaseRowsBadge`) reading
`` isLoadingRows ? "Loading" : `${rows.length}/100 rows` ``.

Row loading runs in an effect when `selectedTable.id` changes:
- remote: `await services.database.listRows(selectedTable.id, 100)`
- local: `collectBrowserLocalRows(selectedTable.id, 100)`

Empty-state title: `isLoadingRows ? "Loading rows..." : selectedTable ? "No rows in this object" : "Rows hidden"`.
Empty-state body: if a table is selected, **"Rows appear here as JSON previews so nested
documents are still readable."**; otherwise **"Choose a group and then an object to load the
top 100 rows."**

Each row renders a `databaseRowCard` with `row.id` (and `row.path` if present) plus a
selectable `databaseJson` `<Text>` of `safeDatabasePreview(row.data)` — `JSON.stringify(value,
null, 2)` with a `String(value)` fallback if serialization throws.

`DatabaseTableSummary` / `DatabaseTableRow` shapes (`packages/types/src/index.ts`):

```ts
export interface DatabaseTableSummary {
  id: string;
  name: string;
  type: "firestore-collection" | "firestore-subcollection" | "local-json" | "browser-local";
  recordCount: number;
  description?: string;
}
export interface DatabaseTableRow {
  id: string;
  path?: string;
  data: Record<string, unknown>;
}
```

### 15.3.5 Browser-localStorage inspector & the disable flag

The "This Browser" source builds *synthetic* tables directly from `window.localStorage`,
namespaced under `chessalive:v1` (`browserNamespace = "chessalive:v1"`). The entire feature is
gated behind a public env flag:

```ts
const localStorageDisabled = localDatabaseStorageDisabled(
  process.env.EXPO_PUBLIC_CHESSALIVE_DISABLE_DATABASE_KV_MIRROR ??
    process.env.EXPO_PUBLIC_CHESSALIVE_DISABLE_LOCAL_STORAGE,
);
```

The direct property access is intentional because Expo statically substitutes `EXPO_PUBLIC_*`
values only in that form. Admin imports the same `localDatabaseStorageDisabled(value)` parser used
by the gameplay KV database: unset/blank and `"0" | "false" | "off" | "no"`
(case-insensitive, trimmed) parse to **`false`**, while every other non-empty value parses to
`true`. Browser-local inspection is therefore **enabled by default**, matching the gameplay KV
mirror's default. When explicitly disabled, Admin's browser-only `localStorageRef()` returns
`undefined`, all collectors return empty, and the tab reads **This Browser Disabled**. This Admin
inspector reads the browser's real `localStorage`; unlike service persistence, it does not use the
injected native adapter.

`collectBrowserLocalTables()` partitions `localStorage` keys into three synthetic tables:

| Synthetic table | `id` | `name` | Keys matched | `recordCount` |
| --- | --- | --- | --- | --- |
| ChessAlive KV cache | `browser:kv` | `Browser KV cache` | `chessalive:v1:*` **excluding** `:events:` | count of matching keys |
| Per-stream events | `browser:events:{stream}` | `{stream} events` | each `chessalive:v1:events:{stream}` key | parsed array length (or 0) |
| Other origin keys | `browser:other` | `Other browser keys` | keys **not** starting with `chessalive:v1:` | count of matching keys |

Each has `type: "browser-local"` and a `description` (e.g. KV cache → "ChessAlive browser
key/value records stored in this browser.", events → `` `Browser-local events for ${stream}.` ``,
other → "Other localStorage records visible to this origin.").

`collectBrowserLocalRows(tableId, limit)` returns the rows for a synthetic table:
- `browser:kv`: each `chessalive:v1:*` (non-event) key → `{ id: keyWithoutNamespace, data: { key, value: parseStorageValue(...) } }`, sliced to `limit`.
- `browser:events:{stream}`: parses the stream array and returns the **last** `limit` events → `{ id: `${stream}-${index}`, data: { createdAt, stream, ...payload } }`.
- `browser:other`: each non-namespaced key → `{ id: key, data: { key, value } }`, sliced to `limit`.

`parseStorageValue(raw)` JSON-parses each stored value, falling back to the raw string on
parse failure.

---

## 15.4 Realtime Ops & Room Admin (`adminSection === "ops"`)

This section renders two stacked `Panel`s: `AdminOpsPanel` and `Room Admin`.

### 15.4.1 `AdminOpsPanel` (`Panel title="Realtime Admin"`)

A live server-status card driven by `data.multiplayerStatus` and `data.databaseHealth`.

Top row (`styles.serverStatusRow`):
- A lucide `Gauge` (size 18, `strokeWidth 2.5`), colored **`#16a34a`** (green) when
  `data.multiplayerStatus?.online`, else **`#64748b`** (slate).
- A status dot (`styles.serverDot` + `serverDotOnline` when online).
- A status text: when online, `` `${activeRooms} rooms · ${p95LatencyMs}ms p95` ``; when
  offline, the literal **"Realtime server offline"**.

Then four `StatLine`s (label/value):

| `StatLine` label | Value |
| --- | --- |
| `Endpoint` | `data.multiplayerStatus?.endpoint ?? "local"` |
| `Storage` | `data.multiplayerStatus?.storage ? "event log" : data.databaseHealth?.driver ?? "local"` |
| `DB cost` | `` `$${data.databaseHealth?.estimatedMonthlyCostUsd ?? 0}/mo` `` |
| `Records` | `String(data.databaseHealth?.records ?? 0)` |

If at least one room exists, a **first-room card** (`styles.roomCard`) shows:
- `firstRoom.code` (`styles.roomCode`).
- `` `${status} · ${timeControl} · ${region}` `` (muted).
- `` `${players.white?.displayName ?? "Open"} vs ${players.black?.displayName ?? "open seat"}` `` (muted).

The `serverStatus()` payload shape (`packages/services` / `MultiplayerService`):
`{ online, endpoint, activeRooms, activePlayers, p95LatencyMs, storage }`. Offline fallback
yields `{ online: false, endpoint: realtimeWsEndpoint(), activeRooms: remoteRooms.size,
activePlayers: 1, p95LatencyMs: 0, storage: "local fallback" }` (`localServices.ts`).

### 15.4.2 `Panel title="Room Admin"`

If `data.rooms` is empty, shows muted **"No active rooms."** Otherwise one
`styles.lessonStep` per `room`:
- Title: `room.code`.
- Body: `` `${room.status} · ${room.timeControl} · ${room.region}` `` (muted).
- `StatLine` **Spectators** → `String(room.spectators)`.
- `StatLine` **Updated** → `new Date(room.lastActivityAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })`.

`MultiplayerRoom` (`packages/types/src/index.ts`): `{ id, code, status: "waiting" | "playing"
| "completed", timeControl, rated, funnyMode, region, latencyMs, spectators, createdAt,
lastActivityAt, players: { white?, black? }, snapshot?, rulesetId?, duelChallengeId?,
handcuffSide? }`.

---

## 15.5 Animation Studio (`AnimationStudioAdmin.tsx`)

The Animation Studio is the heart of the admin console (and the funny-mode content
pipeline). It lets the admin build **Piece Sets** (static SVG board art + sound packs) and
**Animation Sets** (GLB clips composed into per-action timelines), preview them live on a
mini chess board, and **activate** a piece set + animation set for the player's own games.
Everything authored here is persisted via `services.animationStudio.*` and the realtime
asset server (see **§11**/**§12**).

It renders one outer `Panel title="Piece Sets + Animation Studio"`.

### 15.5.1 Hero + the three tabs

The hero (`styles.animationStudioHero`):
- Title (verbatim): **"Piece Sets and Animation Sets"**.
- Copy (verbatim): **"Piece Sets are SVG board art. Animation Sets hold GLB clips, turns,
  exact durations, and board movement."**
- A primary `StudioButton accent` labelled **"Activate Selected"** (disabled until a piece
  set is selected) → `activateForPlay(selectedPieceSet.id, selectedAnimationSet?.id)`.

The tab bar (`styles.adminTabBar`) has three equal-flex pills driven by `tab` state
(`"pieces" | "animations" | "releases"`, default `"pieces"`):

| Tab value | Label (verbatim) | Body |
| --- | --- | --- |
| `pieces` | `Piece Sets` | §15.5.3 |
| `animations` | `Animation Sets` | §15.5.4 |
| `releases` | `Character Releases` | `<OgPackAdmin>` + `<CharacterReleasesAdmin>` (§15.6, §15.7) |

A single `feedback` banner renders at the bottom of the panel
(`styles.saveFeedback` + `saveFeedbackError` / `saveFeedbackSaving` by tone); `Feedback` is
`{ tone: "error" | "saved" | "saving"; text } | null`.

### 15.5.2 Core data model & state

Props: `{ data, reload, services, settings, setSettings }`. Local state hydrated from `data`:
- `pieceSets` ← `data.pieceSets`; `editablePieceSets` filters out `isSeededExample` sets.
- `animationSetsState` ← `data.animationSets`; `animationSets` filters to the selected piece set.
- `clips` ← `data.animationClips` (`AnimationClip[]`).
- Selections: `selectedPieceSetId`, `selectedAnimationSetId`, `selectedPiece` (default `"k"`),
  `boardColor` (`"w"|"b"`), `animationColor` (`"both"|"w"|"b"`), `animationSlot`
  (`PieceAssetSlotKey`, default `"shared"`), `action` (default `"game-start-handshake"`).
- Timeline: `timeline` (`TimelineItem[]`), `mateDirection` (`MovementDirection`, default
  `"straight"`), `directionalTimelines` (per-direction parked timelines), `loserReaction`
  (default `"slump"`), `selectedTimelineIndex`, `timelineEditor` (modal draft).
- Preview: `previewTick` (advanced every 80 ms), `livePreviewFrame.width` (ResizeObserver-ish
  via `requestAnimationFrame`).

Piece ordering & glyphs: `pieceOrder = ["p","n","b","r","q","k"]`, `pieceNames` (e.g. `k:
"King"`), `pieceGlyphs` (`k: "♔"`, etc.).

The three GLB **animation slots** (`animationSlots`):

| Slot key | Label | Description (verbatim) |
| --- | --- | --- |
| `shared` | `Shared GLB` | "Model/clip used by both colors unless overridden." |
| `white` | `White GLB` | "Optional white-only ceremony model." |
| `black` | `Black GLB` | "Optional black-only ceremony model." |

The full `PieceAssetSlotKey` union (`funny-mode/types.ts`):
`"shared" | "white" | "black" | "static" | "move" | "capture" | "celebrate" | "reference"`.

**Per-piece action options** (`pieceActionOptions`, `funny-mode/registry.ts`) — these are the
only authorable actions today:

| Piece | Available actions (`{id, label}`) |
| --- | --- |
| Pawn / Knight / Bishop / Rook / Queen | `checkmate-finisher` → "Checkmate finisher" |
| King | `game-start-handshake` → "Opening king handshake"; `checkmate-finisher` → "Checkmate finisher" |

`animationActionLabel(action)` resolves the human label; `activateForPlay()` writes the chosen
piece set + animation set into `settings` (`pieceSetId`, `animationSetId`, `animationsEnabled`,
`enabled`) and persists via `services.settings.saveSettings(data.user?.id ?? "admin-local", …)`.

### 15.5.3 Piece Sets tab

**Inline create/edit form** (`styles.animationStudioInlineForm`):
- `TextInput` for the new set name (placeholder **"Piece set name"**, default state value
  `"Untitled Piece Set"`).
- `StudioButton accent` **"Create Piece Set"** → `services.animationStudio.createPieceSet({...})`
  (created with description *"Static board-piece images for normal gameplay. Animation GLBs are
  attached separately in Animation Sets."*).
- When a non-default set is selected: **"Make default"** → `setDefaultPieceSet(id)`.
- When a set is selected: **"Delete piece set"** → `deletePieceSet(id)` (the default set is
  protected server-side: *"make another piece set the default first"*).

**Empty state:** title **"No piece sets yet"**, body **"Create a Piece Set, then upload
transparent board images for each white and black piece."**

**Piece-set card grid** (`styles.pieceSetCardGrid`): each card shows the name (`+ "  ·  default"`
for the default), description, a 6-pip roster strip (`pieceRosterPip` / `pieceRosterPipMissing`
when neither color has valid art), and two `StatLine`s — **Board pieces** `` `${boardPieceCount}/12` ``
and **Animation sets** (count for that set's `pieceSetId`).

When a set is selected, the **Board Piece Upload** panel (`styles.animationBuilderPanel`):
- Subtitle **"Board Piece Upload"**, copy **"Upload static board pieces here. Piece Sets accept
  SVG only. GLB files belong in Animation Sets."**
- A 6-cell piece roster grid (each shows a `BoardAssetPreview` and a status line — "SVG
  uploaded" / "Image uploaded" / "Uploaded" / "Missing").
- A White/Black color segment (`styles.speedSegment`).
- `StudioButton accent` **"Upload SVG for {White|Black} {PieceName}"** → `uploadBoardPiece()`.

`uploadBoardPiece()` accepts `.svg,.png,.jpg,.jpeg,.webp` (and the matching MIME types),
rejects non-image files with **"Board pieces must be SVG or standard image files (PNG, JPG,
WEBP). Upload GLB files only inside Animation Sets."**, uploads via
`uploadBoardPieceFileToServer(file, piece, color)`, writes a `BoardPieceAsset` (`kind: "svg" |
"image"`) into the set, then auto-activates it. Success: **"{PieceName} SVG saved in this Piece
Set."**

**Sound Pack panel** (`styles.animationStudioPanel`): subtitle **"Sound Pack"**, copy **"Audio
files that play during gameplay when this piece set is active. Leave any event empty to use the
built-in wooden synth sound."** One row per `SOUND_EVENT_DEFS` entry; configured rows tint green
(`rgba(34,197,94,0.06)` bg, `0.3` border), unconfigured tint slate (`rgba(148,163,184,0.08)`):

| Event | Label | Icon |
| --- | --- | --- |
| `move` | `Move` | `♟` |
| `capture` | `Capture` | `⚔` |
| `check` | `Check` | `⚠` |
| `castle` | `Castle` | `♜` |
| `promote` | `Promote` | `★` |
| `game-end` | `Game End` | `🏁` |

Each row's subtitle is `asset?.fileName ?? "— using built-in synth sound"`. Buttons: **▶**
(preview, configured only → `previewSoundForEvent`, plays at volume 0.6), **Upload**/**Replace**
(`uploadSoundForEvent`), **Clear** (configured only). Audio accepts `.mp3,.wav,.ogg,.m4a,.webm`;
non-audio rejected with **"Sound must be an audio file (MP3, WAV, OGG, M4A, WEBM)."**

### 15.5.4 Animation Sets tab

If no piece set is selected: muted **"Create a Piece Set first."** Otherwise:

**Header:** subtitle `` `Animation Sets for ${selectedPieceSet.name}` ``, copy **"Upload GLBs
here, list clips, add Turn steps, preview on the board, and save the timeline."**, plus a
`StudioButton accent` **"New Animation Set"** → `createAnimationSet()` (created with name
`` `${name} Ceremonies` `` and description *"Opening and checkmate animation rules linked to
this piece set."*).

**Animation-set card grid:** name, description, `StatLine` **Rules** (rule count).

**Animation GLB Upload panel:** subtitle **"Animation GLB Upload"**, a 6-cell piece roster
(`GlbAssetPreview` per piece), the 3 slot cards (`assetSlotGrid`), and `StudioButton accent`
**"Upload {PieceName} GLB"** → `uploadAnimationGlb()`.

`uploadAnimationGlb()` accepts `.glb,.gltf` (`model/gltf-binary`, `model/gltf+json`), uploads
via `uploadAssetFileToServer`, then `detectGlbAnimationClips(...)` parses the GLB's animation
tracks into `AnimationClip`s. **Replacement guard:** if a different GLB already occupies the
slot, `missingMovementsOnGlbReplace(...)` checks the new clip names against the movements
currently in use (`inUseClipIds(...)`); if any are missing the replace is **blocked** with:

> **"Replacement blocked — the new GLB is missing movement(s) still in use: {list}. Update or
> remove those animations first, or upload a GLB that still includes them."**

On success it saves the detected clips, writes the slot (a `shared` upload also mirrors into
`static`/`move`/`capture`/`celebrate`), seeds the timeline with the first up-to-2 detected
clips, auto-activates, and reports `` `${n} animation clip(s) linked to ${PieceName}.` ``.

**Live Preview + Timeline** are laid out side-by-side via raw `div`s (`flex: 2 1 640px` for the
preview, `flex: 1 1 320px` for the timeline):

- **Live Preview** (`AnimationBoardPreview`): renders a mini 8×8 board (size clamped to
  `Math.max(320, Math.min(680, frameWidth − 20))`) and animates the selected piece along the
  authored timeline using the actual GLB (`GlbModelPreview`) when loadable, falling back to a
  bobbing board glyph. Caption: **"Live board preview"** + the now-playing label. When no GLB is
  loadable it shows **"3D preview unavailable"** / **"Upload or select a valid GLB clip. Static
  board icons are not animated here."** For `checkmate-finisher` it adds the note that squares are
  dynamic in-game and the preview only samples a left/right path for the chosen direction.

- **Timeline panel:** subtitle **"Timeline"**, copy **"Add GLB clips or Turn steps, set exact
  seconds, drag bars horizontally, then save the current action."**, an **"Add animation"** button
  (opens the modal), the per-piece **action pills**, an `Both/White/Black` color segment, and a
  **"Save"** `StudioButton accent` → `saveAnimationRule()`. The timeline strip renders each step
  as a draggable/resizable bar (lanes 152 px tall) with a moving playhead (`#2563eb`), the step
  label, its `from → to` squares (`#2563eb`, weight 900), its duration in seconds (and `· merged
  ×N` when bars overlap), plus ✎ (edit) and × (delete) actions and two `ew-resize` grips
  (`#9bc0f5`). Empty: **"No animation steps yet"** / **"Use Add animation to build this rule."**

**Checkmate-finisher direction authoring:** when `action === "checkmate-finisher"`, a blue
callout appears with the heading **"Mating-move direction — classified by the file the piece
moves toward (a…h)."** and copy explaining one lane can be authored and the rest reused
(mirrored, ⇄). The three direction chips come from `movementDirections`:

| `MovementDirection` | Label (`movementDirectionLabel`) |
| --- | --- |
| `straight` | `Straight` |
| `left-to-right` | `Left → right` |
| `right-to-left` | `Right → left` |

Each chip shows `● Custom` (green) when authored or e.g. `Reuses Straight ⇄` (from
`resolveDirectionalSlot`) when it will reuse another lane. Below, an **"Opponent king's sad
move"** sub-block offers the `loserReactions`:

| `LoserReaction` | Label (`loserReactionLabel`) | Description (`loserReactionDescription`) |
| --- | --- | --- |
| `slump` | `Slump (sad sink)` | "The king sinks, tilts and dims where it stands — quietly defeated." |
| `topple` | `Topple over` | "The king tips over and falls flat beside the winning piece." |
| `shake` | `Shake head` | "The king shakes its head in disbelief, then slumps." |
| `crumble` | `Crumble away` | "The king shrinks and fades out, crumbling to nothing." |
| `flee` | `Flee the board` | "The king is knocked away and flees off the board." |

The default king opening (`game-start-handshake`, piece `k`, empty timeline) auto-seeds the
9-step `openingCeremonySteps()` choreography (emerge → walk out → step center → turn → comic bow
→ handshake → funny reaction → walk back → return home → settle), total ≈ 8.81 s. See **§12** for
the ceremony runtime.

**Add/Edit Animation modal** (`renderBodyPortal` → fixed overlay, `backdrop blur(8px)`,
`rgba(10,20,35,0.34)`, `zIndex 2500`): title **"Add animation"** / **"Edit animation"**, copy
**"Choose a clip or configure a Turn step. Preview updates after save."**, a `GLB Clip` / `Turn`
segment, then either a `<select>` of compatible clips (`{name} · {seconds}s`) or X/Y/Z degree
inputs, plus **Starts at (seconds)**, **Start square**, **End square**, **Duration (seconds)**
fields (the finisher hides start/end squares and notes **"No start/end squares here — a
checkmate finisher always travels from the piece's live square to the enemy king, decided by the
game position."**). Buttons: **Cancel**, **Save**. Saving sets feedback **"Animation step
updated. Press Save to store this rule."**

`saveAnimationRule()` validates (directional: at least one of straight/left→right/right→left;
non-directional: at least one step) — empty errors: **"Author at least one direction (straight,
left→right or right→left) before saving."** / **"Add at least one timeline step (Add animation)
before saving."** — auto-creates an Animation Set if none exists, builds `AnimationRule`
choreography (`timelineToChoreographySteps`), saves via `services.animationStudio.saveAnimationSet`,
auto-activates, and reports `` `${PieceName} ${action label} rule saved.` ``.

### 15.5.5 Animation Studio features table

| Feature | Where | Persisted via |
| --- | --- | --- |
| Create / default / delete Piece Set | Piece Sets tab | `animationStudio.createPieceSet` / `setDefaultPieceSet` / `deletePieceSet` |
| Upload board piece (SVG/PNG/JPG/WEBP) | Piece Sets tab | `uploadBoardPieceFileToServer` + `savePieceSet` |
| Sound pack (6 events, MP3/WAV/OGG/M4A/WEBM) | Piece Sets tab | `uploadSoundFileToServer` + `savePieceSet` |
| Create Animation Set | Animation Sets tab | `animationStudio.createAnimationSet` |
| Upload GLB (`.glb`/`.gltf`) + auto clip detection | Animation Sets tab | `uploadAssetFileToServer` + `detectGlbAnimationClips` + `saveAnimationClips` |
| GLB-replace movement guard | Animation Sets tab | `missingMovementsOnGlbReplace` (client-side block) |
| Timeline authoring (clips + turns, drag/resize, exact seconds) | Animation Sets tab | `saveAnimationRule` → `saveAnimationSet` |
| Per-direction checkmate finisher + loser reaction | Animation Sets tab | `DirectionalSlots` on the `AnimationRule` |
| Live board preview | Animation Sets tab | (in-memory only) |
| Activate set for play | Hero / on every save | `activateForPlay` → `settings.saveSettings` |
| OG starter-pack portraits | Character Releases tab | §15.6 |
| Monthly release calendar | Character Releases tab | §15.7 |

---

## 15.6 OG Pack Admin (`OgPackAdmin.tsx`)

Renders inside the Animation Studio's **Character Releases** tab (above the release calendar).
It uploads the per-piece **portrait PNGs** that power the Progression-tab character cards and the
on-board equipped art, and rewrites the KV manifest `og-pack-manifest:v1` (`MANIFEST_KEY`). It is
the UI twin of `scripts/upload-og-pack.mjs`.

Header: subtitle **"Starter Pack (OG) — Progression portraits"**, copy (verbatim) **"These power
the character cards in the Progression tab and the equipped piece art on the board. Upload a Card
image (roster) and a Board image (on-board cutout) per piece. Saving writes the
og-pack-manifest:v1 manifest immediately."**, plus a **↻ Refresh** pill.

Two completion badges turn green at 6/6: **`Cards {n}/6`** and **`Board {n}/6`** (n = pieces with
a `card.assetUrl` / `board.assetUrl`). A `Loading manifest…` chip shows while fetching.

The six pieces (`PIECES = ["king","queen","rook","bishop","knight","pawn"]`, glyphs ♔♕♖♗♘♙) each
render a row with two upload slots (`SLOTS`):

| Slot kind | Label | Hint (verbatim) |
| --- | --- | --- |
| `card` | `Card art` | "Progression roster card — the pristine 3D render." |
| `board` | `Board art` | "On-board piece — transparent cutout." |

Each slot shows a 72×72 preview (the glyph as placeholder) and an **Upload**/**Replace** button
(**Uploading…** while busy). Tip line: **"Tip: after publishing, reload the player app to see
updated portraits (the manifest is fetched once on startup). PNG/JPG/WEBP supported."**

**Data flow:**
- Load: `GET ${assetServerHttpEndpoint()}/database/kv?key=og-pack-manifest:v1` → `json.value`.
- Upload: `uploadOgPackImage(file, piece, kind)` (accepts `.png,.jpg,.jpeg,.webp`).
- Write: `POST ${assetServerHttpEndpoint()}/database/kv` with body `{ key: "og-pack-manifest:v1",
  value: nextManifest }` and `sessionAuthHeaders()` (admin auth). Persisted after *every* upload so
  a half-finished pack still shows what's done.

Feedback banner tones: info (`#eef4ff`/`#1d4ed8`), saved (`#e9f8ef`/`#15803d`), error
(`#fdecec`/`#b42318`). Messages include `` `Uploading ${PieceLabel} ${kind} art…` ``,
`` `${PieceLabel} ${kind} art published.` ``, and **"Upload failed."**

`OgPackManifest` (`characterCatalog.ts`):

```ts
export interface OgPackManifestEntry { assetId: string; assetUrl: string; objectName?: string; storage?: "gcs" | "local-disk"; bytes?: number; fileName?: string; }
export interface OgPackManifestPiece { board?: OgPackManifestEntry; black?: OgPackManifestEntry; card?: OgPackManifestEntry; }
export interface OgPackManifest { packId: string; version: number; uploadedAt: string; pieces: Partial<Record<CatalogPiece, OgPackManifestPiece>>; }
```

The base manifest written on first upload is `{ packId: "og", version: 1, uploadedAt: ISO,
pieces: {} }`. `CatalogPiece = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn"`.

`assetServerHttpEndpoint()` (`apps/player-app/src/app/shell/env.ts`) resolves the realtime/asset
server: `EXPO_PUBLIC_CHESSALIVE_REALTIME_HTTP` if set, else `${origin}/api` for non-localhost
origins, else the page origin on localhost, else `http://localhost:8990`.

---

## 15.7 Character Releases Admin (`CharacterReleasesAdmin.tsx`)

The monthly **Character Release** calendar curator. A release is a themed piece pair (today
King + Queen) earned through the monthly tier system, with three visual **variants**
(Base / Shadow / Shiny). This panel **curates** — each variant slot links to an *already-uploaded*
Piece Set (new sets are uploaded in the Piece Sets tab); it never re-uploads art.

Two-column layout (`styles.adminTabContent`, `flexDirection: "row"`, gap 16):

**Left rail (width 280):** header **"Releases"** + a **"+ New"** pill (`startNewRelease`). A
scrollable list (`maxHeight 540`) of release cards, each showing `characterName || "(unnamed)"`,
`` `${monthKey} · ${statusLabel}` ``, and `` `${filled}/${total} variant slots filled` ``. Selected
cards tint blue (`rgba(59,130,246,0.08)` bg, `0.5` border). Empty: **"No releases yet. Tap "+ New"
to create the first one."**

**Right editor:** when nothing is selected, an intro panel (subtitle **"Character Releases"**, copy
**"Each release defines a themed character pair (King + Queen) earned through the monthly tier
system. Each variant (Base / Shadow / Shiny) links to an existing Piece Set uploaded in the Piece
Sets tab."** + **"Select a release on the left, or create a new one to begin."**). When editing,
a scrollable form titled **"Edit Release"** / **"New Release"**:

Basic fields:
- **Character name** (`TextInput`, placeholder **"e.g. Scorpion"**) — required; blank →
  error **"Character name is required."**
- **Month (YYYY-MM)** (`TextInput`, placeholder **"2026-12"**) — a valid `YYYY-MM` recomputes
  `releaseStartsAt` (month start 00:00 UTC) and `releaseEndsAt` (month end 23:59:59 UTC).
- **Description (optional)** (multiline, placeholder **"Short note about the theme"**).
- **Status** — four pills from `STATUS_OPTIONS`:

| `CharacterReleaseStatus` | Label (`STATUS_LABEL`) |
| --- | --- |
| `upcoming` | `Upcoming` |
| `active` | `Active` |
| `distributed` | `Distributed` |
| `archived` | `Archived` |

**Variant Pieces matrix:** subtitle **"Variant Pieces"**, copy **"Link each variant to an existing
Piece Set. Higher variants are rarer rewards — Shiny King is reserved for the global Top 1%
Grandmaster tier each month."** Three tinted variant blocks (order `VARIANT_ORDER =
["base","shadow","shiny"]`):

| `CharacterVariant` | Label (`VARIANT_LABEL`) | Tint (`VARIANT_TINT`) |
| --- | --- | --- |
| `base` | `Base` | `rgba(148, 163, 184, 0.10)` (slate) |
| `shadow` | `Shadow` | `rgba(99, 102, 241, 0.12)` (indigo) |
| `shiny` | `Shiny` | `rgba(234, 179, 8, 0.14)` (gold) |

Each block has a `king` and `queen` row, each with a horizontal `PieceSetPicker` of all
uploaded sets (selected → blue `rgba(59,130,246,0.18)` bg, `0.6` border, weight 700). With no
sets: **"No piece sets uploaded yet — upload one in the Piece Sets tab first."**

**Actions:** **Save Release** (`saveRelease`, on success `` `${characterName} release saved.` ``),
and (for existing) **Delete** (`#ef4444`, with a `window.confirm("Delete release "{name}"?")`
guard, success **"Release deleted."**). The feedback `Text` colors by tone: error `#ef4444`,
saved `#22c55e`, saving `#3b82f6`, idle `#94a3b8`.

`CharacterRelease` (`packages/funny-mode/src/types.ts`): `{ id, characterName, monthKey (YYYY-MM),
description?, pieces: ["king","queen"], variants: { base, shadow, shiny } (each {king, queen}
holding a Piece-Set id), status, releaseStartsAt, releaseEndsAt, createdAt, updatedAt }`. Defaults
(`emptyRelease()`) target *next month* (`defaultMonthKey()`) with all six variant slots empty and
status `upcoming`. Persistence: `services.characterReleases.{listReleases,saveRelease,deleteRelease}`.
`completionCount()` counts filled slots across `VARIANT_ORDER × release.pieces`
(6 total for a King+Queen release).

The `inputStyle` constant: border `rgba(148,163,184,0.3)`, radius 8, bg `rgba(255,255,255,0.04)`,
text `#e2e8f0`, placeholder color `#94a3b8`.

---

## 15.8 Environment & data dependencies (quick reference)

| Concern | Env var / constant | Where | Effect |
| --- | --- | --- | --- |
| Admin identity | `adminEmail = "lakshminathanlaky@gmail.com"` | `AppModel.ts` | The only admin; matched by `isAdminUser` |
| Browser-local DB inspector | `EXPO_PUBLIC_CHESSALIVE_DISABLE_DATABASE_KV_MIRROR` (default **false**; legacy `...DISABLE_LOCAL_STORAGE` alias) | `AdminScreen.tsx` | Shared gameplay-KV parser; direct static env access; when truthy, only the gameplay DB KV mirror/inspector is disabled |
| Asset/KV/realtime endpoint | `EXPO_PUBLIC_CHESSALIVE_REALTIME_HTTP` | `env.ts` | Base for `/database/kv`, asset uploads; falls back to `${origin}/api` or `http://localhost:8990` |
| Ops data | `data.multiplayerStatus`, `data.databaseHealth`, `data.rooms` | `AppModel.ts` `DashboardData` | Drive the Ops/Rooms panels |

All admin-gated writes (asset upload, KV manifest write, piece-set/animation-set save) carry the
session auth header (`sessionAuthHeaders()`); the realtime server enforces admin (see **§10**).
The admin console performs **no** destructive DB operations — the Database Browser is strictly
read-only; deletes exist only for the admin's own piece sets, animation rules, and release-calendar
entries.
