import { useLiquidDropIndicator } from "@app/shell/LiquidTabs";
import { localDatabaseStorageDisabled } from "@chessalive/services";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, Text, useWindowDimensions, View } from "react-native";
import { AudioWaveform, Database, Gauge, Layers, Mic, Shield } from "@shared/icons";
import { aiBlue, aiTeal, appColors, isUltraWide, styles } from "@app/shell/theme";
import { emitGlassClick } from "@app/shell/liquidGlass";
import { ActionButton, Panel, StatLine } from "@shared/primitives";
import { AnimationStudioAdmin } from "./AnimationStudioAdmin";
import { StitchStudioAdmin } from "./StitchStudioAdmin";
import { VoiceStudioAdmin } from "./VoiceStudioAdmin";

function FeatureGrid({ children }: { children: ReactNode }) {
  // Ultra-wide (iMac): clamp + center the ops console so tables/panels don't run 2400px wide.
  const ultra = isUltraWide(useWindowDimensions().width);
  return <View style={[styles.featureGrid, ultra && { alignSelf: "center", maxWidth: 1560, width: "100%" }]}>{children}</View>;
}

function AdminOpsPanel({ data }: { data: any }) {
  const firstRoom = data.rooms?.[0];
  return (
    <Panel title="Realtime Admin">
      <View style={styles.serverStatusRow}>
        <Gauge size={18} color={data.multiplayerStatus?.online ? "#16a34a" : "#64748b"} strokeWidth={2.5} />
        <View style={[styles.serverDot, data.multiplayerStatus?.online && styles.serverDotOnline]} />
        <Text style={styles.serverStatusText}>
          {data.multiplayerStatus?.online ? `${data.multiplayerStatus.activeRooms} rooms · ${data.multiplayerStatus.p95LatencyMs}ms p95` : "Realtime server offline"}
        </Text>
      </View>
      <StatLine label="Endpoint" value={data.multiplayerStatus?.endpoint ?? "local"} />
      <StatLine label="Storage" value={data.multiplayerStatus?.storage ? "event log" : data.databaseHealth?.driver ?? "local"} />
      <StatLine label="DB cost" value={`$${data.databaseHealth?.estimatedMonthlyCostUsd ?? 0}/mo`} />
      <StatLine label="Records" value={String(data.databaseHealth?.records ?? 0)} />
      {firstRoom && (
        <View style={styles.roomCard}>
          <Text style={styles.roomCode}>{firstRoom.code}</Text>
          <Text style={styles.muted}>{firstRoom.status} · {firstRoom.timeControl} · {firstRoom.region}</Text>
          <Text style={styles.muted}>{firstRoom.players.white?.displayName ?? "Open"} vs {firstRoom.players.black?.displayName ?? "open seat"}</Text>
        </View>
      )}
    </Panel>
  );
}

function safeDatabasePreview(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function StudioLikeTab({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.actionPill, active && styles.actionPillActive, pressed && styles.pressed]}>
      <Text style={[styles.actionPillText, active && styles.actionPillTextActive]}>{label}</Text>
    </Pressable>
  );
}

type DatabaseSource = "remote" | "local";
type DatabaseGroup = {
  description: string;
  id: string;
  name: string;
  recordCount: number;
  tableCount: number;
  tables: any[];
};

const browserNamespace = "chessalive:v1";
const localStorageDisabled = localDatabaseStorageDisabled(
  process.env.EXPO_PUBLIC_CHESSALIVE_DISABLE_DATABASE_KV_MIRROR ??
    process.env.EXPO_PUBLIC_CHESSALIVE_DISABLE_LOCAL_STORAGE,
);

