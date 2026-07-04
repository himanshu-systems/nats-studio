# Subsystem Design — `[frontend-shell]`

> Owner: Frontend Team (lead). **Crates owned: none** — this is a frontend-only subsystem.
> Frontend surface owned: the React **application framework** (`apps/desktop/src/`) — the design system, the app shell (routing + dockview workspace + tab/split framework), the reusable component library (virtualized tables/lists, context menus, command palette, keyboard-shortcut engine), theming/tokens/Tailwind, motion, accessibility, and the **client-side state architecture** (Zustand UI/session stores, TanStack Query conventions, and the typed IPC client facade `packages/ns-bindings`).
>
> This document is the implementation contract for the frontend framework. It is subordinate to `docs/architecture/00-conventions-and-workspace.md` (the spine) and must never contradict it, and it must not contradict `sub-tauri-shell.md` (which owns the Tauri **transport**: command registration, `Channel`/`emit` plumbing, `EventBridge`, and the Tauri-native hooks). Where the spine or the shell doc defines a name (`useAppEvents`, `useStreamChannel`, `ns://…` events, `StreamEvent<T>`, query-key namespacing, the TanStack/Zustand split), this doc reuses it verbatim and builds the framework it plugs into.

---

## 1. Responsibilities & Boundaries

### 1.1 What frontend-shell IS
The frontend-shell is the **React application framework** every feature team builds their UI inside. It is the design language, the window chrome, the docking/tabbing workspace, the reusable UI primitives, and the client-state conventions. Concretely it owns:

1. **The app shell & workspace.** `AppShell` composition, the React Router tree, the **dockview** (ADR-0012) integration that turns routes into dockable/resizable/floatable panels, the tab system, and split views. Layout serialization to/from `layout_*` commands.
2. **The design system.** Design tokens (color/spacing/typography/radius/elevation/z-index/motion), the Tailwind preset that projects those tokens into utility classes, dark/light/high-contrast themes, the icon set, and the motion/animation vocabulary.
3. **Reusable primitives.** A headless-first component library: virtualized `DataTable`/`DataList` for huge datasets (connz rows, JetStream messages, KV entries, log lines), `ContextMenu`, `CommandPalette` (Cmd/Ctrl-K), `Dialog`/`Drawer`/`Popover`/`Toast`, `Tabs`, `SplitPane`, `Tree`, form controls, and skeleton/empty/error states.
4. **Interaction infrastructure.** A global **keyboard-shortcut engine** (scoped, chorded, conflict-checked), **focus management** (roving tabindex, focus traps, restore), and a **command registry** that both the palette and the native menu (`ns://menu/action`) dispatch into.
5. **Client-state architecture.** The Zustand store framework for UI/session state, the TanStack Query client + query-key factory + retry/invalidation conventions, and the boundary rule (server-state → Query, UI/session → Zustand) turned into lint-enforceable patterns.
6. **The typed IPC client facade.** `packages/ns-bindings` — the generated `types.ts` (from typeshare, owned upstream) plus the hand-maintained typed `invoke`/`Channel`/`listen` wrappers driven by `commands.manifest.ts`, exposing `ipc.<subsystem>.<method>(req)` to every feature team.
7. **Accessibility & internationalization scaffolding.** WCAG 2.1 AA baseline, ARIA patterns, reduced-motion, keyboard-only operability, and the i18n string-catalog plumbing (error-code → localized copy map from the spine error model).

### 1.2 What frontend-shell is NOT (hard boundaries)
- **No Rust.** Owns zero crates. It never defines DTOs (those are `ns-types`, owned by core-runtime), never registers `#[tauri::command]`, never emits Tauri events. It *consumes* the transport.
- **No Tauri transport.** The mechanics of `invoke`, `tauri::ipc::Channel`, `listen('ns://…')`, the `EventBridge`, and the `useAppEvents`/`useStreamChannel` hooks are **owned by `[tauri-shell]`** (`sub-tauri-shell.md` §6.2). Frontend-shell *defines the shape of the provider tree and the query cache those hooks write into*, and *consumes* those hooks. See §1.3 for the exact seam.
- **No feature panels.** Each feature team (jetstream, monitoring, pubsub, …) owns its own panel components and its own `queries/` + feature Zustand slices. Frontend-shell owns the *primitives, the shell they mount into, and the conventions they follow* — not their business screens.
- **No business logic / caching semantics of server data.** Retention, backpressure policy, and reconnection live in the Rust services; the frontend renders what it is told and folds stream frames into the Query cache.

### 1.3 The frontend-shell ↔ tauri-shell seam (explicit)
Both teams touch `apps/desktop/src/`. To avoid contradiction we split by **layer**, not by folder:

