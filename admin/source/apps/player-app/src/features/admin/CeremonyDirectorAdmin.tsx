// Ceremony Director — the super-advanced admin configurator for the cinematic ceremonies
// (opening kings' dance + checkmate crane-shot finisher). It edits a plain-data
// CeremonyConfig (packages/funny-mode/src/ceremonyConfig.ts) that hangs off the selected
// AnimationSet (`animationSet.ceremonies`) and is interpreted at runtime by the cinematic
// engine in features/play/cinematic/. The director NEVER talks to the engine directly —
// it previews by handing the real stage component a synthetic ceremony object built from
// the live-edited config, exactly the shape the game builds (cinematicTypes.ts contract).
//
// Design rules honoured here:
// - No silent activation: editing/saving NEVER flips the player's active settings (that
//   auto-activate behavior in the Animation Studio is a known complaint). Going live is the
//   explicit, two-tap "★ Make LIVE for all players" button.
// - Zero-asset friendly: every dropdown has a "(procedural)" empty option and the preview
//   plays with 0 uploaded GLBs — the engine falls back to procedural Staunton actors.
// - Clip casting lists ALL clips compatible with a piece, NOT just clips of the currently
//   slotted GLB (the hidden-clips bug in the Animation Sets tab timeline editor).
import { PieceKind } from "@chessalive/chess-core";
import {
  ActorClipRole,
  AnimationClip,
  AnimationSet,
  ApproachStyle,
  CameraShot,
  CameraShotKind,
  CameraTarget,
  CeremonyConfig,
  CheckmateCeremonyConfig,
  LoserExit,
  LoserReaction,
  MorphStyle,
  OpeningCeremonyConfig,
  PieceSet,
  ProceduralDanceStyle,
  StrikeStyle,
  defaultCheckmateStoryboard,
  defaultOpeningStoryboard,
  loserReactionDescription,
  loserReactionLabel,
  loserReactions,
  resolveCeremonyConfig,
} from "@chessalive/funny-mode";
import { Component, ComponentType, ReactNode, Suspense, createElement, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { styles } from "@app/shell/theme";
import { canLoadGlbPath } from "@assets/glbAssets";
import { snapshotFromMoves } from "@gameplay/chessState";
import { resolveBoardTheme } from "@shared/AppModel";
import { StatLine } from "@shared/primitives";
import type { CinematicActorAssets, CinematicCeremonyStageProps, ResolvedCinematicCeremony } from "@features/play/cinematic/cinematicTypes";

// The REAL runtime engine, loaded lazily so three.js never enters the eager bundle (Metro
// hoists shared deps of async chunks into the eagerly-loaded __common, so a static import
// here would make every app user pay the three.js cost — see the GLB preview's lazy
// pattern). The engine module is written in parallel with this file; we code strictly
// against cinematicTypes.ts and accept either a named or a default export.
const LazyCinematicStage = lazy(async () => {
  const mod = (await import("@features/play/cinematic/CinematicCeremonyStage")) as unknown as {
    CinematicCeremonyStage?: ComponentType<CinematicCeremonyStageProps>;
    default?: ComponentType<CinematicCeremonyStageProps>;
  };
  const Stage = mod.CinematicCeremonyStage ?? mod.default;
  if (!Stage) throw new Error("CinematicCeremonyStage has no usable export");
  return { default: Stage };
});

type Feedback = { tone: "error" | "saved" | "saving"; text: string } | null;

type CeremonyDirectorAdminProps = {
  /** Selected animation set in the parent studio — the director's initial selection. */
  animationSetId: string;
  data: any;
  /** Selected piece set in the parent studio — scopes which animation sets we list. */
  pieceSetId: string;
  reload: () => void | Promise<void>;
  services: any;
  /** Parent feedback banner (renders at the bottom of the studio Panel). */
  setFeedback: (feedback: Feedback) => void;
  setSettings: (settings: any) => void;
  settings: any;
};

const pieceOrder: PieceKind[] = ["p", "n", "b", "r", "q", "k"];
const pieceNames: Record<PieceKind, string> = { b: "Bishop", k: "King", n: "Knight", p: "Pawn", q: "Queen", r: "Rook" };
const pieceGlyphs: Record<PieceKind, string> = { b: "♗", k: "♔", n: "♘", p: "♙", q: "♕", r: "♖" };

// The clip roles the engine can ask an actor to play (ceremonyConfig.ActorClipRole).
const clipRoleDefs: Array<{ hint: string; label: string; role: ActorClipRole }> = [
  { hint: "Standing loop between beats", label: "Idle", role: "idle" },
  { hint: "The opening greeting / the victory dance", label: "Dance", role: "dance" },
  { hint: "The march across the board", label: "Walk", role: "walk" },
  { hint: "The finishing blow on the king", label: "Strike", role: "strike" },
  { hint: "The winner's gloat in the king's face (mockery finisher)", label: "Taunt", role: "taunt" },
  { hint: "The mated king's sad reaction", label: "Sad", role: "sad" },
  { hint: "The king's STANDING head-down defeat (mockery finisher)", label: "Defeat", role: "defeat" },
  { hint: "Victory pose under the crane-out", label: "Celebrate", role: "celebrate" },
  { hint: "The king's terrified cower before the blow", label: "Fear", role: "fear" },
  { hint: "The king's knocked-flying hit reaction", label: "Hit", role: "hit" },
];

const danceStyleDefs: Array<{ description: string; label: string; value: ProceduralDanceStyle }> = [
  { description: "Springy vertical bounces in place.", label: "Bounce", value: "bounce" },
  { description: "Full-body twirls on the spot.", label: "Spin", value: "spin" },
  { description: "Quick side-to-side shuffle.", label: "Shimmy", value: "shimmy" },
  { description: "Little hops with quarter turns.", label: "Hop-turn", value: "hop-turn" },
  { description: "Leans and sways like a stadium wave.", label: "Wave", value: "wave" },
];

const morphStyleDefs: Array<{ description: string; label: string; value: MorphStyle }> = [
  { description: "The flat art stands up and gains depth.", label: "Rise", value: "rise" },
  { description: "Squash, then the model pops in with a bounce.", label: "Pop", value: "pop" },
  { description: "The art twirls upright while the model spins in.", label: "Spiral", value: "spiral" },
  { description: "A light column drops and the model materialises.", label: "Beam", value: "beam" },
];

const approachStyleDefs: Array<{ description: string; label: string; value: ApproachStyle }> = [
  { description: "Steady determined march.", label: "Walk", value: "walk" },
  { description: "Bouncy hops square to square.", label: "Hop", value: "hop" },
  { description: "Smooth menacing slide.", label: "Glide", value: "glide" },
  { description: "Heavy steps that shake the ground.", label: "Stomp", value: "stomp" },
  { description: "Weaving side-to-side taunt.", label: "Zigzag", value: "zigzag" },
];

const strikeStyleDefs: Array<{ description: string; label: string; value: StrikeStyle }> = [
  {
    description: "No blow at all — the winner gloats in his face and the score's hit lands on the king's head dropping. Pairs with the Dejected reaction.",
    label: "Taunt",
    value: "taunt",
  },
  { description: "Bruce-Lee high kick, held through the bullet-time freeze.", label: "Kick", value: "kick" },
  { description: "Coil, one explosive kung-fu jab, follow through.", label: "Punch", value: "punch" },
  { description: "A forward thrust into the king.", label: "Lunge", value: "lunge" },
  { description: "Leap up and smash down.", label: "Jump smash", value: "jump-smash" },
  { description: "A comedic head-first ram.", label: "Headbutt", value: "headbutt" },
  { description: "A spinning roundhouse hit.", label: "Spin attack", value: "spin-attack" },
];

const loserExitDefs: Array<{ description: string; label: string; value: LoserExit }> = [
  { description: "Stays lying where he fell, part of the final tableau.", label: "Stay down", value: "stay" },
  { description: "Sinks down into the board.", label: "Sink", value: "sink" },
  { description: "Fades away like a ghost.", label: "Fade", value: "fade" },
  { description: "Tips over and drops off the board edge.", label: "Fall off", value: "fall-off" },
];

const shotKindOptions: CameraShotKind[] = ["top-down", "dive-in", "follow", "close-up", "duel", "orbit", "rise-away"];
const shotTargetOptions: CameraTarget[] = ["board-center", "attacker", "loser", "midpoint"];

// Scholar's mate — a real, legal mate so the checkmate preview exercises the engine with a
// genuine position (the white queen walks h5→f7 into the black king on e8).
const scholarsMateMoves = [
  { from: "e2", to: "e4" },
  { from: "e7", to: "e5" },
  { from: "f1", to: "c4" },
  { from: "b8", to: "c6" },
  { from: "d1", to: "h5" },
  { from: "g8", to: "f6" },
  { from: "h5", to: "f7" },
] as Parameters<typeof snapshotFromMoves>[0];

// Fool's mate — the BLACK-side audition: the black queen (d8→h4) mates the white king on e1,
// so the director can preview the dedicated dark-side castings (q:b / k as loser) exactly as
// a black-piece win renders in-game.
const foolsMateMoves = [
  { from: "f2", to: "f3" },
  { from: "e7", to: "e5" },
  { from: "g2", to: "g4" },
  { from: "d8", to: "h4" },
] as Parameters<typeof snapshotFromMoves>[0];

function fileBasename(path?: string) {
  if (!path) return "";
  const clean = path.split("?")[0];
  return clean.slice(clean.lastIndexOf("/") + 1);
}

function formatSeconds(ms: number, decimals = 1) {
  return `${(Math.max(0, ms) / 1000).toFixed(decimals)}s`;
}

// ── Small local UI primitives (mirroring the Animation Studio idiom) ───────────────────────

function DirectorButton({ accent, children, disabled, onPress }: { accent?: boolean; children: ReactNode; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.actionPill, accent && styles.actionPillActive, disabled && styles.actionButtonDisabled, pressed && !disabled && styles.pressed]}>
      <Text style={[styles.actionPillText, accent && styles.actionPillTextActive]}>{children}</Text>
    </Pressable>
  );
}