function databaseGroupForTable(table: any) {
  const id = String(table.id ?? "").toLowerCase();
  const name = String(table.name ?? "").toLowerCase();
  if (id.includes("assets") || name.includes("asset")) {
    return { description: "Uploaded piece images, GLB metadata, and object-storage references.", id: "assets", name: "Assets" };
  }
  if (id.includes("users") || name.includes("user") || name.includes("profile") || name.includes("setting")) {
    return { description: "Player profiles, settings, auth-derived records, puzzle ratings, and user state.", id: "users", name: "Users + Profiles" };
  }
  if (id.includes("leaderboard") || name.includes("leaderboard")) {
    return { description: "Computed leaderboard snapshots and ranking tables.", id: "leaderboards", name: "Leaderboards" };
  }
  if (id.includes("puzzle") || name.includes("puzzle") || name.includes("learn")) {
    return { description: "Puzzle progress, rating state, attempts, and learning records.", id: "learn", name: "Learn + Puzzles" };
  }
  if (id.includes("room") || id.includes("game") || name.includes("room") || name.includes("game")) {
    return { description: "Game rooms, snapshots, move records, and match event streams.", id: "games", name: "Games + Rooms" };
  }
  if (id.includes("chat") || id.includes("social") || name.includes("chat") || name.includes("social")) {
    return { description: "Chat, private room, friend, and social event data.", id: "social", name: "Social + Chat" };
  }
  if (id.includes("event") || name.includes("event")) {
    return { description: "Durable append-only event streams grouped away from main records.", id: "events", name: "Event Streams" };
  }
  if (id.includes("kv") || name.includes("key/value") || name.includes("cache")) {
    return { description: "Low-level key/value records and browser cache state.", id: "kv", name: "Key/Value + Cache" };
  }
  if (id.includes("app") || name.includes("app")) {
    return { description: "Global app state such as piece sets, animation sets, and configuration.", id: "app", name: "App Configuration" };
  }
  return { description: "Other records not yet mapped to a product domain.", id: "other", name: "Other" };
}

function groupDatabaseTables(tables: any[]): DatabaseGroup[] {
  const groups = new Map<string, DatabaseGroup>();
  tables.forEach((table) => {
    const meta = databaseGroupForTable(table);
    const existing = groups.get(meta.id);
    if (existing) {
      existing.tables.push(table);
      existing.recordCount += Number(table.recordCount ?? 0);
      existing.tableCount += 1;
      return;
    }
    groups.set(meta.id, {
      ...meta,
      recordCount: Number(table.recordCount ?? 0),
      tableCount: 1,
      tables: [table],
    });
  });
  const preferredOrder = ["app", "users", "games", "learn", "social", "leaderboards", "assets", "events", "kv", "other"];
  return [...groups.values()].sort((a, b) => preferredOrder.indexOf(a.id) - preferredOrder.indexOf(b.id));
}

function parseStorageValue(raw: string | null) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function localStorageRef() {
  if (localStorageDisabled) return undefined;
  return (globalThis as { localStorage?: Storage }).localStorage;
}

function localStorageKeys() {
  const storage = localStorageRef();
  if (!storage) return [];
  return Array.from({ length: storage.length })
    .map((_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key));
}

function collectBrowserLocalTables() {
  const keys = localStorageKeys();
  const eventKeys = keys.filter((key) => key.startsWith(`${browserNamespace}:events:`));
  const chessAliveKvKeys = keys.filter((key) => key.startsWith(`${browserNamespace}:`) && !key.includes(":events:"));
  const otherKeys = keys.filter((key) => !key.startsWith(`${browserNamespace}:`));
  const tables: any[] = [];
  if (chessAliveKvKeys.length) {
    tables.push({
      description: "ChessAlive browser key/value records stored in this browser.",
      id: "browser:kv",
      name: "Browser KV cache",
      recordCount: chessAliveKvKeys.length,
      type: "browser-local",
    });
  }
  eventKeys.forEach((key) => {
    const stream = key.replace(`${browserNamespace}:events:`, "");
    const events = parseStorageValue(localStorageRef()?.getItem(key) ?? null) as unknown;
    tables.push({
      description: `Browser-local events for ${stream}.`,
      id: `browser:events:${stream}`,
      name: `${stream} events`,
      recordCount: Array.isArray(events) ? events.length : 0,
      type: "browser-local",
    });
  });
  if (otherKeys.length) {
    tables.push({
      description: "Other localStorage records visible to this origin.",
      id: "browser:other",
      name: "Other browser keys",
      recordCount: otherKeys.length,
      type: "browser-local",
    });
  }
  return tables;
}