| Concern | Owner | Artifact |
|---|---|---|
| Transport: `invoke`, `Channel`, `listen`, generated `types.ts` | tauri-shell (produces) / frontend-shell (packages the facade) | `packages/ns-bindings` |
| `useAppEvents()` — routes `ns://…` events into cache/stores | **tauri-shell** (`sub-tauri-shell.md` §6.2) | `src/ipc/useAppEvents.ts` |
| `useStreamChannel<T>()` — owns a `Channel<StreamEvent<T>>`, cancels on unmount | **tauri-shell** | `src/ipc/useStreamChannel.ts` |
| The `QueryClient` instance, provider tree, key factory, retry policy | **frontend-shell** | `src/lib/query/*`, `src/app/Providers.tsx` |
| The Zustand store framework + UI/session slices | **frontend-shell** | `src/stores/*` |
| `AppShell`, router, dockview workspace, tabs, split | **frontend-shell** | `src/shell/*` |
| Design system, primitives, palette, shortcuts, a11y | **frontend-shell** | `src/design-system/*`, `src/components/*`, `src/interaction/*` |
| Native menu/tray glue (`ns://menu/action` listener) | tauri-shell provides the event; **frontend-shell** owns the `CommandRegistry` it dispatches into | shared, contract in §6.4 |

Contract: tauri-shell's transport hooks depend on frontend-shell's **query key factory** and **store selectors** as their write targets. Those are exported as stable TS interfaces (§7) so the seam is a typed API, not a folder fight.

### 1.4 Boundary diagram
```
   ┌──────────────────────── React WebView ────────────────────────┐
   │  frontend-shell (application framework)                        │
   │   Providers(ThemeProvider, QueryClientProvider, ShortcutScope, │
   │             CommandRegistry, Toaster, DockviewHost)            │
   │   AppShell ─ Router ─ Dockview workspace ─ Tabs/Split          │
   │   design-system (tokens/Tailwind/theme/icons/motion)          │
   │   primitives (DataTable, ContextMenu, CommandPalette, Dialog…) │
   │   stores (Zustand UI/session)   lib/query (keys, client)      │
   │        ▲ writes cache/stores            ▲ consumes             │
   │  ──────┼──────────────────────────────  │  ───────────────────│
   │  tauri-shell transport (owned elsewhere):                     │
   │   useAppEvents(listen ns://…) · useStreamChannel(Channel<T>)  │
   │   packages/ns-bindings: ipc.<sub>.<m>(req)  (typed invoke)    │
   └───────────────────────────────┬───────────────────────────────┘
                                   │ Tauri IPC (invoke / Channel / event)
                                   ▼   [ the only trust boundary ]
                         nats-studio (bin) + services
```

---

## 2. Rust Public Interface

**Frontend-shell owns no Rust crate and exposes no `#[tauri::command]`.** This section exists to state that explicitly and to define the *equivalent* public surface: the **TypeScript interfaces** other teams program against. These are the "traits" of a frontend framework — treat them as frozen contracts under the same discipline (breaking change → changelog + coordinated bump).

The only Rust-adjacent artifact frontend-shell **drives** (does not own) is the persisted UI state via `ns-storage` repos, through commands owned by `[storage]`:
- `layout_get` / `layout_set` (`LayoutRepo`) — dockview layout JSON per `(windowKind, connectionId?)`.
- `settings_get` / `settings_update` (`SettingsRepo`) — theme, density, reduced-motion, telemetry opt-in, shortcut overrides.

Any new UI-persistence need is raised as a PR to `[storage]` + a DTO PR to `[core-runtime]` (`ns-types`) — never a new frontend-owned table.

---

## 3. Design System

### 3.1 Token model
Tokens are the single source of visual truth, defined once as CSS custom properties and consumed everywhere via the Tailwind preset. Three tiers:

```
tier 1  primitives   --ns-gray-{50..950}, --ns-blue-500, radii, space scale, font stacks
tier 2  semantic      --ns-bg, --ns-bg-elevated, --ns-fg, --ns-fg-muted,
                      --ns-border, --ns-accent, --ns-danger, --ns-warn, --ns-ok,
                      --ns-focus-ring, --ns-selection
tier 3  component     --ns-table-row-h, --ns-panel-gap, --ns-titlebar-h, --ns-tab-h
```
Only tier-2/3 semantic tokens appear in components; primitives are referenced only inside token files. Theming = re-point tier-2 to different tier-1 values. This yields dark/light/high-contrast with no component changes.

```ts
// src/design-system/tokens.ts — the typed token contract
export interface SemanticTokens {
  bg: string; bgElevated: string; bgSunken: string;
  fg: string; fgMuted: string; fgSubtle: string;
  border: string; borderStrong: string;
  accent: string; accentFg: string;
  danger: string; warn: string; ok: string; info: string;
  focusRing: string; selection: string; overlay: string;
}
export type ThemeName = 'dark' | 'light' | 'high-contrast-dark' | 'high-contrast-light';
export interface Theme { name: ThemeName; tokens: SemanticTokens; scheme: 'dark' | 'light'; }
```

Themes are applied by stamping `data-theme` on `:root` (matches the Artifact/OS-theme convention) and letting CSS variables cascade. `prefers-color-scheme` selects the default; explicit user choice (persisted via `settings_*`) overrides.