/** Segmented control with an optional one-line description of the ACTIVE option below it. */
function Segment<T extends string>({ onChange, options, value }: { onChange: (value: T) => void; options: Array<{ description?: string; label: string; value: T }>; value: T }) {
  const active = options.find((option) => option.value === value);
  return (
    <View style={{ gap: 6 }}>
      <View style={[styles.speedSegment, { flexWrap: "wrap" }]}>
        {options.map((option) => (
          <Pressable key={option.value} onPress={() => onChange(option.value)} style={[styles.speedOption, value === option.value && styles.speedOptionActive]}>
            <Text style={[styles.speedOptionText, value === option.value && styles.speedOptionTextActive]}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
      {active?.description ? <Text style={[styles.muted, { fontSize: 12 }]}>{active.description}</Text> : null}
    </View>
  );
}

/** Labeled slider row — a DOM range input (same trick as the studio's DOM selects). */
function SliderRow({ label, max, min, onChange, step, value, valueLabel }: { label: string; max: number; min: number; onChange: (value: number) => void; step: number; value: number; valueLabel: string }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={[styles.muted, { fontWeight: "700" }]}>{label}</Text>
        <Text style={{ color: "#2563eb", fontVariant: ["tabular-nums"], fontWeight: "800" }}>{valueLabel}</Text>
      </View>
      {createElement("input", {
        max,
        min,
        onChange: (event: any) => onChange(Number(event.target.value)),
        step,
        style: { accentColor: "#2563eb", cursor: "pointer", width: "100%" },
        type: "range",
        value,
      })}
    </View>
  );
}

/** On/off row — a whole-row Pressable so the touch target is generous. */
function ToggleRow({ hint, label, onChange, value }: { hint?: string; label: string; onChange: (value: boolean) => void; value: boolean }) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        {
          alignItems: "center",
          backgroundColor: value ? "rgba(37,99,235,0.06)" : "rgba(148,163,184,0.08)",
          borderColor: value ? "rgba(37,99,235,0.3)" : "rgba(148,163,184,0.2)",
          borderRadius: 12,
          borderWidth: 1,
          flexDirection: "row",
          gap: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
        },
        pressed && styles.pressed,
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 13.5, fontWeight: "700" }}>{label}</Text>
        {hint ? <Text numberOfLines={2} style={[styles.muted, { fontSize: 12 }]}>{hint}</Text> : null}
      </View>
      <View style={{ backgroundColor: value ? "#2563eb" : "#cbd5e1", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
        <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "600" }}>{value ? "On" : "Off"}</Text>
      </View>
    </Pressable>
  );
}

const domSelectStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #dbe7f2",
  borderRadius: 12,
  color: "#20242a",
  font: "inherit",
  fontWeight: 700,
  minHeight: 40,
  outline: "none",
  padding: "0 10px",
  width: "100%",
};

function SelectRow({ onChange, options, value }: { onChange: (value: string) => void; options: Array<{ label: string; value: string }>; value: string }) {
  return createElement(
    "select",
    { onChange: (event: any) => onChange(event.target.value), style: domSelectStyle, value },
    options.map((option) => createElement("option", { key: option.value || "(empty)", value: option.value }, option.label)),
  );
}

/**
 * Numeric input with a local typing draft: parsing every keystroke ("2.", "-", "") would
 * fight the user mid-typing, so we keep the raw text while focused, commit every VALID
 * parse immediately (live preview follows along) and snap back to the model value on blur.
 */
function NumericInput({ onCommit, value }: { onCommit: (value: number) => void; value: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput
      autoCapitalize="none"
      keyboardType="numeric"
      onBlur={() => setDraft(null)}
      onChangeText={(text) => {
        setDraft(text);
        const parsed = Number(text.replace(/[^0-9.-]/g, ""));
        if (Number.isFinite(parsed)) onCommit(parsed);
      }}
      placeholder="0"
      placeholderTextColor="#8aa0b6"
      style={[styles.animationStudioInput, { minHeight: 38, paddingVertical: 6 }]}
      value={draft ?? String(Math.round(value * 10) / 10)}
    />
  );
}

// Render-throw guard for the lazy 3D stage: a WebGL/context failure in the preview must
// degrade to a friendly note, never crash the whole admin screen (the findNodeHandle-style
// render-throw trap). Keyed by playKey upstream so Restart also clears a previous error.
class PreviewErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <View style={{ alignItems: "center", gap: 6, padding: 18 }}>
          <Text style={[styles.muted, { fontWeight: "800" }]}>3D preview failed to start</Text>
          <Text style={[styles.muted, { fontSize: 12, textAlign: "center" }]}>{this.state.error.message}. In the game this ceremony auto-skips safely. Press ↺ Restart to retry.</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