function collectBrowserLocalRows(tableId: string, limit: number) {
  const storage = localStorageRef();
  if (!storage) return [];
  const keys = localStorageKeys();
  if (tableId === "browser:kv") {
    return keys
      .filter((key) => key.startsWith(`${browserNamespace}:`) && !key.includes(":events:"))
      .slice(0, limit)
      .map((key) => ({
        data: { key: key.replace(`${browserNamespace}:`, ""), value: parseStorageValue(storage.getItem(key)) },
        id: key.replace(`${browserNamespace}:`, ""),
      }));
  }
  if (tableId.startsWith("browser:events:")) {
    const stream = tableId.replace("browser:events:", "");
    const events = parseStorageValue(storage.getItem(`${browserNamespace}:events:${stream}`));
    return (Array.isArray(events) ? events : []).slice(-limit).map((event: any, index: number) => ({
      data: { createdAt: event?.createdAt, stream: event?.stream ?? stream, ...(event?.payload ?? event ?? {}) },
      id: `${stream}-${index}`,
    }));
  }
  if (tableId === "browser:other") {
    return keys
      .filter((key) => !key.startsWith(`${browserNamespace}:`))
      .slice(0, limit)
      .map((key) => ({
        data: { key, value: parseStorageValue(storage.getItem(key)) },
        id: key,
      }));
  }
  return [];
}