### 3.2 Tailwind preset
`src/design-system/tailwind-preset.ts` maps semantic tokens into Tailwind theme keys so classes read `bg-bg`, `text-fg-muted`, `border-border`, `ring-focus-ring`. No raw hex in feature code — a lint rule (`no-restricted-syntax` on hex literals in `.tsx`) enforces it. Density (comfortable/compact) is a token multiplier on the space/row-height scale, toggled by `data-density`.

### 3.3 Iconography & motion
- **Icons**: a single tree-shakeable SVG set (lucide-react baseline) wrapped in an `<Icon name size />` component so we can swap the set and enforce sizing/`aria-hidden`. No inline SVG in feature code.
- **Motion**: a small `motion.ts` vocabulary — durations (`fast 120ms`, `base 200ms`, `slow 320ms`), easings, and named transitions (panel-slide, toast-in, palette-pop). All wrapped so `prefers-reduced-motion` collapses them to instant. Framer-motion is optional and confined to the design-system package.

### 3.4 Accessibility baseline (WCAG 2.1 AA)
- Every interactive primitive is keyboard operable and exposes correct ARIA roles/states (built on Radix primitives where practical for correct focus semantics).
- Visible focus ring driven by `--ns-focus-ring`; never `outline:none` without a replacement.
- Color contrast ≥ 4.5:1 for text, ≥ 3:1 for UI/graphics; the token palette ships a `pnpm test:contrast` validator that fails CI on regressions.
- Focus management utilities (§5.4), live-region announcer for async results (`aria-live=polite`), reduced-motion honored globally.

---

## 4. App Shell, Routing & Workspace

### 4.1 Provider tree
```tsx
// src/app/Providers.tsx  (frontend-shell owns the composition; tauri-shell hooks mount inside)
<ThemeProvider>                       // stamps data-theme/-density, subscribes settings_*
  <QueryClientProvider client={queryClient}>   // §6.2
    <CommandRegistryProvider>          // §5.3 — palette + menu dispatch target
      <ShortcutScopeProvider>          // §5.4 — global keymap root
        <TooltipProvider>
          <AppEventsBinder />          // renders tauri-shell's useAppEvents() (transport)
          <RouterProvider router={router} />
          <Toaster /> <CommandPalette /> <UpdateBanner /> <DeepLinkHandler />
        </TooltipProvider>
      </ShortcutScopeProvider>
    </CommandRegistryProvider>
  </QueryClientProvider>
</ThemeProvider>
```

### 4.2 Routes (React Router) — the shell tree
Matches `sub-tauri-shell.md` §6.1; frontend-shell owns the router config, feature teams mount subtrees:
```
/                          Dashboard              [dashboard]
/connections               Connection Manager     [connection-manager]
/connection/:id/pubsub     Pub/Sub                [pubsub]
/connection/:id/jetstream  JetStream              [jetstream]
/connection/:id/monitor    Monitoring             [monitoring]
/connection/:id/subjects   Subject Explorer       [subject-explorer]
/connection/:id/terminal   Terminal               [terminal]
/connection/:id/security   Account & Security     [account-security]
/settings                  Settings               [frontend-shell + storage]
/logs                      Logs                    [logging-observability]
```
The router chooses the *active connection context*; **workspace composition inside a route is dockview, not the router** (ADR-0012). A route renders a `WorkspaceHost` bound to a dockview instance; panels are added/removed/rearranged without navigation.

### 4.3 Dockview workspace framework
```ts
// src/shell/workspace/types.ts
export type PanelKind =
  | 'stream-list' | 'stream-detail' | 'message-inspector' | 'consumer-list'
  | 'kv-browser' | 'object-browser' | 'connz' | 'metrics' | 'subject-tree'
  | 'terminal' | 'logs' | 'publisher' | 'subscriber' | /* extensible */ string;

export interface PanelDescriptor<P = unknown> {
  kind: PanelKind;
  title: (params: P) => string;
  icon?: IconName;
  component: React.ComponentType<PanelProps<P>>;  // registered by feature teams
  singleton?: boolean;            // e.g. one terminal-per-connection group
  defaultLocation?: 'main' | 'right' | 'bottom' | 'float';
}
export interface WorkspaceApi {
  openPanel<P>(kind: PanelKind, params: P, opts?: OpenOpts): PanelId;
  closePanel(id: PanelId): void;
  focusPanel(id: PanelId): void;
  splitActive(dir: 'horizontal' | 'vertical'): void;
  serialize(): SerializedLayout;   // dockview JSON → layout_set
  restore(layout: SerializedLayout): void;
  onLayoutChange(cb: (l: SerializedLayout) => void): Dispose;  // debounced → layout_set
}
```
- **Panel registry**: feature teams register `PanelDescriptor`s at module load; the shell resolves `kind → component`. This decouples the workspace from features and is the extension point plugins (ADR-0014) later target.
- **Tabs**: dockview groups render as tab strips (reorderable, closable, overflow menu). Tab context menus come from the shared `ContextMenu` primitive.
- **Split views**: `splitActive`/drag-to-edge produces horizontal/vertical splits; sizes persisted in the layout JSON.
- **Floating groups**: supported for detachable inspectors (dockview floating groups).
- **Persistence**: `onLayoutChange` debounced (500ms) → `ipc.layout.set({ windowKind, connectionId, layoutJson })`; on mount → `layout_get` restores, falling back to a per-route default layout. SQLite is source of truth; `useLayoutStore` is a fast mirror (spine §10.2).