// ── The director ────────────────────────────────────────────────────────────────────────────

export function CeremonyDirectorAdmin({ animationSetId, data, pieceSetId, reload, services, setFeedback, setSettings, settings }: CeremonyDirectorAdminProps) {
  const allAnimationSets: AnimationSet[] = data.animationSets ?? [];
  const clips: AnimationClip[] = data.animationClips ?? [];
  const pieceSet: PieceSet | null = (data.pieceSets ?? []).find((set: PieceSet) => set.id === pieceSetId) ?? null;
  // Sets scoped to the studio's selected piece set — the same scoping as the Animation Sets tab.
  const animationSets = useMemo(
    () => allAnimationSets.filter((set) => !pieceSetId || set.pieceSetId === pieceSetId),
    [allAnimationSets, pieceSetId],
  );

  const [selectedSetId, setSelectedSetId] = useState(animationSetId || animationSets[0]?.id || "");
  const selectedSet = animationSets.find((set) => set.id === selectedSetId) ?? animationSets[0];
  useEffect(() => {
    if (animationSets.length && !animationSets.some((set) => set.id === selectedSetId)) setSelectedSetId(animationSets[0].id);
  }, [animationSets, selectedSetId]);

  // The full working config. Hydrated from the persisted set through resolveCeremonyConfig so
  // configs saved before a knob existed still expose every field; `savedJson` is the dirty baseline.
  const [config, setConfig] = useState<CeremonyConfig>(() => resolveCeremonyConfig(selectedSet?.ceremonies));
  const savedJsonRef = useRef(JSON.stringify(resolveCeremonyConfig(selectedSet?.ceremonies)));
  useEffect(() => {
    const hydrated = resolveCeremonyConfig(selectedSet?.ceremonies);
    setConfig(hydrated);
    savedJsonRef.current = JSON.stringify(hydrated);
    // updatedAt in the deps: after save+reload the fresh set re-hydrates (matching what we saved);
    // it also means an external edit to the same set refreshes us rather than being clobbered.
  }, [selectedSet?.id, selectedSet?.updatedAt]);
  const dirty = Boolean(selectedSet) && JSON.stringify(config) !== savedJsonRef.current;

  const patchOpening = (patch: Partial<OpeningCeremonyConfig>) => setConfig((current) => ({ ...current, opening: { ...current.opening, ...patch } }));
  const patchCheckmate = (patch: Partial<CheckmateCeremonyConfig>) => setConfig((current) => ({ ...current, checkmate: { ...current.checkmate, ...patch } }));

  // Clip casting state — which piece of the 6-piece roster is being taught.
  const [rosterPiece, setRosterPiece] = useState<PieceKind>("k");
  // Camera storyboard sub-tab + live-preview mode.
  const [storyTab, setStoryTab] = useState<"opening" | "checkmate">("opening");
  const [previewMode, setPreviewMode] = useState<"opening" | "checkmate">("opening");
  // Which piece delivers the mate in the checkmate preview — every piece can be the finisher
  // in-game, so the director must be able to audition each one's walk/strike/celebrate casting.
  const [previewAttacker, setPreviewAttacker] = useState<PieceKind>("q");
  const [previewMatingColor, setPreviewMatingColor] = useState<"w" | "b">("w");

  // "Make LIVE" is destructive-ish (flips every player's default) — use a two-tap confirm
  // like a mini confirm modal without the modal.
  const [liveConfirm, setLiveConfirm] = useState(false);
  useEffect(() => {
    if (!liveConfirm) return;
    const timer = setTimeout(() => setLiveConfirm(false), 4000);
    return () => clearTimeout(timer);
  }, [liveConfirm]);

  function setClipRole(piece: PieceKind, role: ActorClipRole, clipId: string) {
    setConfig((current) => {
      const forPiece = { ...(current.clipRolesByPiece?.[piece] ?? {}) };
      if (clipId) forPiece[role] = clipId;
      else delete forPiece[role];
      const byPiece = { ...(current.clipRolesByPiece ?? {}) };
      if (Object.keys(forPiece).length) byPiece[piece] = forPiece;
      else delete byPiece[piece];
      return { ...current, clipRolesByPiece: Object.keys(byPiece).length ? byPiece : undefined };
    });
  }

  // ── Save path ──────────────────────────────────────────────────────────────────────────

  // Guard rails applied on save (not per keystroke, so editing stays fluid): authored shots
  // sorted ascending by start, durations clamped to ≥ 200ms.
  function normalizeShots(shots?: CameraShot[]): CameraShot[] | undefined {
    if (!shots?.length) return undefined;
    return [...shots]
      .map((shot) => ({ ...shot, durationMs: Math.max(200, Math.round(shot.durationMs)), startsAtMs: Math.max(0, Math.round(shot.startsAtMs)) }))
      .sort((a, b) => a.startsAtMs - b.startsAtMs);
  }

  function normalizedConfigForSave(current: CeremonyConfig): CeremonyConfig {
    return {
      ...current,
      checkmate: { ...current.checkmate, camera: normalizeShots(current.checkmate.camera) },
      opening: { ...current.opening, camera: normalizeShots(current.opening.camera) },
    };
  }

  async function saveCeremonies() {
    if (!selectedSet) return;
    const normalized = normalizedConfigForSave(config);
    setFeedback({ tone: "saving", text: "Saving ceremony configuration..." });
    try {
      // Deliberately NOT activateForPlay here — save must never silently change what players see.
      await services.animationStudio.saveAnimationSet({ ...selectedSet, ceremonies: normalized });
      setConfig(normalized);
      savedJsonRef.current = JSON.stringify(normalized);
      setFeedback({ tone: "saved", text: `Ceremonies saved on "${selectedSet.name}". Use ★ Make LIVE to ship them to players.` });
      await reload();
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not save the ceremony configuration." });
    }
  }

  async function makeLiveForAllPlayers() {
    if (!selectedSet) return;
    if (!liveConfirm) {
      setLiveConfirm(true);
      return;
    }
    setLiveConfirm(false);
    setFeedback({ tone: "saving", text: "Making this ceremony set live for all players..." });
    try {
      // One default across ALL animation sets (not just this piece set's): clear the others first
      // so a crash mid-way can only leave zero defaults, never two.
      for (const set of allAnimationSets) {
        if (set.id !== selectedSet.id && set.isDefault) {
          await services.animationStudio.saveAnimationSet({ ...set, isDefault: false });
        }
      }
      const saved = await services.animationStudio.saveAnimationSet({
        ...selectedSet,
        ceremonies: normalizedConfigForSave(config),
        isDefault: true,
      });
      savedJsonRef.current = JSON.stringify(resolveCeremonyConfig(saved.ceremonies));
      // Also activate on the admin's own account so "what I just shipped" is what they see in Play.
      const nextSettings = { ...settings, animationSetId: saved.id, animationsEnabled: true, enabled: true, pieceSetId: saved.pieceSetId };
      setSettings(nextSettings);
      await services.settings.saveSettings(data.user?.id ?? "admin-local", nextSettings);
      setFeedback({ tone: "saved", text: `★ "${saved.name}" is now the LIVE ceremony set for all players.` });
      await reload();
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not make this set live." });
    }
  }

  async function createCeremonySet() {
    if (!pieceSet) return;
    setFeedback({ tone: "saving", text: "Creating a ceremony set..." });
    try {
      const created = await services.animationStudio.createAnimationSet({
        description: "Cinematic opening + checkmate ceremonies.",
        name: `${pieceSet.name} Ceremonies`,
        pieceSetId: pieceSet.id,
      });
      setSelectedSetId(created.id);
      setFeedback({ tone: "saved", text: `Created "${created.name}" — configure and Save.` });
      await reload();
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not create the ceremony set." });
    }
  }

  // ── Camera storyboard editing ──────────────────────────────────────────────────────────

  const storyConfig = storyTab === "opening" ? config.opening : config.checkmate;
  const storyIsCustom = Boolean(storyConfig.camera?.length);
  const derivedDefaultShots = useMemo(
    () => (storyTab === "opening" ? defaultOpeningStoryboard(config.opening) : defaultCheckmateStoryboard(config.checkmate)),
    [config.checkmate, config.opening, storyTab],
  );
  const editableShots = storyIsCustom ? storyConfig.camera! : [];

  function setStoryShots(shots: CameraShot[] | undefined) {
    if (storyTab === "opening") patchOpening({ camera: shots });
    else patchCheckmate({ camera: shots });
  }

  function toggleCustomStoryboard(custom: boolean) {
    // Going custom copies the CURRENT derived defaults so the admin edits from a sensible
    // baseline; going back to default just drops the authored shots (engine re-derives live).
    setStoryShots(custom ? derivedDefaultShots.map((shot) => ({ ...shot })) : undefined);
  }

  function updateShot(index: number, patch: Partial<CameraShot>) {
    setStoryShots(editableShots.map((shot, shotIndex) => (shotIndex === index ? { ...shot, ...patch } : shot)));
  }

  function addShot() {
    const last = editableShots[editableShots.length - 1];
    const startsAtMs = last ? last.startsAtMs + last.durationMs : 0;
    setStoryShots([
      ...editableShots,
      { durationMs: 800, id: `shot-${Date.now()}`, kind: "close-up", label: "New shot", startsAtMs, target: "attacker", transition: "blend" },
    ]);
  }

  function duplicateShot(index: number) {
    const source = editableShots[index];
    if (!source) return;
    const copy = { ...source, id: `shot-${Date.now()}`, startsAtMs: source.startsAtMs + source.durationMs };
    setStoryShots([...editableShots.slice(0, index + 1), copy, ...editableShots.slice(index + 1)]);
  }

  function deleteShot(index: number) {
    setStoryShots(editableShots.filter((_, shotIndex) => shotIndex !== index));
  }

  function moveShot(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= editableShots.length) return;
    const next = [...editableShots];
    const [shot] = next.splice(index, 1);
    next.splice(target, 0, shot);
    setStoryShots(next);
  }

  // ── Live preview (the REAL engine on a synthetic ceremony) ─────────────────────────────

  const [playKey, setPlayKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubMs, setScrubMs] = useState(0);
  const startedAtRef = useRef(Date.now());
  const [previewFrameWidth, setPreviewFrameWidth] = useState(0);
  // R33 — PREVIEW-ONLY movement-set override: audition any registered movement set's
  // choreography over this set's cast without touching the editor state or the save path
  // (Save still writes the set's OWN ceremonies; movement sets are authored by script).
  // null = preview the editor's config as-is.
  const [previewMovementSetId, setPreviewMovementSetId] = useState<string | null>(null);
  const movementSets: Array<{ id: string; name: string; ceremonies?: Partial<CeremonyConfig> }> = data.movementSets ?? [];
  const previewResolved = useMemo(() => {
    const override = previewMovementSetId ? movementSets.find((m) => m.id === previewMovementSetId) : undefined;
    if (!override?.ceremonies) return resolveCeremonyConfig(config);
    // Same contract as the runtime (effectiveCeremoniesForSet): the movement set brings the
    // choreography, the animation set keeps the casting.
    return resolveCeremonyConfig({ ...override.ceremonies, clipRolesByPiece: config.clipRolesByPiece });
  }, [config, movementSets, previewMovementSetId]);
  const previewDurationMs = Math.max(500, previewMode === "opening" ? previewResolved.opening.durationMs : previewResolved.checkmate.durationMs);

  // Transport follower while playing. It must tick the SAME stall-proof clock as the engine
  // (per-frame deltas clamped to 150ms): a raw Date.now()-startedAt here raced ahead of the
  // stage whenever the main thread stalled (GLB parses, HMR) and then pinned previewTimeMs to
  // the END — cutting the preview short mid-show.
  useEffect(() => {
    if (!playing) return;
    let elapsed = Math.max(0, Date.now() - startedAtRef.current);
    let lastNow = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      elapsed += Math.min(150, Math.max(0, now - lastNow));
      lastNow = now;
      if (elapsed >= previewDurationMs) {
        setPlaying(false);
        setScrubMs(previewDurationMs);
        return;
      }
      setScrubMs(elapsed);
    }, 90);
    return () => clearInterval(timer);
  }, [playKey, playing, previewDurationMs]);

  function playPreview() {
    const resumeFromMs = scrubMs >= previewDurationMs ? 0 : scrubMs;
    // Back-date startedAt so the engine's wall clock continues from the scrub position.
    startedAtRef.current = Date.now() - resumeFromMs;
    setScrubMs(resumeFromMs);
    setPlaying(true);
    setPlayKey((key) => key + 1); // remount → the stage re-reads startedAt cleanly
  }

  function restartPreview() {
    startedAtRef.current = Date.now();
    setScrubMs(0);
    setPlaying(true);
    setPlayKey((key) => key + 1);
  }

  function selectPreviewMode(mode: "opening" | "checkmate") {
    if (mode === previewMode) return;
    setPreviewMode(mode);
    setPlaying(false);
    setScrubMs(0);
    setPlayKey((key) => key + 1);
  }

  function selectPreviewAttacker(piece: PieceKind) {
    if (piece === previewAttacker) return;
    setPreviewAttacker(piece);
    setPlaying(false);
    setScrubMs(0);
    setPlayKey((key) => key + 1); // remount — the engine builds its actors once per ceremony
  }

  function selectPreviewMatingColor(color: "w" | "b") {
    if (color === previewMatingColor) return;
    setPreviewMatingColor(color);
    setPlaying(false);
    setScrubMs(0);
    setPlayKey((key) => key + 1); // remount — new position, new actors
  }

  // Opening previews the start position; checkmate previews a real mate for the auditioned
  // side: scholar's mate (white Qxf7#) or fool's mate (black Qh4#).
  const previewSnapshot = useMemo(
    () =>
      previewMode === "opening"
        ? snapshotFromMoves([])
        : snapshotFromMoves(previewMatingColor === "w" ? scholarsMateMoves : foolsMateMoves),
    [previewMatingColor, previewMode],
  );
  const previewTheme = useMemo(() => resolveBoardTheme(settings), [settings]);

  // Actor assets resolved the SIMPLE way (mirrors the runtime resolver's spirit): the fallback
  // GLB is the piece's slot chain, and role clips come from clipRolesByPiece. Empty maps are
  // fine — the engine's contract guarantees a procedural fallback so the ceremony ALWAYS plays.
  const previewCinematic: ResolvedCinematicCeremony = useMemo(() => {
    const resolved = previewResolved;
    const actorFor = (kind: PieceKind, color: "w" | "b", scale: number): CinematicActorAssets => {
      const asset = pieceSet?.pieces?.[kind];
      const fallbackGlbPath = [
        asset?.assetSlots?.celebrate?.path,
        asset?.assetSlots?.move?.path,
        asset?.assetSlots?.shared?.path,
        asset?.assetSlots?.static?.path,
        asset?.glbPath,
      ].find((path): path is string => canLoadGlbPath(path));
      const glbPathByRole: Partial<Record<ActorClipRole, string>> = {};
      const clipNameByRole: Partial<Record<ActorClipRole, string>> = {};
      // Color-specific casting ("k:b" = a dedicated dark-side model) wins over the color-blind
      // entry, exactly like the runtime resolver — the director must preview what players see.
      const colorMap = resolved.clipRolesByPiece?.[`${kind}:${color}`];
      const roleMap = colorMap ?? resolved.clipRolesByPiece?.[kind] ?? {};
      (Object.entries(roleMap) as Array<[ActorClipRole, string | undefined]>).forEach(([role, clipId]) => {
        const clip = clips.find((item) => item.id === clipId);
        if (clip && canLoadGlbPath(clip.sourceGlbPath)) {
          glbPathByRole[role] = clip.sourceGlbPath;
          clipNameByRole[role] = clip.name;
        }
      });
      return { clipNameByRole, color, dedicatedColorModel: Boolean(colorMap), fallbackGlbPath, glbPathByRole, kind, scale };
    };
    // Sample names so the director sees the "A vs B" / "A defeats B" HUD exactly as players do.
    const names = { white: "PLAYER ONE", black: "PLAYER TWO" };
    if (previewMode === "opening") {
      return {
        attacker: actorFor("k", "w", resolved.opening.actor?.scale ?? 1),
        config: resolved,
        loser: actorFor("k", "b", resolved.opening.actor?.scale ?? 1),
        names,
      };
    }
    const loserColor = previewMatingColor === "w" ? "b" : "w";
    // R25 — the living chorus: same resolver for every kind+color so the director previews
    // the whole board transforming and dancing exactly as players see it.
    const chorus: ResolvedCinematicCeremony["chorus"] = {};
    for (const kind of ["k", "q", "r", "b", "n", "p"] as PieceKind[]) {
      for (const color of ["w", "b"] as const) {
        chorus[`${kind}:${color}`] = actorFor(kind, color, 1);
      }
    }
    return {
      attacker: actorFor(previewAttacker, previewMatingColor, resolved.checkmate.actor?.scale ?? 1),
      chorus,
      config: resolved,
      loser: actorFor("k", loserColor, resolved.checkmate.loserActor?.scale ?? 1),
      names,
    };
  }, [clips, pieceSet, previewAttacker, previewMatingColor, previewMode, previewResolved]);

  const previewCeremony: CinematicCeremonyStageProps["ceremony"] = useMemo(
    () => ({
      cinematic: previewCinematic,
      durationMs: previewDurationMs,
      startedAt: startedAtRef.current,
      type: previewMode === "opening" ? ("pre-game-handshake" as const) : ("checkmate-finisher" as const),
      ...(previewMode === "checkmate"
        ? previewMatingColor === "w"
          ? { move: { captured: "p" as PieceKind, color: "w" as const, from: "h5", piece: "q" as PieceKind, to: "f7" }, resultText: "Checkmate — White wins" }
          : { move: { color: "b" as const, from: "d8", piece: "q" as PieceKind, to: "h4" }, resultText: "Checkmate — Black wins" }
        : {}),
    }),
    // playKey in the deps: it changes exactly when startedAtRef is rewritten, so the memo
    // re-reads the fresh startedAt (the ref itself is invisible to the dependency array).
    [playKey, previewCinematic, previewDurationMs, previewMatingColor, previewMode],
  );

  const boardPixelSize = Math.round(Math.max(240, Math.min(480, (previewFrameWidth || 400) - 16)));
  const clipsForRosterPiece = clips.filter((clip) => clip.compatiblePieces.includes(rosterPiece));
  const pieceSetHasAnyClips = clips.some((clip) => (pieceSet?.animationClipIds ?? []).includes(clip.id)) || clipsForRosterPiece.length > 0;

  // ── Render ─────────────────────────────────────────────────────────────────────────────

  if (!pieceSet) {
    return (
      <View style={styles.animationStudioEmptyState}>
        <Text style={styles.animationStudioSubTitle}>No piece set selected</Text>
        <Text style={styles.muted}>Create or select a Piece Set in the Piece Sets tab first — ceremonies belong to an animation set bound to a piece set.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 14 }}>
      {/* HEADER — set picker, engine, save + go-live */}
      <View style={styles.animationBuilderPanel}>
        <View style={styles.animationStudioSectionHeader}>
          <View>
            <Text style={styles.animationStudioSubTitle}>Ceremony Director</Text>
            <Text style={styles.muted}>Direct the opening kings' dance and the Hollywood checkmate finisher for {pieceSet.name}.</Text>
          </View>
          <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Text style={{ color: dirty ? "#b45309" : "#15803d", fontSize: 12.5, fontWeight: "600" }}>{dirty ? "● Unsaved changes" : "✓ All changes saved"}</Text>
            <DirectorButton accent disabled={!selectedSet || !dirty} onPress={() => void saveCeremonies()}>Save</DirectorButton>
            <DirectorButton disabled={!selectedSet} onPress={() => void makeLiveForAllPlayers()}>
              {liveConfirm ? "Tap again to confirm going LIVE" : "★ Make LIVE for all players"}
            </DirectorButton>
          </View>
        </View>

        {animationSets.length === 0 ? (
          <View style={styles.animationStudioEmptyState}>
            <Text style={styles.animationStudioSubTitle}>No animation set yet</Text>
            <Text style={styles.muted}>Ceremony configs live on an Animation Set. Create one to start directing.</Text>
            <DirectorButton accent onPress={() => void createCeremonySet()}>Create ceremony set</DirectorButton>
          </View>
        ) : (
          <View style={styles.animationSetCardGrid}>
            {animationSets.map((set) => (
              <Pressable key={set.id} onPress={() => setSelectedSetId(set.id)} style={({ pressed }) => [styles.animationSetCard, selectedSet?.id === set.id && styles.animationSetCardActive, pressed && styles.pressed]}>
                <Text style={styles.pieceSetCardTitle}>{set.name}{set.isDefault ? "  ·  ★ live" : ""}</Text>
                <Text numberOfLines={2} style={styles.muted}>{set.description}</Text>
                <StatLine label="Engine" value={set.ceremonies?.engine === "classic" ? "Classic" : "Cinematic"} />
                <StatLine label="Ceremonies" value={set.ceremonies ? "Configured" : "Defaults"} />
              </Pressable>
            ))}
          </View>
        )}

        {selectedSet && (
          <View style={{ gap: 6, maxWidth: 520 }}>
            <Text style={[styles.muted, { fontWeight: "700" }]}>Ceremony engine</Text>
            <Segment
              onChange={(engine) => setConfig((current) => ({ ...current, engine }))}
              options={[
                { description: "Single-scene 3D world with the camera storyboard — the movie experience.", label: "Cinematic", value: "cinematic" as const },
                { description: "Legacy per-piece floating overlay — the safety valve if 3D misbehaves.", label: "Classic", value: "classic" as const },
              ]}
              value={config.engine}
            />
          </View>
        )}
      </View>

      {selectedSet && (
        <>
          {/* OPENING CEREMONY */}
          <View style={styles.animationBuilderPanel}>
            <View style={styles.animationStudioSectionHeader}>
              <View>
                <Text style={styles.animationStudioSubTitle}>Opening Ceremony</Text>
                <Text style={styles.muted}>The kings gain depth, enter the 3D world, and greet each other. An unhurried pace reads best — push it out to 20s for a slower, more cinematic entrance (the shipped theme is a 2s silent lead-in + ~17s of music).</Text>
              </View>
            </View>
            <ToggleRow hint="Plays once when a game starts." label="Opening ceremony enabled" onChange={(enabled) => patchOpening({ enabled })} value={config.opening.enabled} />
            <SliderRow
              label="Duration"
              max={20000}
              min={2500}
              onChange={(durationMs) => patchOpening({ durationMs })}
              step={100}
              value={config.opening.durationMs}
              valueLabel={formatSeconds(config.opening.durationMs)}
            />
            <SliderRow
              // Inverted mapping so dragging RIGHT dives deeper (90 stays flat, 20 is the deep dive).
              label="Camera dive — Flat → Deep dive"
              max={90}
              min={20}
              onChange={(inverted) => patchOpening({ tiltElevationDeg: 110 - inverted })}
              step={1}
              value={110 - config.opening.tiltElevationDeg}
              valueLabel={`${config.opening.tiltElevationDeg}°${config.opening.tiltElevationDeg >= 88 ? " (flat)" : config.opening.tiltElevationDeg <= 28 ? " (deep dive)" : ""}`}
            />
            <View style={{ gap: 6 }}>
              <Text style={[styles.muted, { fontWeight: "700" }]}>Participants</Text>
              <Segment
                onChange={(participants) => patchOpening({ participants })}
                options={[
                  { label: "Both kings", value: "both-kings" as const },
                  { label: "White king", value: "white-king" as const },
                  { label: "Black king", value: "black-king" as const },
                ]}
                value={config.opening.participants}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={[styles.muted, { fontWeight: "700" }]}>Dance style (procedural — used when the king has no Dance clip)</Text>
              <Segment onChange={(danceStyle) => patchOpening({ danceStyle })} options={danceStyleDefs} value={config.opening.danceStyle} />
            </View>
            <ToggleRow hint="A short confetti burst over the dance." label="Confetti" onChange={(confetti) => patchOpening({ confetti })} value={config.opening.confetti} />
            <View style={{ gap: 6 }}>
              <Text style={[styles.muted, { fontWeight: "700" }]}>2D → 3D morph</Text>
              <Segment
                onChange={(morphStyle) => patchOpening({ actor: { ...config.opening.actor, morphStyle } })}
                options={morphStyleDefs}
                value={config.opening.actor?.morphStyle ?? "rise"}
              />
              <SliderRow
                label="Morph duration"
                max={1500}
                min={300}
                onChange={(morphInMs) => patchOpening({ actor: { ...config.opening.actor, morphInMs } })}
                step={50}
                value={config.opening.actor?.morphInMs ?? 700}
                valueLabel={formatSeconds(config.opening.actor?.morphInMs ?? 700, 2)}
              />
            </View>
          </View>

          {/* CHECKMATE CEREMONY */}
          <View style={styles.animationBuilderPanel}>
            <View style={styles.animationStudioSectionHeader}>
              <View>
                <Text style={styles.animationStudioSubTitle}>Checkmate Ceremony</Text>
                <Text style={styles.muted}>Opens inside the 3D world (zero board rotation), the mating piece walks to the king, kicks in slow-mo, a bullet-time 360° orbit rounds the frozen kick — toe buried in the caved belly — then the king blasts backward away with impact, the winner dances.</Text>
              </View>
            </View>
            <ToggleRow hint="Plays on checkmate. Players can always skip." label="Checkmate ceremony enabled" onChange={(enabled) => patchCheckmate({ enabled })} value={config.checkmate.enabled} />
            <SliderRow
              label="Duration"
              max={40000}
              min={4500}
              onChange={(durationMs) => patchCheckmate({ durationMs })}
              step={100}
              value={config.checkmate.durationMs}
              valueLabel={formatSeconds(config.checkmate.durationMs)}
            />
            <View style={{ gap: 6 }}>
              <Text style={[styles.muted, { fontWeight: "700" }]}>Approach — how the piece crosses the board</Text>
              <Segment onChange={(approachStyle) => patchCheckmate({ approachStyle })} options={approachStyleDefs} value={config.checkmate.approachStyle} />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={[styles.muted, { fontWeight: "700" }]}>Strike — the finishing blow</Text>
              <Segment onChange={(strikeStyle) => patchCheckmate({ strikeStyle })} options={strikeStyleDefs} value={config.checkmate.strikeStyle} />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={[styles.muted, { fontWeight: "700" }]}>Loser reaction</Text>
              <Segment
                onChange={(loserReaction: LoserReaction) => patchCheckmate({ loserReaction })}
                options={loserReactions.map((reaction) => ({ description: loserReactionDescription[reaction], label: loserReactionLabel[reaction], value: reaction }))}
                value={config.checkmate.loserReaction}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={[styles.muted, { fontWeight: "700" }]}>Loser exit</Text>
              <Segment onChange={(loserExit) => patchCheckmate({ loserExit })} options={loserExitDefs} value={config.checkmate.loserExit} />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <View style={{ flex: 1, gap: 8, minWidth: 260 }}>
                <ToggleRow hint="Time dilates on the strike beat — the movie moment." label="Slow-mo strike" onChange={(slowMoStrike) => patchCheckmate({ slowMoStrike })} value={config.checkmate.slowMoStrike} />
                <ToggleRow hint="Cinematic black bars + title card." label="Letterbox" onChange={(letterbox) => patchCheckmate({ letterbox })} value={config.checkmate.letterbox} />
              </View>
              <View style={{ flex: 1, gap: 8, minWidth: 260 }}>
                <ToggleRow hint="Dust puffs under the attacker's steps." label="Dust" onChange={(dust) => patchCheckmate({ vfx: { ...config.checkmate.vfx, dust } })} value={config.checkmate.vfx.dust} />
                <ToggleRow hint="Radial flash + sparks on impact." label="Impact flash" onChange={(impactFlash) => patchCheckmate({ vfx: { ...config.checkmate.vfx, impactFlash } })} value={config.checkmate.vfx.impactFlash} />
                <ToggleRow hint="Confetti over the victory pose." label="Confetti" onChange={(confetti) => patchCheckmate({ vfx: { ...config.checkmate.vfx, confetti } })} value={config.checkmate.vfx.confetti} />
              </View>
            </View>
            <SliderRow
              label="Impact shake"
              max={1}
              min={0}
              onChange={(impactShake) => patchCheckmate({ vfx: { ...config.checkmate.vfx, impactShake } })}
              step={0.05}
              value={config.checkmate.vfx.impactShake}
              valueLabel={config.checkmate.vfx.impactShake.toFixed(2)}
            />
          </View>

          {/* CLIP CASTING */}
          <View style={styles.animationBuilderPanel}>
            <View style={styles.animationStudioSectionHeader}>
              <View>
                <Text style={styles.animationStudioSubTitle}>Clip Casting — teach each piece its moves</Text>
                <Text style={styles.muted}>Map uploaded GLB clips to ceremony roles per piece. Anything left "(procedural)" is animated by the engine's built-in motion — ceremonies always play.</Text>
              </View>
            </View>
            <View style={styles.pieceRosterGrid}>
              {pieceOrder.map((piece) => {
                const castCount = Object.keys(config.clipRolesByPiece?.[piece] ?? {}).length;
                return (
                  <Pressable key={piece} onPress={() => setRosterPiece(piece)} style={({ pressed }) => [styles.pieceRosterCard, rosterPiece === piece && styles.pieceRosterCardActive, pressed && styles.pressed]}>
                    <View style={styles.pieceRosterPreview}>
                      <Text style={styles.pieceRosterPreviewGlyph}>{pieceGlyphs[piece]}</Text>
                    </View>
                    <Text style={styles.pieceRosterName}>{pieceNames[piece]}</Text>
                    <Text style={[styles.muted, { fontSize: 11 }]}>{castCount ? `${castCount} role${castCount === 1 ? "" : "s"} cast` : "procedural"}</Text>
                  </Pressable>
                );
              })}
            </View>
            {!pieceSetHasAnyClips && (
              <View style={styles.animationStudioEmptyState}>
                <Text style={[styles.muted, { fontWeight: "700" }]}>No GLB clips uploaded for this piece set yet.</Text>
                <Text style={styles.muted}>Every role will use the engine's procedural motion, which looks great with zero assets. To use real animations, upload Meshy GLBs in the Animation Sets tab — detected clips appear here automatically.</Text>
              </View>
            )}
            <View style={{ gap: 10 }}>
              {clipRoleDefs.map(({ hint, label, role }) => {
                const selectedClipId = config.clipRolesByPiece?.[rosterPiece]?.[role] ?? "";
                const selectedClip = clips.find((clip) => clip.id === selectedClipId);
                return (
                  <View key={role} style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                    <View style={{ minWidth: 190, width: 190 }}>
                      <Text style={{ fontSize: 13.5, fontWeight: "800" }}>{label}</Text>
                      <Text numberOfLines={1} style={[styles.muted, { fontSize: 11.5 }]}>{hint}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 240 }}>
                      <SelectRow
                        onChange={(clipId) => setClipRole(rosterPiece, role, clipId)}
                        options={[
                          { label: "(procedural)", value: "" },
                          // ALL clips compatible with this piece — deliberately NOT filtered by the
                          // currently slotted GLB (that filter hid perfectly usable clips before).
                          ...clipsForRosterPiece.map((clip) => ({
                            label: `${clip.name} · ${formatSeconds(clip.durationMs)} · ${fileBasename(clip.sourceGlbPath) || "unknown.glb"}`,
                            value: clip.id,
                          })),
                        ]}
                        value={selectedClipId}
                      />
                      {selectedClipId && !selectedClip ? (
                        <Text style={{ color: "#b45309", fontSize: 11.5, fontWeight: "700" }}>Cast clip no longer exists — the engine will use procedural motion.</Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>

          {/* CAMERA STORYBOARD */}
          <View style={styles.animationBuilderPanel}>
            <View style={styles.animationStudioSectionHeader}>
              <View>
                <Text style={styles.animationStudioSubTitle}>Camera Storyboard</Text>
                <Text style={styles.muted}>The shot list the camera plays. Default derives from the knobs above; go Custom for full directorial control.</Text>
              </View>
            </View>
            <View style={{ maxWidth: 360 }}>
              <Segment
                onChange={setStoryTab}
                options={[
                  { label: "Opening", value: "opening" as const },
                  { label: "Checkmate", value: "checkmate" as const },
                ]}
                value={storyTab}
              />
            </View>
            <ToggleRow
              hint={storyIsCustom ? "Authored shots below are saved with the config." : "Shots are derived live from duration/dive/style — retunes itself as you edit the knobs."}
              label={storyIsCustom ? "Custom storyboard (authored shots)" : "Default storyboard (derived)"}
              onChange={(custom) => toggleCustomStoryboard(custom)}
              value={storyIsCustom}
            />

            {!storyIsCustom ? (
              // READ-ONLY derived strip: label, kind, target, timing bar per shot.
              <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: 10, paddingBottom: 6 }}>
                {derivedDefaultShots.map((shot) => {
                  const total = Math.max(storyConfig.durationMs, ...derivedDefaultShots.map((item) => item.startsAtMs + item.durationMs));
                  return (
                    <View key={shot.id} style={[styles.clipCard, { gap: 6, minWidth: 210, width: 210 }]}>
                      <Text numberOfLines={1} style={styles.clipTitle}>{shot.label ?? shot.kind}</Text>
                      <Text style={[styles.muted, { fontSize: 12 }]}>{shot.kind} → {shot.target}</Text>
                      <Text style={[styles.muted, { fontSize: 12 }]}>{formatSeconds(shot.startsAtMs)} – {formatSeconds(shot.startsAtMs + shot.durationMs)} · {shot.transition ?? "blend"}</Text>
                      <View style={{ backgroundColor: "#e2ecf6", borderRadius: 4, height: 6, overflow: "hidden", width: "100%" }}>
                        <View style={{ backgroundColor: "#2563eb", borderRadius: 4, height: 6, marginLeft: `${(shot.startsAtMs / total) * 100}%` as any, width: `${Math.max(2, (shot.durationMs / total) * 100)}%` as any }} />
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            ) : (
              <View style={{ gap: 10 }}>
                {editableShots.map((shot, index) => (
                  <View key={shot.id} style={[styles.clipCard, { flexDirection: "column", gap: 10 }]}>
                    <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      <Text style={[styles.clipTitle, { minWidth: 60 }]}>Shot {index + 1}</Text>
                      <View style={{ flex: 1, minWidth: 150 }}>
                        <SelectRow onChange={(kind) => updateShot(index, { kind: kind as CameraShotKind })} options={shotKindOptions.map((kind) => ({ label: kind, value: kind }))} value={shot.kind} />
                      </View>
                      <View style={{ flex: 1, minWidth: 150 }}>
                        <SelectRow onChange={(target) => updateShot(index, { target: target as CameraTarget })} options={shotTargetOptions.map((target) => ({ label: target, value: target }))} value={shot.target} />
                      </View>
                      <View style={{ flexDirection: "row", gap: 6 }}>
                        <Pressable onPress={() => moveShot(index, -1)} style={styles.stackButton}><Text style={styles.stackButtonText}>↑</Text></Pressable>
                        <Pressable onPress={() => moveShot(index, 1)} style={styles.stackButton}><Text style={styles.stackButtonText}>↓</Text></Pressable>
                        <Pressable onPress={() => duplicateShot(index)} style={styles.stackButton}><Text style={styles.stackButtonText}>⧉</Text></Pressable>
                        <Pressable onPress={() => deleteShot(index)} style={styles.stackButton}><Text style={styles.stackButtonText}>×</Text></Pressable>
                      </View>
                    </View>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                      {(
                        [
                          ["Start (s)", shot.startsAtMs / 1000, (v: number) => updateShot(index, { startsAtMs: Math.max(0, Math.round(v * 1000)) })],
                          ["Duration (s)", shot.durationMs / 1000, (v: number) => updateShot(index, { durationMs: Math.max(0.2, v) * 1000 })],
                          ["Distance", shot.distance ?? 5, (v: number) => updateShot(index, { distance: v })],
                          ["Elevation °", shot.elevationDeg ?? 45, (v: number) => updateShot(index, { elevationDeg: v })],
                          ["Azimuth °", shot.azimuthDeg ?? 0, (v: number) => updateShot(index, { azimuthDeg: v })],
                          ["Orbit °/s", shot.orbitDegPerSec ?? 0, (v: number) => updateShot(index, { orbitDegPerSec: v })],
                          ["FOV °", shot.fovDeg ?? 45, (v: number) => updateShot(index, { fovDeg: v })],
                        ] as Array<[string, number, (value: number) => void]>
                      ).map(([label, value, commit]) => (
                        <View key={label} style={{ minWidth: 96, width: 110 }}>
                          <Text style={[styles.muted, { fontSize: 11.5, marginBottom: 3 }]}>{label}</Text>
                          <NumericInput onCommit={commit} value={value} />
                        </View>
                      ))}
                    </View>
                    <View style={{ alignItems: "flex-end", flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                      <View style={{ maxWidth: 220, minWidth: 180 }}>
                        <Segment
                          onChange={(transition) => updateShot(index, { transition })}
                          options={[
                            { label: "Cut", value: "cut" as const },
                            { label: "Blend", value: "blend" as const },
                          ]}
                          value={shot.transition ?? "blend"}
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 180 }}>
                        <SliderRow label="Shake" max={1} min={0} onChange={(shake) => updateShot(index, { shake })} step={0.05} value={shot.shake ?? 0} valueLabel={(shot.shake ?? 0).toFixed(2)} />
                      </View>
                    </View>
                  </View>
                ))}
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <DirectorButton accent onPress={addShot}>+ Add shot</DirectorButton>
                </View>
                <Text style={[styles.muted, { fontSize: 12 }]}>On save the shots are sorted by start time and durations are clamped to ≥ 0.2s.</Text>
              </View>
            )}
          </View>

          {/* LIVE PREVIEW — the real engine on a synthetic ceremony */}
          <View style={styles.animationBuilderPanel}>
            <View style={styles.animationStudioSectionHeader}>
              <View>
                <Text style={styles.animationStudioSubTitle}>Live Preview</Text>
                <Text style={styles.muted}>The actual in-game cinematic engine, driven by your unsaved edits. Opening previews the start position; checkmate previews a scholar's mate (Qxf7#).</Text>
              </View>
            </View>
            <View style={{ maxWidth: 360 }}>
              <Segment
                onChange={selectPreviewMode}
                options={[
                  { label: "Opening", value: "opening" as const },
                  { label: "Checkmate", value: "checkmate" as const },
                ]}
                value={previewMode}
              />
            </View>
            {previewMode === "checkmate" && (
              <View style={{ maxWidth: 560 }}>
                <Text style={[styles.muted, { fontSize: 12, marginBottom: 4 }]}>Mating side (audition both colors' models)</Text>
                <Segment
                  onChange={selectPreviewMatingColor}
                  options={[
                    { description: "Scholar's mate — the white pieces win (Qxf7#).", label: "♕ White mates", value: "w" as const },
                    { description: "Fool's mate — the black pieces win (Qh4#), previewing the dark-side castings.", label: "♛ Black mates", value: "b" as const },
                  ]}
                  value={previewMatingColor}
                />
                <Text style={[styles.muted, { fontSize: 12, marginBottom: 4, marginTop: 8 }]}>Mating piece (audition each finisher)</Text>
                <Segment
                  onChange={selectPreviewAttacker}
                  options={[
                    { label: "♛ Queen", value: "q" as const },
                    { label: "♜ Rook", value: "r" as const },
                    { label: "♝ Bishop", value: "b" as const },
                    { label: "♞ Knight", value: "n" as const },
                    { label: "♟ Pawn", value: "p" as const },
                    { label: "♚ King", value: "k" as const },
                  ]}
                  value={previewAttacker}
                />
              </View>
            )}
            <View
              onLayout={(event) => setPreviewFrameWidth(event.nativeEvent.layout.width)}
              style={{ alignItems: "center", gap: 10 }}
            >
              {/* R33 — audition a MOVEMENT SET's choreography over this set's cast. Preview-only:
                  the editor state and Save path are untouched (movement sets are script-authored). */}
              {movementSets.length > 0 && (
                <View style={{ alignItems: "center", alignSelf: "stretch", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Text style={[styles.muted, { fontSize: 12 }]}>Choreography</Text>
                  <DirectorButton
                    accent={previewMovementSetId === null}
                    onPress={() => {
                      setPreviewMovementSetId(null);
                      setPlaying(false);
                      setScrubMs(0);
                      setPlayKey((key) => key + 1);
                    }}
                  >
                    This set's own
                  </DirectorButton>
                  {movementSets.map((ms) => (
                    <DirectorButton
                      key={ms.id}
                      accent={previewMovementSetId === ms.id}
                      onPress={() => {
                        setPreviewMovementSetId(ms.id);
                        setPlaying(false);
                        setScrubMs(0);
                        setPlayKey((key) => key + 1);
                      }}
                    >
                      {ms.name}
                    </DirectorButton>
                  ))}
                </View>
              )}
              {/* Transport FIRST, canvas below: in checkmate mode the extra mating-side/piece
                  segments + a full-size canvas used to push Play/Restart under the fold — the
                  controls must never depend on the canvas height to be reachable. */}
              <View style={{ alignItems: "center", alignSelf: "stretch", flexDirection: "row", gap: 10 }}>
                <DirectorButton accent onPress={() => (playing ? setPlaying(false) : playPreview())}>{playing ? "⏸ Pause" : "▶ Play"}</DirectorButton>
                <DirectorButton onPress={restartPreview}>↺ Restart</DirectorButton>
                <View style={{ flex: 1 }}>
                  {createElement("input", {
                    max: previewDurationMs,
                    min: 0,
                    onChange: (event: any) => {
                      // Scrubbing takes manual control: pause and drive previewTimeMs directly.
                      setPlaying(false);
                      setScrubMs(Number(event.target.value));
                    },
                    step: 16,
                    style: { accentColor: "#2563eb", cursor: "pointer", width: "100%" },
                    type: "range",
                    value: Math.min(scrubMs, previewDurationMs),
                  })}
                </View>
                <Text style={{ color: "#2563eb", fontVariant: ["tabular-nums"], fontWeight: "800", minWidth: 86, textAlign: "right" }}>
                  {formatSeconds(Math.min(scrubMs, previewDurationMs))} / {formatSeconds(previewDurationMs)}
                </Text>
              </View>
              <View style={{ height: boardPixelSize, position: "relative", width: boardPixelSize }}>
                {/* key = mode+playKey: remounting is the restart contract with the engine, and it
                    also resets the error boundary so Restart can retry after a WebGL failure. */}
                <PreviewErrorBoundary key={`preview-${previewMode}-${playKey}`}>
                  <Suspense fallback={<View style={{ alignItems: "center", justifyContent: "center", minHeight: 160 }}><Text style={styles.muted}>Loading 3D engine…</Text></View>}>
                    <LazyCinematicStage
                      boardPixelSize={boardPixelSize}
                      ceremony={previewCeremony}
                      orientation="w"
                      pieceSet={pieceSet}
                      previewTimeMs={playing ? undefined : scrubMs}
                      snapshot={previewSnapshot}
                      theme={previewTheme}
                    />
                  </Suspense>
                </PreviewErrorBoundary>
              </View>
            </View>
          </View>
        </>
      )}
    </View>
  );
}