function AdminDatabaseBrowser({ data, reload, services }: { data: any; reload: () => void | Promise<void>; services: any }) {
  const [source, setSource] = useState<DatabaseSource>("remote");
  const [tables, setTables] = useState<any[]>(data.databaseTables ?? []);
  const [localTables, setLocalTables] = useState<any[]>(() => collectBrowserLocalTables());
  const activeTables = source === "remote" ? tables : localTables;
  const groups = useMemo(() => groupDatabaseTables(activeTables), [activeTables]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const [selectedTableId, setSelectedTableId] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [isLoadingTables, setIsLoadingTables] = useState(false);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedTable = activeTables.find((table) => table.id === selectedTableId) ?? null;
  const persistenceMode = data.databaseHealth?.driver?.startsWith("gcp") ? "Permanent GCP storage" : "Local fallback";
  const assetStore = data.databaseHealth?.driver === "gcp-firestore-gcs" ? "Cloud Storage bucket" : "Local uploads folder";

  useEffect(() => {
    setTables(data.databaseTables ?? []);
  }, [data.databaseTables]);

  useEffect(() => {
    setSelectedGroupId("");
    setSelectedTableId("");
    setRows([]);
  }, [source]);

  useEffect(() => {
    let cancelled = false;
    async function loadRows() {
      if (!selectedTable?.id) {
        setRows([]);
        return;
      }
      try {
        setIsLoadingRows(true);
        setError(null);
        const nextRows =
          source === "remote"
            ? await services.database.listRows(selectedTable.id, 100)
            : collectBrowserLocalRows(selectedTable.id, 100);
        if (!cancelled) setRows(nextRows);
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          setError(caught instanceof Error ? caught.message : "Could not load table rows.");
        }
      } finally {
        if (!cancelled) setIsLoadingRows(false);
      }
    }
    void loadRows();
    return () => {
      cancelled = true;
    };
  }, [selectedTable?.id, services.database, source]);

  async function refreshTables() {
    try {
      setIsLoadingTables(true);
      setError(null);
      if (source === "local") {
        setLocalTables(collectBrowserLocalTables());
        setSelectedGroupId("");
        setSelectedTableId("");
        setRows([]);
        return;
      }
      const nextTables = await services.database.listTables();
      setTables(nextTables);
      setSelectedGroupId("");
      setSelectedTableId("");
      setRows([]);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh database tables.");
    } finally {
      setIsLoadingTables(false);
    }
  }

  return (
    <>
      <Panel title="Database Browser">
        <View style={styles.databaseStatusGrid}>
          <View style={styles.databaseStatusCard}>
            <Database size={20} color={aiBlue} strokeWidth={2.5} />
            <Text style={styles.databaseStatusLabel}>Driver</Text>
            <Text style={styles.databaseStatusValue}>{data.databaseHealth?.driver ?? "browser-local"}</Text>
          </View>
          <View style={styles.databaseStatusCard}>
            <Shield size={20} color={aiTeal} strokeWidth={2.5} />
            <Text style={styles.databaseStatusLabel}>Mode</Text>
            <Text style={styles.databaseStatusValue}>{persistenceMode}</Text>
          </View>
          <View style={styles.databaseStatusCard}>
            <Layers size={20} color="#9b6bdf" strokeWidth={2.5} />
            <Text style={styles.databaseStatusLabel}>Assets</Text>
            <Text style={styles.databaseStatusValue}>{assetStore}</Text>
          </View>
          <View style={styles.databaseStatusCard}>
            <Gauge size={20} color="#c47b17" strokeWidth={2.5} />
            <Text style={styles.databaseStatusLabel}>Records</Text>
            <Text style={styles.databaseStatusValue}>{String(data.databaseHealth?.records ?? 0)}</Text>
          </View>
        </View>
        <Text style={styles.muted}>
          Chat events, game snapshots, profiles, puzzle progress, uploaded asset metadata, piece sets, and animation sets are visible here when the selected backend is reachable.
        </Text>
        <View style={styles.rowWrap}>
          <StudioLikeTab active={source === "remote"} label="Remote / Server" onPress={() => setSource("remote")} />
          <StudioLikeTab active={source === "local"} label={localStorageDisabled ? "KV Mirror Disabled" : "This Browser"} onPress={() => setSource("local")} />
          <ActionButton label={isLoadingTables ? "Refreshing..." : "Refresh Database"} onPress={() => void refreshTables()} accent />
        </View>
        {error && <Text style={styles.saveFeedbackError}>{error}</Text>}
      </Panel>
      <Panel title={source === "remote" ? "Remote Data Groups" : "Browser LocalStorage Groups"}>
        <View style={styles.databaseBrowserGrid}>
          <View style={styles.databaseTableList}>
            {groups.length === 0 ? (
              <View style={styles.databaseEmptyState}>
                <Text style={styles.lessonStepTitle}>No data groups detected</Text>
                <Text style={styles.muted}>{source === "remote" ? "Start the realtime server or configure GCP persistence to inspect durable data." : localStorageDisabled ? "The gameplay database KV mirror is disabled by EXPO_PUBLIC_CHESSALIVE_DISABLE_DATABASE_KV_MIRROR. Other required identity and preference storage has separate controls." : "No ChessAlive gameplay KV records exist in this browser yet."}</Text>
              </View>
            ) : (
              groups.map((group) => {
                const active = group.id === selectedGroup?.id;
                return (
                  <Pressable
                    key={group.id}
                    onPress={() => {
                      setSelectedGroupId(group.id);
                      setSelectedTableId("");
                      setRows([]);
                    }}
                    style={({ pressed }) => [styles.databaseTableCard, active && styles.databaseTableCardActive, pressed && styles.pressed]}
                  >
                    <View style={styles.databaseTableHeader}>
                      <Text numberOfLines={1} style={[styles.databaseTableName, active && styles.databaseTableNameActive]}>{group.name}</Text>
                      <Text style={[styles.databaseTableCount, active && styles.databaseTableCountActive]}>{group.recordCount}</Text>
                    </View>
                    <Text numberOfLines={2} style={styles.databaseTableDescription}>{group.description}</Text>
                    <Text numberOfLines={1} style={styles.databaseTablePath}>{group.tableCount} object group{group.tableCount === 1 ? "" : "s"}</Text>
                  </Pressable>
                );
              })
            )}
          </View>
          <View style={styles.databaseTableList}>
            {!selectedGroup ? (
              <View style={styles.databaseEmptyState}>
                <Text style={styles.lessonStepTitle}>Select a group</Text>
                <Text style={styles.muted}>Rows are hidden until you pick a logical object group, then one concrete table or stream.</Text>
              </View>
            ) : (
              selectedGroup.tables.map((table) => {
                const active = table.id === selectedTable?.id;
                return (
                  <Pressable key={table.id} onPress={() => setSelectedTableId(table.id)} style={({ pressed }) => [styles.databaseTableCard, active && styles.databaseTableCardActive, pressed && styles.pressed]}>
                    <View style={styles.databaseTableHeader}>
                      <Text numberOfLines={1} style={[styles.databaseTableName, active && styles.databaseTableNameActive]}>{table.name}</Text>
                      <Text style={[styles.databaseTableCount, active && styles.databaseTableCountActive]}>{table.recordCount}</Text>
                    </View>
                    <Text numberOfLines={2} style={styles.databaseTableDescription}>{table.description ?? table.type}</Text>
                    <Text numberOfLines={1} style={styles.databaseTablePath}>{table.id}</Text>
                  </Pressable>
                );
              })
            )}
          </View>
          <View style={styles.databaseRowsPanel}>
            <View style={styles.databaseRowsHeader}>
              <View>
                <Text style={styles.animationStudioSubTitle}>{selectedTable?.name ?? "Select an object"}</Text>
                <Text numberOfLines={1} style={styles.databaseTablePath}>{selectedTable?.id ?? "No table selected"}</Text>
              </View>
              <Text style={styles.databaseRowsBadge}>{isLoadingRows ? "Loading" : `${rows.length}/100 rows`}</Text>
            </View>
            {rows.length === 0 ? (
              <View style={styles.databaseEmptyState}>
                <Text style={styles.lessonStepTitle}>{isLoadingRows ? "Loading rows..." : selectedTable ? "No rows in this object" : "Rows hidden"}</Text>
                <Text style={styles.muted}>{selectedTable ? "Rows appear here as JSON previews so nested documents are still readable." : "Choose a group and then an object to load the top 100 rows."}</Text>
              </View>
            ) : (
              rows.map((row) => (
                <View key={`${selectedTable?.id}-${row.id}-${row.path ?? ""}`} style={styles.databaseRowCard}>
                  <View style={styles.databaseRowHeader}>
                    <Text numberOfLines={1} style={styles.databaseRowId}>{row.id}</Text>
                    {row.path && <Text numberOfLines={1} style={styles.databaseRowPath}>{row.path}</Text>}
                  </View>
                  <Text selectable style={styles.databaseJson}>{safeDatabasePreview(row.data)}</Text>
                </View>
              ))
            )}
          </View>
        </View>
      </Panel>
    </>
  );
}