### 4.4 App chrome
- Custom title-bar region (frameless where the OS allows) hosting connection switcher, global search/palette trigger, and window controls on Windows/Linux; native traffic lights on macOS. Native menu is tauri-shell's; frontend-shell renders the in-window menubar variant on Windows/Linux and maps both into the `CommandRegistry`.
- **Connection context bar**: active connection + status pill (fed by `ns://connection/status`), gap indicator (spine §9.4 dropped-events), quick actions.

---

## 5. Reusable Primitives & Interaction

### 5.1 Virtualized DataTable / DataList
The workhorse for every large dataset (connz, messages, KV, logs). Built on TanStack Virtual + TanStack Table (headless), styled with tokens.

```ts
// src/components/data-table/types.ts
export interface DataTableProps<Row> {
  rows: Row[] | InfiniteRows<Row>;   // array OR cursor-paged source (spine §8.2)
  columns: ColumnDef<Row>[];
  rowKey: (r: Row) => string;
  estimateRowHeight?: number | ((r: Row) => number);  // variable-height (log/JSON)
  onRowContextMenu?: (r: Row, e: MouseEvent) => MenuModel;
  selection?: 'none' | 'single' | 'multi';
  sort?: SortState; onSortChange?: (s: SortState) => void;   // server-side sort
  sticky?: { header?: boolean; columns?: number };
  onEndReached?: () => void;          // fetchNextPage for infinite
  empty?: React.ReactNode; loading?: boolean; error?: NatsStudioError | null;
  density?: 'comfortable' | 'compact';
  ariaLabel: string;                  // required for a11y
}
```
Requirements: windowed rendering (only visible rows in DOM), 100k+ rows at 60fps, variable row heights for expandable JSON/log rows, keyboard row navigation (arrow/Home/End/PageUp-Down), column resize/reorder/pin, and a "follow tail" mode for live streams (auto-scroll unless the user scrolls up). Server-side sort/filter/paginate — the table never loads full datasets into memory; it drives `onEndReached → fetchNextPage` against a cursor source.

### 5.2 Context menus
`ContextMenu` (Radix-backed) driven by a declarative `MenuModel` (items, separators, submenus, icons, shortcuts, disabled/danger states, async actions with pending state). Right-click and keyboard (`Shift+F10`/`Menu` key) both open it. A single `useContextMenu(model)` hook wires any element.

### 5.3 Command palette (Cmd/Ctrl-K) & Command Registry
A **CommandRegistry** is the single dispatch surface for the palette, the native/in-window menu (`ns://menu/action`), and keyboard shortcuts — one command, many triggers.

```ts
// src/interaction/commands.ts
export interface Command {
  id: string;                         // 'jetstream.createStream', 'app.toggleTheme'
  title: string; subtitle?: string; icon?: IconName;
  group: 'navigation' | 'connection' | 'jetstream' | 'view' | 'app' | string;
  when?: (ctx: AppContext) => boolean;   // contextual availability (active connection etc.)
  shortcut?: KeyChord[];              // registered into the shortcut engine
  keywords?: string[];               // fuzzy-search boost
  run: (ctx: AppContext) => void | Promise<void>;
}
export interface CommandRegistry {
  register(cmd: Command | Command[]): Dispose;
  execute(id: string, ctx?: Partial<AppContext>): Promise<void>;
  search(query: string, ctx: AppContext): Command[];   // fuzzy, when-filtered
}
```
- Palette: fuzzy search (fzf-style), grouped results, recent commands, keyboard-first, `when`-filtered by current context (active connection, focused panel). Also supports *navigation targets* (jump to stream/subject) and *quick actions*.
- Menu actions (`ns://menu/action { id }`) and tray actions dispatch straight into `registry.execute(id)` — the menu never contains logic, only ids.

### 5.4 Keyboard-shortcut engine & focus management
```ts
// src/interaction/shortcuts.ts
export type KeyChord = string;        // 'Mod+K', 'Mod+Shift+P', 'g s' (sequence)
export interface ShortcutScope {
  bind(chord: KeyChord, commandId: string, opts?: { when?: When }): Dispose;
  push(): ShortcutScope;              // nested scope (modal/panel captures keys)
  pop(): void;
}
```
- Scopes stack: global → active panel → open modal. Innermost matching binding wins; conflicts are detected at registration and surfaced in a Settings "Keyboard" page (user overrides persist via `settings_*`).
- Cross-platform `Mod` = Cmd on macOS, Ctrl elsewhere. Sequences (`g` then `s`) supported.
- **Focus management** (`src/interaction/focus.ts`): focus traps for dialogs/palette, roving-tabindex helpers for lists/toolbars, focus restore on close, `useAutoFocus`, and a `<FocusScope>` wrapper. Skip-links and logical tab order enforced.

### 5.5 Other primitives
`Dialog`, `Drawer`, `Popover`, `Tooltip`, `Toast`/`Toaster`, `Tabs`, `SplitPane`, `Tree` (for subject/stream hierarchies, virtualized), `Resizable`, `Badge`/`StatusPill`, `Skeleton`, `EmptyState`, `ErrorState` (renders `NatsStudioError` by `code` with retry action), `CopyButton`, `JsonView`, `HexView`, and a Monaco wrapper (`<CodeEditor>` with JSON/YAML schema hooks, theme-synced). Monaco and xterm.js are wrapped so feature teams get theme-synced, disposed-correctly instances.

---

## 6. Client-State Architecture

### 6.1 The hard boundary (spine §10.2), made enforceable
- **TanStack Query owns ALL server-state** (anything originating from Rust/IPC): connections, streams, consumers, KV, objects, monitor snapshots, message history, services. Never mirrored into Zustand.
- **Zustand owns UI/session state only**: active connection selection, open tabs, dock layout mirror, panel sizes, theme, Monaco unsaved buffers, palette state, per-view filters, feature flags.
- Enforcement: an ESLint rule bans importing `ipc.*` inside `src/stores/*`, and bans storing IPC response types in Zustand state (type-level lint via a branded `ServerState<T>` marker). This makes the boundary a build failure, not a convention.

### 6.2 TanStack Query conventions
```ts
// src/lib/query/client.ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000, gcTime: 5 * 60_000,
      retry: (n, err) => (err as NatsStudioError).retriable && n < 3,   // spine error model
      retryDelay: expoBackoffJitter,
      refetchOnWindowFocus: false,   // desktop app; streams push updates instead
    },
    mutations: { retry: false },
  },
});
```
```ts
// src/lib/query/keys.ts — the shared key factory (frozen contract; tauri-shell writes into these)
export const qk = {
  app: { info: () => ['app','info'] as const, tasks: () => ['app','tasks'] as const },
  connection: { list: () => ['connection','list'] as const,
                status: (id: ConnectionId) => ['connection','status', id] as const },
  jetstream: { streams: (id: ConnectionId) => ['jetstream','streams', id] as const,
               stream:  (id: ConnectionId, n: string) => ['jetstream','stream', id, n] as const },
  monitor:  { varz: (id: ConnectionId) => ['monitor','varz', id] as const },
  settings: (section: string) => ['settings', section] as const,
  layout:   (windowId: string) => ['layout', windowId] as const,
  // …one namespaced factory per subsystem; feature teams extend under their prefix
};
```
- Query/mutation fns are the generated `ipc.*` wrappers. Mutations `invalidateQueries` by key prefix.
- **Streaming into the cache**: `useAppEvents()` (tauri-shell) folds `ns://…` events via `queryClient.setQueryData` rather than polling (spine §10.2). Frontend-shell provides the **cache-fold helpers** (`foldMetricsTick`, `appendMessagePage`, `patchStreamInfo`) so folds are consistent and bounded (drop-oldest for unbounded live lists mirrors backend retention).
- **Suspense + error boundaries**: route/panel-level `<Suspense>` with skeletons; a shared `<QueryErrorBoundary>` renders `ErrorState` by `code` and offers retry.

### 6.3 Zustand store framework
Stores are small, sliced, and (where persisted) a **mirror** of SQLite — never the source of truth.

```ts
// src/stores/index.ts — the owned UI/session stores
useLayoutStore        // dockview layout JSON per window, panel sizes, active tab  (mirror of layout_*)
useSessionStore       // active connectionId, open tabs, focused window/panel
useUiPrefsStore       // theme, density, reducedMotion, telemetryOptIn            (mirror of settings_*)
useCommandPaletteStore// palette open/query/recent
useShortcutStore      // user keymap overrides                                    (mirror of settings_*)
useNotificationStore  // in-app toast queue (ephemeral)
useStreamRegistryStore// active subscription/session ids owned by THIS window (cleanup/debug)
```
Pattern: each store is `create<Slice>()(persist?(immer(...)))`. Persisted slices use a **debounced write-through** middleware that pushes to `settings_*`/`layout_*` and treats the command result as authoritative (last-writer = SQLite). A `useHydrateFromBackend()` hook seeds stores from `settings_get`/`layout_get` at boot. Selectors are exported (`selectActiveConnectionId`) so tauri-shell's transport hooks and feature code read via stable selectors, not raw store shape.