const ADMIN_SECTIONS = [
  { key: "studio", label: "Piece Sets + Animations", icon: Layers, description: "Board piece art, GLB animation sets, and the ceremony/character release tools that build on them." },
  { key: "voice", label: "Voice Studio", icon: Mic, description: "Render, translate, and publish the coach + lesson voice lines with Gemini TTS." },
  { key: "voiceJobs", label: "Voice Jobs", icon: Shield, description: "Run resumable Academy narration jobs and track Telugu progress." },
  { key: "stitch", label: "Stitch Studio", icon: AudioWaveform, description: "Hand-align the coach's stitched lines on a waveform, preview any placeholder value live, and publish — plus re-render or rewrite any line." },
  { key: "database", label: "Database", icon: Database, description: "Browse durable server data and this browser's local records, grouped by product area." },
  { key: "ops", label: "Ops, Rooms", icon: Gauge, description: "Live realtime-server health and the current game rooms." },
] as const;

export function AdminScreen({ data, reload, services, settings, setSettings }: { data: any; reload: () => void | Promise<void>; services: any; settings: any; setSettings: (settings: any) => void }) {
  const [adminSection, setAdminSection] = useState<"studio" | "voice" | "voiceJobs" | "stitch" | "database" | "ops">("studio");
  // LIQUID SECTION TABS: same app-wide water-drop indicator as every other switcher.
  const { indicator: adminDrop, onItemLayout: onAdminTabLayout, emitRipple: adminRipple } = useLiquidDropIndicator({ activeKey: adminSection, glow: aiBlue, inset: 1 });
  const activeMeta = ADMIN_SECTIONS.find((s) => s.key === adminSection) ?? ADMIN_SECTIONS[0];
  return (
    <FeatureGrid>
      <Panel title="Admin">
        <View style={[styles.adminSectionTabs, { position: "relative" }]}>
          {adminDrop}
          {/* The droplet swims at zIndex 0 BEHIND the pills — the active pill goes
              transparent (actionPill's solid surface fill would hide the drop) and
              its label takes the glow color instead of the on-solid white. */}
          {ADMIN_SECTIONS.map(({ key: section, label, icon: Icon }) => {
            const active = adminSection === section;
            return (
              <Pressable
                key={section}
                onPress={() => setAdminSection(section)}
                onLayout={(e) => onAdminTabLayout(section, e)}
                onHoverIn={() => { if (active) adminRipple(0.5); }}
                onPressIn={() => {
                  if (active) adminRipple(1);
                  emitGlassClick("nav");
                }}
                style={({ pressed }) => [
                  styles.actionPill,
                  { alignItems: "center", flexDirection: "row", gap: 6, zIndex: 1 },
                  active && { backgroundColor: "transparent", borderColor: "transparent" },
                  pressed && styles.pressed,
                ]}
              >
                {/* Active label/icon = theme ink, NOT aiBlue: blue on the blue-tinted droplet
                    glass fails contrast in dark mode — the drop's glow does the accent work. */}
                <Icon color={active ? appColors.aiInk : appColors.aiMuted} size={14} strokeWidth={2.5} />
                <Text style={[styles.actionPillText, active && { color: appColors.aiInk, fontWeight: "800" }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={[styles.muted, { marginTop: 10 }]}>{activeMeta.description}</Text>
      </Panel>
      {adminSection === "studio" ? (
        <AnimationStudioAdmin data={data} reload={reload} services={services} settings={settings} setSettings={setSettings} />
      ) : adminSection === "voice" ? (
        <VoiceStudioAdmin />
      ) : adminSection === "voiceJobs" ? (
        <Panel title="Academy Voice Jobs">
          <Text style={styles.muted}>Open the local resumable renderer console to run Telugu narration with Gemini 2.5 or ElevenLabs.</Text>
          <ActionButton label="Open Voice Job Console" onPress={() => void Linking.openURL("http://127.0.0.1:8787")} />
          <Text style={[styles.muted, { marginTop: 8 }]}>Start it first with: npm run voice:console</Text>
        </Panel>
      ) : adminSection === "stitch" ? (
        <StitchStudioAdmin />
      ) : adminSection === "database" ? (
        <AdminDatabaseBrowser data={data} reload={reload} services={services} />
      ) : (
        <>
          <AdminOpsPanel data={data} />
          <Panel title="Room Admin">
            {!data.rooms?.length ? (
              <Text style={styles.muted}>No active rooms.</Text>
            ) : (
              data.rooms.map((room: any) => (
                <View key={room.id} style={styles.lessonStep}>
                  <Text style={styles.lessonStepTitle}>{room.code}</Text>
                  <Text style={styles.muted}>{room.status} · {room.timeControl} · {room.region}</Text>
                  <StatLine label="Spectators" value={String(room.spectators)} />
                  <StatLine label="Updated" value={new Date(room.lastActivityAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
                </View>
              ))
            )}
          </Panel>
        </>
      )}
    </FeatureGrid>
  );
}