### 6.4 Typed IPC client facade (`packages/ns-bindings`)
The generated `types.ts` (typeshare, upstream) + a hand-maintained typed wrapper layer:
```ts
// packages/ns-bindings/src/client.ts
export const ipc = {
  app: { info: () => invokeTyped<AppInfoDto>('app_info', undefined), /* … */ },
  jetstream: {
    listStreams: (req: ListStreamsRequest) => invokeTyped<StreamPage>('jetstream_list_streams', req),
  },
  pubsub: {
    subscribe: (req: SubscribeRequest, onEvent: (e: StreamEvent<SubMessageDto>) => void)
      => streamTyped('pubsub_subscribe', req, onEvent),   // returns { subscriptionId, cancel() }
  },
  layout: { get: (req) => …, set: (req) => … },
  settings: { get: (req) => …, update: (req) => … },
} as const;
```
- `invokeTyped` wraps Tauri `invoke`, rehydrates `IpcError` into a `NatsStudioError` (typed, `code`/`retriable`/`correlationId`), so every call site gets typed errors.
- `streamTyped` wraps a `Channel<StreamEvent<T>>` + companion cancel command (the mechanics are tauri-shell's `useStreamChannel`; the *typed surface* is here).
- Driven by `commands.manifest.ts` pairing each command name → Request/Response types; a renamed command/DTO breaks the TS build (spine §8.5). Frontend-shell owns the wrapper ergonomics and the `NatsStudioError` class; tauri-shell owns the `app_*`/`window_*`/`update_*` manifest entries.

---

## 7. IPC Commands & Events

### 7.1 Commands exposed
**None.** Frontend-shell registers no `#[tauri::command]`.

### 7.2 Commands consumed (representative — drives, does not own)
`app_info`, `app_list_tasks`, `app_log_report` (UI errors → `log_report`), `settings_get`/`settings_update`, `layout_get`/`layout_set`, plus every feature command through the `ipc.*` facade. The shell's own recurring calls: `settings_*` (theme/prefs/shortcuts), `layout_*` (workspace), `app_log_report` (frontend error reporting → the shared tracing pipeline, spine §12), `app_info` (version/schema badge).

### 7.3 Events emitted
**None.** Frontend-shell emits no Tauri events (only the `EventBridge` may — spine §9).

### 7.4 Events consumed (via tauri-shell's `useAppEvents`)
The framework provides the **routing table** that maps each `ns://…` event to a cache-fold or store action; `useAppEvents` executes it:
| Event | Handled by frontend-shell framework |
|---|---|
| `ns://connection/status` | `queryClient.setQueryData(qk.connection.status(id))` + status pill |
| `ns://monitor/metrics` | `foldMetricsTick` into `qk.monitor.*` (coalesced upstream) |
| `ns://jetstream/stream` / `consumer-lag` | patch stream/consumer cache |
| `ns://subject/activity` | fold into subject view cache (rate-limited upstream) |
| `ns://log` | append to logs virtualized list (bounded ring in UI) |
| `ns://task/progress` | `useNotificationStore`/progress UI |
| `ns://notification` | `useNotificationStore` toast (never dropped) |
| `ns://plugin` | plugin registry refresh |
| `ns://update/*`, `ns://deeplink`, `ns://menu/action`, `ns://window/*` | `UpdateBanner` / `DeepLinkHandler` / `CommandRegistry.execute` |

The **gap indicator**: when a synthetic "n events dropped" `ns://notification` arrives or a per-topic `seq` gap is detected, the framework marks the affected views stale and triggers a background refetch.

---

## 8. Data Model

**Frontend-shell owns no SQLite tables** (only `ns-storage` has SQL — spine §11). It *drives* two repos through commands owned by `[storage]`:
- `LayoutRepo` → `layouts(window_kind TEXT, connection_id TEXT?, layout_json TEXT, updated_at)` — serialized dockview layout.
- `SettingsRepo` → `settings(key TEXT PK, value_json TEXT, updated_at)` — frontend keys: `ui.theme`, `ui.density`, `ui.reducedMotion`, `ui.telemetryOptIn`, `ui.shortcuts` (override map), `ui.startupRoute`, `ui.table.<view>.columns` (widths/order/pins).

**Client-only ephemeral state**: Zustand stores (§6.3), in-memory Query cache, and a small `localStorage`/`sessionStorage` cache for pre-hydration UI (theme applied before the first `settings_get` returns, to avoid a flash). `localStorage` holds only non-authoritative mirrors keyed `ns.ui.*`; SQLite remains source of truth.

**DTOs consumed** (owned by `ns-types`): `AppInfoDto`, `StreamEvent<T>`, `IpcError`, `SettingsDto`, `LayoutDto`, all feature Request/Response DTOs. Frontend-shell defines **no** DTOs; UI-only view-models are derived client-side from these.

---

## 9. Dependencies

**Depends on (frontend):**
- `[tauri-shell]` — transport: `packages/ns-bindings` generated types + `invoke`/`Channel`/`listen` mechanics; `useAppEvents`/`useStreamChannel` hooks; `ns://…` event contract; `StreamEvent<T>` type.
- `[core-runtime]` (`ns-types`) — the frozen DTO/error contract (`IpcError`, `ErrorCode`, event payloads) that shapes the client facade and error rendering.
- `[storage]` — `settings_*`/`layout_*` commands for UI persistence.

**Depended on by (frontend):** **every feature team** — dashboard, connection-manager, pubsub, jetstream, monitoring, subject-explorer, message-inspector, terminal, account-security, logging-observability, and the plugin UI. They consume the design system, primitives (`DataTable`, `ContextMenu`, palette, shortcuts), the workspace panel registry, the Query key factory, the Zustand framework, and the `ipc.*` facade.

**Third-party (pinned in package.json):** react 18, react-router, @tanstack/react-query, @tanstack/react-virtual, @tanstack/react-table, zustand, tailwindcss, dockview-react, radix-ui primitives, lucide-react, monaco-editor (`@monaco-editor/react`), xterm.js, echarts (`echarts-for-react`), immer, a fuzzy-search lib (fzf/cmdk). No runtime CDN — everything bundled (mirrors the strict-CSP posture).

---

## 10. Concurrency, Async & Backpressure (frontend)

The backend guarantees bounded, coalesced, cancellable streams (spine §9). Frontend-shell's job is to *not undo that* and to keep the WebView at 60fps:

1. **Virtualize everything large.** No unbounded DOM. `DataTable`/`Tree`/logs render only visible rows; live lists cap in-UI history (drop-oldest) mirroring backend retention, with a "load more" cursor for history.
2. **Fold, don't poll.** Live data enters via `useAppEvents`/`useStreamChannel` → `setQueryData`. `refetchOnWindowFocus:false`. This avoids request storms; polling only for endpoints without a push channel.
3. **Coalesce on the render path.** High-rate cache folds (metrics ticks, subject activity, message frames) are batched via `queueMicrotask`/rAF-batched `setQueryData` and React 18 automatic batching so a burst yields one commit, not N. Charts (ECharts) update on a rAF tick, not per-frame.
4. **Backpressure surfacing, not blocking.** `StreamEvent::Dropped { droppedSinceLast }` renders a "sampling / N dropped" badge; `Lagged` gap notifications trigger stale-mark + background refetch. The UI never blocks the producer (it can't — it's the other side of the IPC boundary).
5. **Cancellation on unmount.** `useStreamChannel` (tauri-shell) cancels via the companion `*_cancel` command when a panel unmounts; `useStreamRegistryStore` tracks active ids so panel/window close cleans up (belt-and-suspenders with the backend drop-watchdog).
6. **Off-main-thread work.** JSON/hex formatting of large payloads and fuzzy-search indexing run in a Web Worker; Monaco/ECharts tokenization stays off the main thread where the libs allow it.
7. **Request dedup & cancellation.** TanStack Query dedups in-flight identical keys; navigation aborts stale fetches. Mutations are optimistic where safe (rename tab, reorder columns) with rollback on `IpcError`.
8. **Startup latency.** Route-level code-splitting (lazy panels), theme applied from `localStorage` mirror pre-hydration to avoid FOUC, Query cache lazily populated per active view. Monaco/xterm/ECharts are lazy-imported on first panel use.

---

## 11. Test Plan

### 11.1 Unit (Vitest + React Testing Library, jsdom)
- **Design tokens/contrast**: `test:contrast` asserts every semantic token pair in every theme meets WCAG AA; snapshot of resolved CSS variables per theme.
- **Primitives**: `DataTable` — windowing (only visible rows in DOM for 100k rows), variable heights, keyboard nav, follow-tail, server-sort callbacks, empty/loading/error states; `ContextMenu` — model → items, keyboard open, submenu focus; `CommandPalette` — fuzzy ranking, `when`-filtering, recent; `Dialog`/`Drawer` — focus trap + restore.
- **Shortcut engine**: scope stacking (innermost wins), `Mod` platform mapping, sequence chords, conflict detection, user-override merge.
- **Command registry**: register/execute/search, `when` gating, dispose leaks.
- **State**: Query key factory stability (snapshot), retry-policy honors `retriable`, cache-fold helpers (`foldMetricsTick` coalescing, `appendMessagePage` cursor + drop-oldest), Zustand persist write-through debounce + hydrate-from-backend, and the **boundary lint** (a meta-test that the ESLint rule flags `ipc.*` in `src/stores/*`).
- **IPC facade**: `invokeTyped` rehydrates `IpcError` → `NatsStudioError` (code/retriable/correlationId); `streamTyped` cancel path; manifest ↔ types.ts consistency check.

### 11.2 Integration (Vitest + a mock IPC transport)
- A `mockIpc` implementing the `ipc.*` facade against `ns-testkit`-shaped fixtures. Render `AppShell` with mock transport and assert: route → workspace host → panel registry resolves feature panels; layout serialize/restore round-trips through mock `layout_*`; theme/density change persists through mock `settings_*` and re-stamps `data-theme`.
- **Event routing**: feed synthetic `ns://…` events into a mock `useAppEvents`; assert correct cache-fold/store mutation and gap-indicator on a simulated `Lagged` notification.
- **Streaming panel**: mount a subscriber panel, push `Ready`/`Item`/`Dropped`/`Done` frames, assert list virtualization + dropped badge, then unmount → assert cancel command called and `useStreamRegistryStore` cleared.

### 11.3 Visual regression & a11y
- **Storybook** for every primitive × theme (dark/light/high-contrast) × density; **Chromatic/Playwright screenshot** diffs gate PRs on unintended visual change.
- **axe-core** automated a11y pass on every story + key routes (0 serious/critical violations); manual keyboard-only + screen-reader (NVDA/VoiceOver) checklist per release.

### 11.4 E2E (WebdriverIO + tauri-driver, real app + real `nats-server`)
Shared with tauri-shell's harness (pinned prerequisites, `tools/versions.toml`):
- **Workspace**: open panels, drag-split, float a panel, reload app → layout restored from SQLite.
- **Command palette / shortcuts**: `Mod+K` opens palette, execute "Create Stream" navigates + acts; a user-remapped shortcut persists across restart.
- **Huge dataset**: subscribe under a publish storm → assert table stays responsive (frame budget), dropped badge appears, follow-tail behaves, scroll-up pauses tail.
- **Theme/a11y**: toggle theme (persists, no FOUC on relaunch), reduced-motion honored, tab-order + focus-restore through a modal.
- **Error rendering**: force an `IpcError` (e.g. `CONNECTION_TIMEOUT`) → `ErrorState` shows localized copy + correlationId + retry; retry drives a refetch.

### 11.5 Performance budgets (CI)
- Cold start to interactive < 1.5s (mock backend); table scroll ≥ 55fps p95 at 100k rows; palette open < 50ms; no memory growth over a 10-min stream-storm soak (heap snapshot diff). Enforced via a Playwright perf trace job (soft gate → hard once baselined).

### 11.6 CI gates
- `pnpm gen:types && git diff --exit-code` (DTO/facade drift — shared with spine).
- ESLint boundary rules (no `ipc.*` in stores; no raw hex in `.tsx`; no `outline:none`).
- `test:contrast`, `axe` story pass, Chromatic diff, unit/integration coverage threshold.

---

## 12. Risks & Open Questions

**Risks**
1. **Ownership seam with `[tauri-shell]`.** `useAppEvents`/`useStreamChannel`/`src/ipc/*` are claimed by tauri-shell (`sub-tauri-shell.md` §6.2) while frontend-shell owns the provider tree/cache/stores they write into. Mitigation: the typed seam in §1.3/§7.4 (key factory + selectors as the contract); a shared CODEOWNERS on `src/app/Providers.tsx` and `commands.manifest.ts`. **Must be ratified with tauri-shell before implementation.**
2. **dockview + React 18 concurrent / StrictMode** double-mount can desync layout serialization. Mitigation: idempotent `restore`, debounced `serialize`, and a StrictMode soak test.
3. **Virtualization × variable heights × live tail** is the hardest UI: measurement thrash on expandable JSON rows can drop frames. Mitigation: measured-height cache, `overscan` tuning, worker-side pre-measure, perf budget in CI.
4. **Monaco + xterm + ECharts bundle weight & memory**; three heavy libs. Mitigation: lazy-load per panel, single shared instance where possible, dispose on unmount, memory soak test.
5. **Theme flash (FOUC)** before `settings_get` resolves. Mitigation: `localStorage` pre-hydration mirror; accept it as non-authoritative.
6. **Boundary erosion** (feature teams stuffing server-state into Zustand). Mitigation: the type-level + ESLint enforcement in §6.1, reviewed in CI.

**Open questions**
1. **Design system as a package (`packages/ns-ui`) vs in-app (`src/design-system`)?** A package enables Storybook isolation and a future second surface (CLI web UI), at monorepo-wiring cost. Leaning `src/design-system` now, extract later. Needs sign-off.
2. **Radix vs fully-headless bespoke primitives** for the a11y-critical set (menu/dialog/palette) — Radix gives correct focus semantics fast but adds deps and styling indirection. Leaning Radix for the hard ones, bespoke for tables/trees.
3. **i18n scope for v1** — ship English-only with the string-catalog plumbing in place (error-code→copy map) but defer additional locales? Coordinate with product.
4. **Command/shortcut authority** — is the `CommandRegistry` frontend-shell-owned with feature teams registering into it (proposed), or co-owned with tauri-shell (which sources native-menu ids)? Proposal: frontend-shell owns the registry; tauri-shell's menu emits ids into it.
5. **Per-window state isolation** in multi-window mode — are Zustand stores per-window (each WebView is its own JS context, so yes by default) but layout/settings shared via SQLite; confirm no cross-window store assumptions.
6. **Plugin UI extension surface** (ADR-0014 Phase 1) — how do in-process plugins register `PanelDescriptor`s/commands safely, and what capability gating applies at the frontend registry level? Coordinate with `[plugin-architecture]`.
