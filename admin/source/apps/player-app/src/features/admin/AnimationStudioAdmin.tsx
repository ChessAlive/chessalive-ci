import { PieceKind, SquareName } from "@chessalive/chess-core";
import {
  AnimationAction,
  AnimationChoreographyStep,
  AnimationClip,
  AnimationRule,
  AnimationSet,
  BoardPieceAsset,
  DirectionalSlots,
  LoserReaction,
  MovementDirection,
  PieceAsset,
  PieceAssetSlotKey,
  PieceSet,
  PieceSetSoundAsset,
  PieceSetSoundEvent,
  animationActionLabel,
  defaultLoserReaction,
  loserReactions,
  loserReactionLabel,
  loserReactionDescription,
  resolveLoserReaction,
  movementDirections,
  movementDirectionLabel,
  resolveDirectionalSlot,
  pieceActionOptions,
  inUseClipIds,
  missingMovementsOnGlbReplace,
} from "@chessalive/funny-mode";
import { ReactNode, createElement, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { styles } from "@app/shell/theme";
import { visualToLayout } from "@app/shell/uiScale";
import { resolveBoardAssetUri, uploadAssetFileToServer, uploadBoardPieceFileToServer, canLoadGlbPath } from "@assets/glbAssets";
import { detectGlbAnimationClips } from "@assets/glbAnimationDetect";
import { isAudioFileAcceptable, resolveSoundAssetUri, uploadSoundFileToServer } from "@assets/soundAssets";
import { CeremonyDirectorAdmin } from "./CeremonyDirectorAdmin";
import { CharacterReleasesAdmin } from "./CharacterReleasesAdmin";
import { OgPackAdmin } from "./OgPackAdmin";
import { GlbModelPreview } from "@shared/pieces/GlbModelPreview";
import { FileUp, Music } from "@shared/icons";
import { CollapsibleSection, Panel, StatLine } from "@shared/primitives";

const pieceOrder: PieceKind[] = ["p", "n", "b", "r", "q", "k"];
const pieceNames: Record<PieceKind, string> = { b: "Bishop", k: "King", n: "Knight", p: "Pawn", q: "Queen", r: "Rook" };
const pieceGlyphs: Record<PieceKind, string> = { b: "♗", k: "♔", n: "♘", p: "♙", q: "♕", r: "♖" };
const animationSlots: Array<{ key: PieceAssetSlotKey; label: string; description: string }> = [
  { key: "shared", label: "Shared GLB", description: "Model/clip used by both colors unless overridden." },
  { key: "white", label: "White GLB", description: "Optional white-only ceremony model." },
  { key: "black", label: "Black GLB", description: "Optional black-only ceremony model." },
];

function renderBodyPortal(node: ReactNode): ReactNode {
  if (typeof document === "undefined") return node;
  try {
    const { createPortal } = (require as any)("react-dom");
    return createPortal(node, document.body);
  } catch {
    return node;
  }
}

function openingCeremonySteps(): AnimationChoreographyStep[] {
  return [
    {
      durationMs: 720,
      from: "e1" as SquareName,
      id: "opening-emerge",
      kind: "emerge",
      label: "2D kings grow into 3D kings",
      startsAtMs: 0,
      to: "e1" as SquareName,
    },
    {
      durationMs: 1450,
      facing: "up",
      from: "e1" as SquareName,
      id: "opening-walk-out",
      kind: "walk",
      label: "Walk out from home square",
      startsAtMs: 720,
      to: "e3" as SquareName,
    },
    {
      durationMs: 980,
      facing: "up",
      from: "e3" as SquareName,
      id: "opening-step-center",
      kind: "walk",
      label: "Step into meeting position",
      startsAtMs: 2170,
      to: "e4" as SquareName,
    },
    {
      durationMs: 520,
      facing: "toward-opponent",
      from: "e4" as SquareName,
      id: "opening-face-opponent",
      kind: "turn",
      label: "Turn to face opponent",
      startsAtMs: 3150,
      to: "e4" as SquareName,
    },
    {
      durationMs: 780,
      facing: "toward-opponent",
      from: "e4" as SquareName,
      id: "opening-comic-bow",
      kind: "gesture",
      label: "Comic bow",
      startsAtMs: 3670,
      to: "e4" as SquareName,
    },
    {
      durationMs: 920,
      facing: "toward-opponent",
      from: "e4" as SquareName,
      id: "opening-handshake",
      kind: "handshake",
      label: "Handshake",
      startsAtMs: 4450,
      to: "e4" as SquareName,
    },
    {
      durationMs: 660,
      facing: "toward-opponent",
      from: "e4" as SquareName,
      id: "opening-reaction",
      kind: "gesture",
      label: "Funny reaction",
      startsAtMs: 5370,
      to: "e4" as SquareName,
    },
    {
      durationMs: 1180,
      facing: "down",
      from: "e4" as SquareName,
      id: "opening-return-mid",
      kind: "return",
      label: "Walk back",
      startsAtMs: 6030,
      to: "e2" as SquareName,
    },
    {
      durationMs: 980,
      facing: "down",
      from: "e2" as SquareName,
      id: "opening-return-home",
      kind: "return",
      label: "Return to home square",
      startsAtMs: 7210,
      to: "e1" as SquareName,
    },
    {
      durationMs: 620,
      from: "e1" as SquareName,
      id: "opening-settle",
      kind: "sink",
      label: "Settle back into 2D king",
      startsAtMs: 8190,
      to: "e1" as SquareName,
    },
  ];
}

type Feedback = { tone: "error" | "saved" | "saving"; text: string } | null;

type AnimationStudioAdminProps = {
  data: any;
  reload: () => void | Promise<void>;
  services: any;
  settings: any;
  setSettings: (settings: any) => void;
};

// Event types we expose in the Sound Pack section, in display order. Each
// row lets the admin upload one audio file the active piece set will play
// for that gameplay moment. The emoji icon gives a fast visual scan so the
// admin doesn't have to read each label.
const SOUND_EVENT_DEFS: { event: PieceSetSoundEvent; label: string; icon: string }[] = [
  { event: "move",     label: "Move",     icon: "♟" },
  { event: "capture",  label: "Capture",  icon: "⚔" },
  { event: "check",    label: "Check",    icon: "⚠" },
  { event: "castle",   label: "Castle",   icon: "♜" },
  { event: "promote",  label: "Promote",  icon: "★" },
  { event: "game-end", label: "Game End", icon: "🏁" },
  { event: "checkmate", label: "Checkmate", icon: "♚" },
];

function StudioButton({ accent, children, disabled, onPress }: { accent?: boolean; children: ReactNode; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.actionPill, accent && styles.actionPillActive, disabled && styles.actionButtonDisabled, pressed && !disabled && styles.pressed]}>
      <Text style={[styles.actionPillText, accent && styles.actionPillTextActive]}>{children}</Text>
    </Pressable>
  );
}

function chooseFile(accept: string) {
  const documentRef = (globalThis as { document?: Document }).document;
  if (!documentRef) return Promise.resolve<File | null>(null);
  return new Promise<File | null>((resolve) => {
    const input = documentRef.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function boardPieceCount(pieceSet: PieceSet) {
  return pieceOrder.reduce(
    (total, piece) => {
      const wAsset = pieceSet.boardAssets?.w?.[piece];
      const bAsset = pieceSet.boardAssets?.b?.[piece];
      const wCount = wAsset && (wAsset.kind === "svg" || wAsset.kind === "image") ? 1 : 0;
      const bCount = bAsset && (bAsset.kind === "svg" || bAsset.kind === "image") ? 1 : 0;
      return total + wCount + bCount;
    },
    0,
  );
}

function BoardAssetPreview({ asset, piece }: { asset?: BoardPieceAsset; piece: PieceKind }) {
  if (!asset || (asset.kind !== "svg" && asset.kind !== "image")) return <Text style={styles.pieceRosterPreviewGlyph}>{pieceGlyphs[piece]}</Text>;
  return <Image resizeMode="contain" source={{ uri: resolveBoardAssetUri(asset.path) }} style={styles.boardPieceImage} />;
}

function GlbAssetPreview({ asset, piece }: { asset?: PieceAsset; piece: PieceKind }) {
  const glbPath = asset?.assetSlots?.shared?.path ?? asset?.assetSlots?.static?.path ?? asset?.glbPath;
  if (!glbPath || !canLoadGlbPath(glbPath)) return <Text style={styles.pieceRosterPreviewGlyph}>{pieceGlyphs[piece]}</Text>;
  return <GlbModelPreview glbPath={glbPath} piece={piece} autoFrame />;
}

function glbPathForColor(asset: PieceAsset | undefined, color: "w" | "b") {
  return [
    asset?.assetSlots?.[color === "w" ? "white" : "black"]?.path ??
      undefined,
    // `celebrate` is what the in-game king/finisher resolver (selectedKingGlbPath) checks first; the
    // preview omitted it, so a ceremony GLB uploaded to that slot played in-game but not here.
    asset?.assetSlots?.celebrate?.path,
    asset?.assetSlots?.shared?.path,
    asset?.assetSlots?.move?.path,
    asset?.assetSlots?.static?.path,
    asset?.glbPath,
  ].find((path): path is string => canLoadGlbPath(path));
}

type TimelineItem =
  | { clipId: string; durationMs?: number; from?: SquareName; id: string; kind: "clip"; startsAtMs?: number; to?: SquareName }
  | {
      degrees: number;
      degreesX?: number;
      degreesY?: number;
      degreesZ?: number;
      durationMs: number;
      from?: SquareName;
      id: string;
      kind: "turn";
      startsAtMs?: number;
      to?: SquareName;
    };
type TimelineEditorDraft =
  | { clipId: string; durationMs: number; from: string; kind: "clip"; startsAtMs: number; to: string }
  | { degrees: number; degreesX: number; degreesY: number; degreesZ: number; durationMs: number; from: string; kind: "turn"; startsAtMs: number; to: string };

const previewFiles = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const previewRanks = [8, 7, 6, 5, 4, 3, 2, 1] as const;

function timelineItemDurationMs(item: TimelineItem, clips: AnimationClip[]) {
  const baseDuration = item.kind === "clip" ? item.durationMs ?? clips.find((clip) => clip.id === item.clipId)?.durationMs ?? 1400 : item.durationMs;
  return Math.max(240, Math.round(baseDuration));
}

function timelineDurationPatch(item: TimelineItem, targetRenderedDurationMs: number): Partial<TimelineItem> {
  const baseDuration = Math.max(240, Math.round(targetRenderedDurationMs));
  return item.kind === "clip" ? ({ durationMs: baseDuration } as Partial<TimelineItem>) : ({ durationMs: baseDuration } as Partial<TimelineItem>);
}

function fallbackSequentialStartMs(timeline: TimelineItem[], index: number, clips: AnimationClip[]) {
  return timeline.slice(0, index).reduce((total, item) => total + timelineItemDurationMs(item, clips), 0);
}

function timelineItemStartMs(timeline: TimelineItem[], index: number, clips: AnimationClip[]) {
  const item = timeline[index];
  return Math.max(0, Math.round(item?.startsAtMs ?? fallbackSequentialStartMs(timeline, index, clips)));
}

function timelineTotalDurationMs(timeline: TimelineItem[], clips: AnimationClip[]) {
  return Math.max(
    900,
    timeline.reduce((total, item, index) => Math.max(total, timelineItemStartMs(timeline, index, clips) + timelineItemDurationMs(item, clips)), 0),
  );
}

function timelineItemLabel(item: TimelineItem, clips: AnimationClip[]) {
  return item.kind === "clip" ? clips.find((clip) => clip.id === item.clipId)?.name ?? item.clipId : `Turn ${item.degrees}deg`;
}

function formatDurationSeconds(durationMs: number) {
  const seconds = Math.max(0, durationMs) / 1000;
  return seconds.toFixed(seconds < 10 ? 2 : 1).replace(/\.?0+$/, "");
}

function secondsInputToDurationMs(value: string, fallbackMs: number) {
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.max(240, Math.round(parsed * 1000));
}

function secondsInputToStartMs(value: string, fallbackMs: number) {
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackMs;
  return Math.round(parsed * 1000);
}

function defaultSquareForPiece(piece: PieceKind): SquareName {
  const startSquareByPiece: Record<PieceKind, SquareName> = {
    b: "c1" as SquareName,
    k: "e1" as SquareName,
    n: "g1" as SquareName,
    p: "e2" as SquareName,
    q: "d1" as SquareName,
    r: "a1" as SquareName,
  };
  return startSquareByPiece[piece];
}

function squareName(file: (typeof previewFiles)[number], rank: (typeof previewRanks)[number]) {
  return `${file}${rank}` as SquareName;
}

function normalizeSquareInput(value: unknown, fallback: SquareName): SquareName {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-h][1-8]$/.test(normalized) ? (normalized as SquareName) : fallback;
}

function defaultTimelineDraft(compatibleClips: AnimationClip[], piece: PieceKind, startSquare?: SquareName): TimelineEditorDraft {
  const firstClip = compatibleClips[0];
  const from = startSquare ?? defaultSquareForPiece(piece);
  const to = startSquare ?? (piece === "k" ? ("e4" as SquareName) : from);
  if (firstClip) return { clipId: firstClip.id, durationMs: firstClip.durationMs, from, kind: "clip", startsAtMs: 0, to };
  return { degrees: 180, degreesX: 0, degreesY: 180, degreesZ: 0, durationMs: 700, from, kind: "turn", startsAtMs: 0, to };
}

function timelineItemToDraft(item: TimelineItem, clips: AnimationClip[]): TimelineEditorDraft {
  const from = normalizeSquareInput(item.from, "e1" as SquareName);
  const to = normalizeSquareInput(item.to, from);
  return item.kind === "clip"
    ? { clipId: item.clipId, durationMs: item.durationMs ?? clips.find((clip) => clip.id === item.clipId)?.durationMs ?? 1400, from, kind: "clip", startsAtMs: item.startsAtMs ?? 0, to }
    : {
        degrees: item.degrees,
        degreesX: item.degreesX ?? 0,
        degreesY: item.degreesY ?? 0,
        degreesZ: item.degreesZ ?? item.degrees ?? 0,
        durationMs: item.durationMs,
        from,
        kind: "turn",
        startsAtMs: item.startsAtMs ?? 0,
        to,
      };
}

function timelineItemFromChoreographyStep(ruleId: string, step: AnimationChoreographyStep, index: number): TimelineItem | null {
  if (step.clipId) {
    return {
      clipId: step.clipId,
      durationMs: step.durationMs,
      from: step.from,
      id: `saved-step-clip-${ruleId}-${step.id}-${index}`,
      kind: "clip",
      startsAtMs: step.startsAtMs,
      to: step.to,
    };
  }

  if (step.kind !== "rotation" && step.kind !== "turn") return null;
  const degrees = step.degrees ?? step.degreesZ ?? step.degreesY ?? step.degreesX ?? 0;
  if (!degrees && step.degreesX === undefined && step.degreesY === undefined && step.degreesZ === undefined) return null;

  return {
    degrees,
    degreesX: step.degreesX,
    degreesY: step.degreesY,
    degreesZ: step.degreesZ ?? (step.axis === "z" ? step.degrees : undefined),
    durationMs: step.durationMs,
    from: step.from,
    id: `saved-step-turn-${ruleId}-${step.id}-${index}`,
    kind: "turn",
    startsAtMs: step.startsAtMs,
    to: step.to,
  };
}

function timelineFromAnimationRule(rule?: AnimationRule): TimelineItem[] {
  if (!rule) return [];
  const orderedFromChoreography = (rule.choreographySteps ?? [])
    .map((step, index) => timelineItemFromChoreographyStep(rule.id, step, index))
    .filter((item): item is TimelineItem => Boolean(item));
  if (orderedFromChoreography.length > 0) return orderedFromChoreography;

  const clipSteps = (rule.choreographySteps ?? []).filter((step) => step.clipId);
  const clipItems = [...rule.clipStack]
    .sort((a, b) => a.order - b.order)
    .map(
      (item, index): TimelineItem => ({
        clipId: item.clipId,
        durationMs: clipSteps[index]?.durationMs
          ?? item.durationMs,
        from: clipSteps[index]?.from,
        id: `saved-clip-${rule.id}-${item.clipId}-${index}`,
        kind: "clip",
        startsAtMs: clipSteps[index]?.startsAtMs,
        to: clipSteps[index]?.to,
      }),
    );
  const rotationItems = (rule.choreographySteps ?? [])
    .filter((step) => step.kind === "rotation" && typeof step.degrees === "number")
    .sort((a, b) => a.startsAtMs - b.startsAtMs)
    .map(
      (step, index): TimelineItem => ({
        degrees: step.degrees ?? 0,
        degreesX: step.degreesX,
        degreesY: step.degreesY,
        degreesZ: step.degreesZ,
        durationMs: step.durationMs,
        from: step.from,
        id: `saved-turn-${rule.id}-${step.id}-${index}`,
        kind: "turn",
        startsAtMs: step.startsAtMs,
        to: step.to,
      }),
    );
  return [...clipItems, ...rotationItems].sort((a, b) => (a.startsAtMs ?? 0) - (b.startsAtMs ?? 0));
}

function timelineResolvedSquares(item: TimelineItem, fallbackSquare: SquareName, previousEndSquare?: SquareName) {
  const explicitFrom = Boolean(item.from);
  const explicitTo = Boolean(item.to);
  let from = normalizeSquareInput(item.from, previousEndSquare ?? fallbackSquare);
  let to = normalizeSquareInput(item.to, explicitFrom ? from : previousEndSquare ?? from);

  if (previousEndSquare) {
    const fromLooksDefault = !explicitFrom || item.from === fallbackSquare;
    const toLooksDefault = !explicitTo || item.to === fallbackSquare;
    if (fromLooksDefault && previousEndSquare !== fallbackSquare) {
      from = previousEndSquare;
      if (toLooksDefault) to = previousEndSquare;
    }
  }

  return { from, to };
}

function timelineFinalSquare(timeline: TimelineItem[], piece: PieceKind) {
  const fallbackSquare = defaultSquareForPiece(piece);
  let previousEndSquare: SquareName | undefined;
  timeline.forEach((item) => {
    previousEndSquare = timelineResolvedSquares(item, fallbackSquare, previousEndSquare).to;
  });
  return previousEndSquare ?? fallbackSquare;
}

function timelineToChoreographySteps(timeline: TimelineItem[], clips: AnimationClip[], piece: PieceKind, action: AnimationAction): AnimationChoreographyStep[] {
  if (timeline.length === 0 && piece === "k" && action === "game-start-handshake") return openingCeremonySteps();

  // Checkmate-finisher squares are DYNAMIC — at runtime the piece dances from its live current
  // square to the opponent king. So we never bake fixed from/to squares into a finisher's steps;
  // the admin only authors which clips play and their timing.
  const dynamicSquares = action === "checkmate-finisher";
  const fallbackSquare = defaultSquareForPiece(piece);
  let fallbackStartsAtMs = 0;
  let previousEndSquare: SquareName | undefined;
  return timeline.map((item, index) => {
    const durationMs = timelineItemDurationMs(item, clips);
    const startsAtMs = item.startsAtMs ?? fallbackStartsAtMs;
    const { from, to } = timelineResolvedSquares(item, fallbackSquare, previousEndSquare);
    const step: AnimationChoreographyStep =
      item.kind === "clip"
        ? {
            clipId: item.clipId,
            durationMs,
            from: dynamicSquares ? undefined : from,
            id: `timeline-clip-${item.id}`,
            kind: "glb-clip",
            label: clips.find((clip) => clip.id === item.clipId)?.name ?? `Clip ${index + 1}`,
            startsAtMs,
            to: dynamicSquares ? undefined : to,
          }
        : {
            axis: "y",
            degrees: item.degrees,
            degreesX: item.degreesX,
            degreesY: item.degreesY,
            degreesZ: item.degreesZ,
            durationMs,
            from: dynamicSquares ? undefined : from,
            id: `timeline-turn-${item.id}`,
            kind: "rotation",
            label: `Turn ${item.degrees}deg`,
            startsAtMs,
            to: dynamicSquares ? undefined : to,
          };
    fallbackStartsAtMs += durationMs;
    previousEndSquare = to;
    return step;
  });
}


function activeTimelineItems(timeline: TimelineItem[], clips: AnimationClip[], tick: number) {
  const totalDuration = timelineTotalDurationMs(timeline, clips);
  const currentMs = tick % totalDuration;
  const active = timeline.flatMap((item, index) => {
    const startsAtMs = timelineItemStartMs(timeline, index, clips);
    const duration = timelineItemDurationMs(item, clips);
    if (currentMs < startsAtMs || currentMs > startsAtMs + duration) return [];
    return [{ durationMs: duration, item, localProgress: duration ? (currentMs - startsAtMs) / duration : 1, startsAtMs }];
  });
  if (active.length) return { active, currentMs, totalDuration };
  const last = timeline
    .map((item, index) => ({ durationMs: timelineItemDurationMs(item, clips), item, localProgress: 1, startsAtMs: timelineItemStartMs(timeline, index, clips) }))
    .filter((state) => state.startsAtMs <= currentMs)
    .sort((a, b) => b.startsAtMs - a.startsAtMs)[0];
  return { active: last ? [last] : [], currentMs, totalDuration };
}

function previewSquareCenter(square: SquareName, boardSize: number) {
  const squareSize = boardSize / 8;
  const fileIndex = previewFiles.indexOf(square[0] as (typeof previewFiles)[number]);
  const rank = Number(square[1]);
  return {
    x: fileIndex * squareSize + squareSize / 2,
    y: (8 - rank) * squareSize + squareSize / 2,
  };
}

// Checkmate-finisher previews never use authored squares — runtime squares are dynamic. Instead the
// preview demonstrates the travel by picking a random left-side box and a random right-side box (the
// edited direction lane decides which end is the start). Memoize so it stays put across preview ticks.
function randomFinisherSquares(direction: MovementDirection): { from: SquareName; to: SquareName } {
  const leftFiles = ["a", "b", "c", "d"] as const;
  const rightFiles = ["e", "f", "g", "h"] as const;
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
  const ranks: number[] = [2, 3, 4, 5, 6, 7];
  if (direction === "straight") {
    const file = pick([...leftFiles, ...rightFiles]);
    const lowRank = 2 + Math.floor(Math.random() * 2); // 2–3
    const highRank = 6 + Math.floor(Math.random() * 2); // 6–7
    return { from: `${file}${lowRank}` as SquareName, to: `${file}${highRank}` as SquareName };
  }
  const left = `${pick(leftFiles)}${pick(ranks)}` as SquareName;
  const right = `${pick(rightFiles)}${pick(ranks)}` as SquareName;
  return direction === "right-to-left" ? { from: right, to: left } : { from: left, to: right };
}

function AnimationBoardPreview({
  action,
  boardSize,
  boardAsset,
  clips,
  color,
  mateDirection,
  pieceAsset,
  piece,
  selectedFromSquare,
  selectedToSquare,
  tick,
  timeline,
}: {
  action: AnimationAction;
  boardSize?: number;
  boardAsset?: BoardPieceAsset;
  clips: AnimationClip[];
  color: "w" | "b";
  mateDirection?: MovementDirection;
  pieceAsset?: PieceAsset;
  piece: PieceKind;
  selectedFromSquare?: SquareName;
  selectedToSquare?: SquareName;
  tick: number;
  timeline: TimelineItem[];
}) {
  const previewBoardSize = boardSize ?? 260;
  const squareSize = previewBoardSize / 8;
  const isFinisher = action === "checkmate-finisher";
  // Sample dynamic squares for the finisher preview — re-rolled only when the piece/colour/direction
  // changes, so the demo path is stable while the animation loops.
  const finisherSquares = useMemo(
    () => (isFinisher ? randomFinisherSquares(mateDirection ?? "left-to-right") : null),
    [isFinisher, mateDirection, piece, color],
  );
  const { active, currentMs, totalDuration } = activeTimelineItems(timeline, clips, tick);
  const isOpening = piece === "k" && action === "game-start-handshake";
  const travelsOnBoard =
    isOpening ||
    action === "checkmate-finisher" ||
    action === "capture" ||
    action === "any-capture" ||
    action.startsWith("capture-") ||
    action.includes("move") ||
    action.includes("attack");
  const defaultStartSquare = isOpening ? ("e1" as SquareName) : defaultSquareForPiece(piece);
  const timelineStates = timeline.map((item, index) => {
    const startsAtMs = timelineItemStartMs(timeline, index, clips);
    const durationMs = timelineItemDurationMs(item, clips);
    return { durationMs, item, localProgress: durationMs ? Math.max(0, Math.min(1, (currentMs - startsAtMs) / durationMs)) : 1, startsAtMs };
  });
  const realActive = timelineStates.filter((state) => currentMs >= state.startsAtMs && currentMs <= state.startsAtMs + state.durationMs);
  const visibleActive = realActive.length ? realActive : active;
  const completedStates = timelineStates.filter((state) => state.startsAtMs + state.durationMs < currentMs);
  let completedEndSquare: SquareName | undefined;
  completedStates
    .sort((a, b) => a.startsAtMs - b.startsAtMs)
    .forEach((state) => {
      completedEndSquare = timelineResolvedSquares(state.item, defaultStartSquare, completedEndSquare).to;
    });
  const clipStates = realActive.filter((state) => state.item.kind === "clip") as Array<(typeof realActive)[number] & { item: Extract<TimelineItem, { kind: "clip" }> }>;
  const visibleClipStates = (clipStates.length ? clipStates : visibleActive.filter((state) => state.item.kind === "clip")) as Array<(typeof visibleActive)[number] & { item: Extract<TimelineItem, { kind: "clip" }> }>;
  const turnStates = realActive.filter((state) => state.item.kind === "turn") as Array<(typeof realActive)[number] & { item: Extract<TimelineItem, { kind: "turn" }> }>;
  const completedTurnStates = completedStates.filter((state) => state.item.kind === "turn") as Array<(typeof completedStates)[number] & { item: Extract<TimelineItem, { kind: "turn" }> }>;
  const primaryState = visibleActive.at(-1);
  const primaryItem = primaryState?.item;
  const motionState =
    clipStates.find((state) => state.item.from || state.item.to) ??
    realActive.find((state) => state.item.from || state.item.to) ??
    visibleActive.find((state) => state.item.from || state.item.to) ??
    primaryState;
  const motionItem = motionState?.item ?? primaryItem;
  const localProgress = primaryState?.localProgress ?? 1;
  const motionProgress = motionState?.localProgress ?? currentMs / totalDuration;
  const totalProgress = currentMs / totalDuration;
  const resolvedMotionSquares = motionItem ? timelineResolvedSquares(motionItem, defaultStartSquare, completedEndSquare) : undefined;
  const startSquare = isFinisher
    ? finisherSquares!.from
    : resolvedMotionSquares?.from ?? selectedFromSquare ?? completedEndSquare ?? defaultStartSquare;
  const endSquare = isFinisher
    ? finisherSquares!.to
    : resolvedMotionSquares?.to ?? selectedToSquare ?? completedEndSquare ?? (travelsOnBoard ? ("e4" as SquareName) : startSquare);
  // Highlight the sampled dynamic squares so the admin can see the finisher will travel between them.
  const highlightFromSquare = isFinisher ? finisherSquares!.from : selectedFromSquare;
  const highlightToSquare = isFinisher ? finisherSquares!.to : selectedToSquare;
  const start = previewSquareCenter(startSquare, previewBoardSize);
  const center = previewSquareCenter(endSquare, previewBoardSize);
  const hasExplicitBoardTravel = Boolean(motionItem && startSquare !== endSquare);
  const pathProgress = isFinisher
    ? Math.max(0, Math.min(1, totalProgress))
    : hasExplicitBoardTravel || travelsOnBoard
      ? Math.max(0, Math.min(1, motionProgress))
      : 0;
  const activeClip = visibleClipStates[0]?.item.kind === "clip" ? clips.find((clip) => clip.id === visibleClipStates[0].item.clipId) : undefined;
  const fallbackClip = timeline
    .filter((entry): entry is Extract<TimelineItem, { kind: "clip" }> => entry.kind === "clip")
    .map((entry) => clips.find((clip) => clip.id === entry.clipId))
    .find(Boolean);
  const previewClip = activeClip ?? fallbackClip;
  // Mirror the RUNTIME's GLB resolution (funny-mode effectFromAnimationRule) so the preview shows the
  // SAME model the game will actually play. The old resolver only looked at the timeline clip + the
  // piece-asset colour/shared/move/static slots, so a GLB that the runtime finds via its fallbacks —
  // a clip auto-detected for this piece, a clip whose compatiblePieces include it, or a celebrate-slot
  // asset — rendered "3D preview unavailable" here even though it plays fine in-game (the prod report).
  const detectedClipIds = new Set(pieceAsset?.detectedAnimationClipIds ?? []);
  const detectedPieceClip =
    clips.find((clip) => clip.sourceGlbPath && detectedClipIds.has(clip.id)) ??
    clips.find((clip) => clip.sourceGlbPath && pieceAsset?.id && clip.sourceAssetId === pieceAsset.id) ??
    clips.find((clip) => clip.sourceGlbPath && clip.compatiblePieces.includes(piece));
  const previewGlbPath = [previewClip?.sourceGlbPath, glbPathForColor(pieceAsset, color), detectedPieceClip?.sourceGlbPath].find(
    (path): path is string => canLoadGlbPath(path),
  );
  const playingClipNames = visibleClipStates
    .map((state) => clips.find((clip) => clip.id === state.item.clipId)?.name)
    .filter((name): name is string => Boolean(name));
  const showGlbPreview = Boolean(previewGlbPath && canLoadGlbPath(previewGlbPath));
  const x = start.x + (center.x - start.x) * pathProgress;
  const syntheticBounce = showGlbPreview ? 0 : Math.abs(Math.sin(totalProgress * Math.PI * 8)) * squareSize * 0.08;
  const y = start.y + (center.y - start.y) * pathProgress - syntheticBounce;
  const completedTurnXDegrees = completedTurnStates.reduce((total, state) => total + (state.item.degreesX ?? 0), 0);
  const completedTurnYDegrees = completedTurnStates.reduce((total, state) => total + (state.item.degreesY ?? 0), 0);
  const completedTurnZDegrees = completedTurnStates.reduce((total, state) => total + (state.item.degreesZ ?? state.item.degrees ?? 0), 0);
  const turnXDegrees = completedTurnXDegrees + turnStates.reduce((total, state) => total + (state.item.degreesX ?? 0) * state.localProgress, 0);
  const turnYDegrees = completedTurnYDegrees + turnStates.reduce((total, state) => total + (state.item.degreesY ?? 0) * state.localProgress, 0);
  const turnZDegrees = completedTurnZDegrees + turnStates.reduce((total, state) => total + (state.item.degreesZ ?? state.item.degrees ?? 0) * state.localProgress, 0);
  const playingLabel = realActive.length > 1
    ? `Merged: ${realActive.map((state) => timelineItemLabel(state.item, clips)).join(" + ")}`
    : primaryItem?.kind === "clip"
      ? activeClip?.name ?? "GLB clip"
      : primaryItem
        ? `Turn ${primaryItem.degrees}deg`
        : "Add clips";
  const previewPieceSize = showGlbPreview ? squareSize * 2.2 : squareSize * 1.32;
  const coordinateFontSize = Math.max(10, Math.min(16, squareSize * 0.23));
  return (
    <View style={[styles.animationPreviewStage, { minHeight: previewBoardSize + 46, paddingVertical: 6 }]}>
      <View style={styles.previewBoardShell}>
        <View style={[styles.previewBoard, { height: previewBoardSize, width: previewBoardSize }]}>
          {previewRanks.map((rank, rankIndex) =>
            previewFiles.map((file, fileIndex) => (
              <View
                key={`${file}${rank}`}
                style={[
                  styles.previewSquare,
                  (fileIndex + rankIndex) % 2 === 0 ? styles.previewSquareLight : styles.previewSquareDark,
                  squareName(file, rank) === highlightFromSquare && { borderColor: "#f6c552", borderWidth: 3, zIndex: 2 },
                  squareName(file, rank) === highlightToSquare && { borderColor: "#3f7ae0", borderWidth: 3, zIndex: 2 },
                  { height: squareSize, left: fileIndex * squareSize, top: rankIndex * squareSize, width: squareSize },
                ]}
              />
            )),
          )}
          <View pointerEvents="none" style={[styles.previewCoordinateLayer, { height: previewBoardSize, width: previewBoardSize }]}>
            {previewRanks.map((rank, rankIndex) => {
              const labelColor = rankIndex % 2 === 0 ? "rgba(22,50,70,0.76)" : "rgba(255,255,255,0.9)";
              return (
                <Text
                  key={`rank-${rank}`}
                  style={[
                    styles.previewRankLabel,
                    {
                      color: labelColor,
                      fontSize: coordinateFontSize,
                      left: Math.max(4, squareSize * 0.1),
                      top: rankIndex * squareSize + Math.max(3, squareSize * 0.08),
                    },
                  ]}
                >
                  {rank}
                </Text>
              );
            })}
            {previewFiles.map((file, fileIndex) => {
              const labelColor = fileIndex % 2 === 0 ? "rgba(255,255,255,0.9)" : "rgba(22,50,70,0.76)";
              return (
                <Text
                  key={`file-${file}`}
                  style={[
                    styles.previewFileLabel,
                    {
                      color: labelColor,
                      fontSize: coordinateFontSize,
                      left: fileIndex * squareSize + Math.max(4, squareSize * 0.1),
                      top: previewBoardSize - coordinateFontSize - Math.max(4, squareSize * 0.08),
                      width: squareSize - Math.max(8, squareSize * 0.18),
                    },
                  ]}
                >
                  {file}
                </Text>
              );
            })}
          </View>
          <View
            style={[
              styles.previewStaticPieceFrame,
              {
                height: previewPieceSize,
                left: x - previewPieceSize / 2,
                top: y - previewPieceSize * 0.68,
                transform: [
                  { scale: 1 + Math.sin(localProgress * Math.PI) * 0.08 },
                ],
                width: previewPieceSize,
              },
            ]}
          >
            {showGlbPreview ? (
              <GlbModelPreview
                clipName={playingClipNames[0] ?? previewClip?.name}
                clipNames={playingClipNames.length > 1 ? playingClipNames : undefined}
                color={color}
                glbPath={previewGlbPath}
                piece={piece}
                autoFrame
                rotationXDeg={turnXDegrees}
                rotationYDeg={turnYDegrees}
                rotationZDeg={turnZDegrees}
                showFallback={false}
              />
            ) : null}
          </View>
          {!showGlbPreview && (
            <View pointerEvents="none" style={styles.previewMissingGlbNotice}>
              <Text style={styles.previewMissingGlbTitle}>3D preview unavailable</Text>
              <Text style={styles.previewMissingGlbText}>Upload or select a valid GLB clip. Static board icons are not animated here.</Text>
            </View>
          )}
        </View>
        <View style={styles.previewBoardCaption}>
          <Text style={styles.previewSequenceLabel}>Live board preview</Text>
          <Text numberOfLines={1} style={styles.previewNowPlaying}>{playingLabel}</Text>
        </View>
      </View>
    </View>
  );
}

export function AnimationStudioAdmin({ data, reload, services, settings, setSettings }: AnimationStudioAdminProps) {
  const [pieceSets, setPieceSets] = useState<PieceSet[]>(data.pieceSets ?? []);
  const [animationSetsState, setAnimationSetsState] = useState<AnimationSet[]>(data.animationSets ?? []);
  const [clips, setClips] = useState<AnimationClip[]>(data.animationClips ?? []);
  const [tab, setTab] = useState<"pieces" | "animations" | "ceremony" | "releases">("pieces");
  const editablePieceSets = useMemo(() => pieceSets.filter((set) => !set.isSeededExample), [pieceSets]);
  // Open the studio on the SAME set/animation the game is actually playing, so "what you see in the
  // studio = what plays in the game". The runtime (selectedPieceSetForSettings) resolves the active
  // piece set from the active animation set's binding (animationSet.pieceSetId), falling back to
  // settings.pieceSetId — so the live ceremony GLBs hang off THAT set, not necessarily the first one.
  // Defaulting the studio to editablePieceSets[0] instead made the preview render "3D preview
  // unavailable" whenever the active set wasn't first (the prod report: ceremony plays in-game, blank
  // here). Mirror the runtime's resolution for the initial selection; the picker still lets you browse.
  const activeAnimationSetId = settings.animationSetId;
  const activePlayPieceSetId =
    (activeAnimationSetId ? animationSetsState.find((set) => set.id === activeAnimationSetId)?.pieceSetId : undefined) ??
    settings.pieceSetId;
  const initialPieceSetId = editablePieceSets.find((set) => set.id === activePlayPieceSetId)?.id ?? editablePieceSets[0]?.id ?? "";
  const [selectedPieceSetId, setSelectedPieceSetId] = useState(initialPieceSetId);
  const selectedPieceSet = editablePieceSets.find((set) => set.id === selectedPieceSetId) ?? editablePieceSets[0];
  const animationSets = useMemo(
    () => animationSetsState.filter((set: AnimationSet) => set.pieceSetId === selectedPieceSet?.id),
    [animationSetsState, selectedPieceSet?.id],
  );
  const [selectedAnimationSetId, setSelectedAnimationSetId] = useState(
    animationSets.find((set) => set.id === activeAnimationSetId)?.id ?? animationSets[0]?.id ?? "",
  );
  const selectedAnimationSet = animationSets.find((set: AnimationSet) => set.id === selectedAnimationSetId) ?? animationSets[0];
  const [selectedPiece, setSelectedPiece] = useState<PieceKind>("k");
  const [boardColor, setBoardColor] = useState<"w" | "b">("w");
  // Board Piece Upload + Sound Pack collapse independently under the selected piece set — both used
  // to render open together beneath the piece-set grid regardless of whether you needed them, which
  // meant scrolling past a full piece roster + a 6-row sound table just to reach the piece-set list
  // for a DIFFERENT set. Collapsed by default; opening one is a deliberate act now.
  const [pieceDetailOpen, setPieceDetailOpen] = useState({ boardUpload: false, soundPack: false });
  const [animationColor, setAnimationColor] = useState<"both" | "w" | "b">("both");
  const [animationSlot, setAnimationSlot] = useState<PieceAssetSlotKey>("shared");
  const [action, setAction] = useState<AnimationAction>("game-start-handshake");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  // Checkmate-finisher is authored per movement direction. The direction currently being edited
  // lives in `timeline`; the other two directions are parked in `directionalTimelines` until save.
  const [mateDirection, setMateDirection] = useState<MovementDirection>("straight");
  const [directionalTimelines, setDirectionalTimelines] = useState<Partial<Record<MovementDirection, TimelineItem[]>>>({});
  // Checkmate-finisher only: how the defeated king reacts when the winning piece reaches it.
  const [loserReaction, setLoserReaction] = useState<LoserReaction>(defaultLoserReaction);
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState(0);
  const [draggingTimelineBar, setDraggingTimelineBar] = useState<{ deltaX: number; index: number } | null>(null);
  const [timelineEditor, setTimelineEditor] = useState<{ draft: TimelineEditorDraft; index: number | null; mode: "add" | "edit" } | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [newPieceSetName, setNewPieceSetName] = useState("Untitled Piece Set");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const livePreviewAnchorRef = useRef<HTMLElement | null>(null);
  const [livePreviewFrame, setLivePreviewFrame] = useState({ width: 0 });
  const selectedPieceAsset = selectedPieceSet?.pieces[selectedPiece];
  const selectedAnimationSourcePath =
    selectedPieceAsset?.assetSlots?.[animationSlot]?.path ??
    (animationSlot === "shared" ? selectedPieceAsset?.assetSlots?.static?.path ?? selectedPieceAsset?.glbPath : undefined);
  const compatibleClips = selectedAnimationSourcePath
    ? clips.filter((clip) => clip.compatiblePieces.includes(selectedPiece) && clip.sourceGlbPath === selectedAnimationSourcePath)
    : [];
  const actions = [...pieceActionOptions[selectedPiece]];

  useEffect(() => setPieceSets(data.pieceSets ?? []), [data.pieceSets]);
  useEffect(() => setAnimationSetsState(data.animationSets ?? []), [data.animationSets]);
  useEffect(() => setClips(data.animationClips ?? []), [data.animationClips]);
  useEffect(() => {
    if (!editablePieceSets.length) return;
    if (!editablePieceSets.some((set) => set.id === selectedPieceSetId)) setSelectedPieceSetId(editablePieceSets[0].id);
  }, [editablePieceSets, selectedPieceSetId]);

  useEffect(() => {
    if (!animationSets.length) {
      if (selectedAnimationSetId) setSelectedAnimationSetId("");
      return;
    }
    if (!animationSets.some((set: AnimationSet) => set.id === selectedAnimationSetId)) {
      setSelectedAnimationSetId(animationSets[0].id);
    }
  }, [animationSets, selectedAnimationSetId]);

  useEffect(() => {
    if (!actions.some((item) => item.id === action)) setAction(actions[0]?.id ?? "checkmate-finisher");
  }, [action, actions]);

  useEffect(() => {
    const savedRule = selectedAnimationSet?.rules.find(
      (rule: AnimationRule) =>
        rule.piece === selectedPiece &&
        rule.action === action &&
        (rule.color ?? "both") === animationColor,
    );
    if (action === "checkmate-finisher") {
      // Rebuild the three per-direction lanes from the saved rule. Resets to the "straight" lane
      // whenever the rule context (piece / colour / set) changes.
      const built: Partial<Record<MovementDirection, TimelineItem[]>> = {};
      const dirs = savedRule?.directional;
      movementDirections.forEach((d) => {
        const slot = dirs?.[d];
        if (slot && ((slot.clipStack?.length ?? 0) > 0 || (slot.choreographySteps?.length ?? 0) > 0)) {
          built[d] = timelineFromAnimationRule({ ...(savedRule as AnimationRule), clipStack: slot.clipStack ?? [], choreographySteps: slot.choreographySteps ?? [] });
        }
      });
      // Back-compat: a legacy non-directional checkmate rule seeds the "straight" lane.
      if (!Object.keys(built).length && savedRule && ((savedRule.clipStack?.length ?? 0) > 0 || (savedRule.choreographySteps?.length ?? 0) > 0)) {
        built.straight = timelineFromAnimationRule(savedRule);
      }
      setDirectionalTimelines(built);
      setMateDirection("straight");
      setTimeline(built.straight ?? []);
      setLoserReaction(resolveLoserReaction(savedRule?.loserReaction));
    } else {
      setDirectionalTimelines({});
      setTimeline(timelineFromAnimationRule(savedRule));
    }
  }, [action, animationColor, selectedAnimationSet?.id, selectedAnimationSet?.updatedAt, selectedPiece]);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setPreviewTick(Date.now() - startedAt), 80);
    return () => clearInterval(timer);
  }, [timeline, selectedPiece, action]);

  useEffect(() => {
    if (selectedTimelineIndex >= timeline.length) setSelectedTimelineIndex(Math.max(0, timeline.length - 1));
  }, [selectedTimelineIndex, timeline.length]);

  // Switch which checkmate direction is being edited. Parks the current lane's edits, loads the next.
  function selectMateDirection(next: MovementDirection) {
    if (next === mateDirection) return;
    setDirectionalTimelines((prev) => ({ ...prev, [mateDirection]: timeline }));
    setTimeline(directionalTimelines[next] ?? []);
    setMateDirection(next);
    setSelectedTimelineIndex(0);
  }

  // For the direction chips: which directions are custom-authored, and (for the rest) what each
  // will reuse at runtime — mirroring the opposite side, exactly as resolveDirectionalSlot does.
  const mateDirectionStatus = useMemo(() => {
    const live: Partial<Record<MovementDirection, TimelineItem[]>> = { ...directionalTimelines, [mateDirection]: timeline };
    const authoredSlots: DirectionalSlots = {};
    movementDirections.forEach((d) => {
      if ((live[d]?.length ?? 0) > 0) authoredSlots[d] = { clipStack: [{ clipId: d, order: 0 }] };
    });
    const status = {} as Record<MovementDirection, { authored: boolean; reuse: string }>;
    movementDirections.forEach((d) => {
      if ((live[d]?.length ?? 0) > 0) {
        status[d] = { authored: true, reuse: "Custom" };
        return;
      }
      const resolved = resolveDirectionalSlot(authoredSlots, d);
      status[d] = {
        authored: false,
        reuse: resolved ? `Reuses ${movementDirectionLabel[resolved.sourceDirection]}${resolved.mirror ? " ⇄" : ""}` : "Not set",
      };
    });
    return status;
  }, [directionalTimelines, mateDirection, timeline]);

  useEffect(() => {
    const windowRef = (globalThis as { window?: Window }).window;
    if (tab !== "animations" || !selectedPieceSet || !windowRef) return;

    let frame = 0;
    const updatePreviewFrame = () => {
      frame = 0;
      const anchor = livePreviewAnchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(320, Math.min(rect.width, windowRef.innerWidth - 16));
      setLivePreviewFrame((current) => (Math.abs(current.width - width) < 1 ? current : { width }));
    };
    const schedule = () => {
      if (frame) return;
      frame = windowRef.requestAnimationFrame(updatePreviewFrame);
    };

    schedule();
    windowRef.addEventListener("resize", schedule);
    return () => {
      if (frame) windowRef.cancelAnimationFrame(frame);
      windowRef.removeEventListener("resize", schedule);
    };
  }, [action, selectedPiece, selectedPieceSet, tab, timeline.length]);

  async function activateForPlay(pieceSetId: string, animationSetId = selectedAnimationSet?.id) {
    const nextSettings = { ...settings, animationSetId, animationsEnabled: Boolean(animationSetId), enabled: Boolean(animationSetId), pieceSetId };
    setSettings(nextSettings);
    await services.settings.saveSettings(data.user?.id ?? "admin-local", nextSettings);
  }

  function openAddAnimation() {
    const draft = defaultTimelineDraft(compatibleClips, selectedPiece, timeline.length ? timelineFinalSquare(timeline, selectedPiece) : undefined);
    setTimelineEditor({
      draft: { ...draft, startsAtMs: timeline.length ? timelineTotalDurationMs(timeline, clips) : 0 },
      index: null,
      mode: "add",
    });
  }

  function openEditAnimation(index: number) {
    const item = timeline[index];
    if (!item) return;
    setSelectedTimelineIndex(index);
    setTimelineEditor({ draft: timelineItemToDraft(item, clips), index, mode: "edit" });
  }

  function saveTimelineEditor() {
    if (!timelineEditor) return;
    const draft = timelineEditor.draft;
    const previousItem = timelineEditor.index === null ? null : timeline[timelineEditor.index] ?? null;
    const from = normalizeSquareInput(draft.from, previousItem?.from ?? defaultSquareForPiece(selectedPiece));
    const to = normalizeSquareInput(draft.to, previousItem?.to ?? from);
    let fallbackDurationMs = previousItem ? timelineItemDurationMs(previousItem, clips) : 700;
    if (!previousItem && draft.kind === "clip") {
      fallbackDurationMs = clips.find((clip) => clip.id === draft.clipId)?.durationMs ?? 1400;
    }
    const durationMs = Math.max(240, Math.round(Number(draft.durationMs) || fallbackDurationMs));
    const startsAtMs = Math.max(0, Math.round(Number(draft.startsAtMs) || 0));
    const nextSelectedTimelineIndex = timelineEditor.index === null ? timeline.length : timelineEditor.index;
    const item: TimelineItem =
      draft.kind === "clip"
        ? {
            clipId: draft.clipId,
            durationMs,
            from,
            id: timelineEditor.index === null ? `clip-${Date.now()}-${timeline.length}` : timeline[timelineEditor.index]?.id ?? `clip-${Date.now()}`,
            kind: "clip",
            startsAtMs,
            to,
          }
        : {
            degrees: draft.degreesZ || draft.degrees,
            degreesX: draft.degreesX,
            degreesY: draft.degreesY,
            degreesZ: draft.degreesZ,
            durationMs,
            from,
            id: timelineEditor.index === null ? `turn-${Date.now()}-${timeline.length}` : timeline[timelineEditor.index]?.id ?? `turn-${Date.now()}`,
            kind: "turn",
            startsAtMs,
            to,
          };
    setTimeline((current) => (timelineEditor.index === null ? [...current, item] : current.map((entry, index) => (index === timelineEditor.index ? item : entry))));
    setSelectedTimelineIndex(nextSelectedTimelineIndex);
    setFeedback({ tone: "saved", text: "Animation step updated. Press Save to store this rule." });
    setTimelineEditor(null);
  }

  function updateTimelineItemAt(index: number, patch: Partial<TimelineItem>) {
    setTimeline((current) => current.map((item, itemIndex) => (itemIndex === index ? ({ ...item, ...patch } as TimelineItem) : item)));
  }

  function bindLivePreviewAnchor(node: unknown) {
    livePreviewAnchorRef.current = node as HTMLElement | null;
  }

  function resizeTimelineItem(index: number, deltaMs: number) {
    const item = timeline[index];
    if (!item) return;
    const currentDuration = timelineItemDurationMs(item, clips);
    const nextDuration = Math.max(240, currentDuration + deltaMs);
    updateTimelineItemAt(index, timelineDurationPatch(item, nextDuration));
  }

  function beginTimelineResize(index: number, edge: "start" | "end", event: any) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const documentRef = (globalThis as { document?: Document }).document;
    const item = timeline[index];
    const startX = event?.clientX ?? event?.nativeEvent?.clientX;
    if (!documentRef || !item || typeof startX !== "number") {
      resizeTimelineItem(index, edge === "end" ? 300 : -300);
      return;
    }
    const initialDuration = timelineItemDurationMs(item, clips);
    const initialStartMs = timelineItemStartMs(timeline, index, clips);
    const msPerPixel = Math.max(6, timelineDurationMs / timelineStripWidth);
    const onMove = (moveEvent: PointerEvent) => {
      // clientX deltas are visual px; msPerPixel comes from layout timelineStripWidth — convert once here.
      const deltaX = visualToLayout(moveEvent.clientX - startX);
      if (edge === "start") {
        const nextStartMs = Math.max(0, initialStartMs + deltaX * msPerPixel);
        const nextDuration = Math.max(240, initialDuration - deltaX * msPerPixel);
        setTimeline((current) =>
          current.map((entry, itemIndex) =>
            itemIndex === index
              ? ({ ...entry, startsAtMs: Math.round(nextStartMs), ...timelineDurationPatch(entry, nextDuration) } as TimelineItem)
              : entry,
          ),
        );
        return;
      }
      const nextDuration = Math.max(240, initialDuration + deltaX * msPerPixel);
      setTimeline((current) =>
        current.map((entry, itemIndex) => (itemIndex === index ? ({ ...entry, ...timelineDurationPatch(entry, nextDuration) } as TimelineItem) : entry)),
      );
    };
    const onUp = () => {
      documentRef.removeEventListener("pointermove", onMove);
      documentRef.removeEventListener("pointerup", onUp);
    };
    documentRef.addEventListener("pointermove", onMove);
    documentRef.addEventListener("pointerup", onUp, { once: true });
  }

  function beginTimelineBarDrag(index: number, event: any) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const documentRef = (globalThis as { document?: Document }).document;
    const startX = event?.clientX ?? event?.nativeEvent?.clientX;
    if (!documentRef || typeof startX !== "number") {
      setSelectedTimelineIndex(index);
      return;
    }
    const initialStartMs = timelineItemStartMs(timeline, index, clips);
    const msPerPixel = Math.max(6, timelineDurationMs / timelineStripWidth);
    const onMove = (moveEvent: PointerEvent) => {
      // clientX deltas are visual px; msPerPixel comes from layout timelineStripWidth — convert once here.
      const deltaX = visualToLayout(moveEvent.clientX - startX);
      setDraggingTimelineBar({ deltaX, index });
      const desiredStartMs = Math.max(0, initialStartMs + deltaX * msPerPixel);
      setTimeline((current) =>
        current.map((entry, itemIndex) =>
          itemIndex === index ? ({ ...entry, startsAtMs: Math.round(desiredStartMs) } as TimelineItem) : entry,
        ),
      );
    };
    const onUp = () => {
      documentRef.removeEventListener("pointermove", onMove);
      documentRef.removeEventListener("pointerup", onUp);
      setDraggingTimelineBar(null);
      setSelectedTimelineIndex(index);
    };
    documentRef.addEventListener("pointermove", onMove);
    documentRef.addEventListener("pointerup", onUp, { once: true });
  }

  async function createPieceSet() {
    const created = await services.animationStudio.createPieceSet({
      description: "Static board-piece images for normal gameplay. Animation GLBs are attached separately in Animation Sets.",
      name: newPieceSetName.trim() || "Untitled Piece Set",
    });
    setPieceSets((current) => [...current, created]);
    setSelectedPieceSetId(created.id);
    await reload();
  }

  async function savePieceSet(pieceSet: PieceSet) {
    const saved = await services.animationStudio.savePieceSet(pieceSet);
    setPieceSets((current) => current.map((set) => (set.id === saved.id ? saved : set)));
    setSelectedPieceSetId(saved.id);
    await reload();
    return saved;
  }

  async function makeSelectedPieceSetDefault() {
    if (!selectedPieceSet) return;
    try {
      await services.animationStudio.setDefaultPieceSet(selectedPieceSet.id);
      setFeedback({ tone: "saved", text: `"${selectedPieceSet.name}" is now the default piece set.` });
      await reload();
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not set the default piece set." });
    }
  }

  async function deleteSelectedPieceSet() {
    if (!selectedPieceSet) return;
    // The default piece set is protected — the service rejects the delete with a clear reason
    // ("make another piece set the default first"), which we surface here.
    try {
      await services.animationStudio.deletePieceSet(selectedPieceSet.id);
      setFeedback({ tone: "saved", text: `Deleted "${selectedPieceSet.name}".` });
      setSelectedPieceSetId("");
      await reload();
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not delete this piece set." });
    }
  }

  async function uploadBoardPiece() {
    if (!selectedPieceSet) return;
    const file = await chooseFile(".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp");
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    const isImage = lowerName.endsWith(".svg") || lowerName.endsWith(".png") || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg") || lowerName.endsWith(".webp");
    if (!isImage) {
      setFeedback({ tone: "error", text: "Board pieces must be SVG or standard image files (PNG, JPG, WEBP). Upload GLB files only inside Animation Sets." });
      return;
    }
    setFeedback({ tone: "saving", text: `Uploading ${boardColor === "w" ? "White" : "Black"} ${pieceNames[selectedPiece]} board piece...` });
    try {
      const uploaded = await uploadBoardPieceFileToServer(file, selectedPiece, boardColor);
      const fileName = uploaded.fileName ?? file.name;
      const assetKind: "svg" | "image" = lowerName.endsWith(".svg") ? "svg" : "image";
      const boardAsset: BoardPieceAsset = {
        assetId: uploaded.assetId,
        color: boardColor,
        fileName,
        kind: assetKind,
        objectName: uploaded.objectName,
        path: uploaded.assetUrl,
        piece: selectedPiece,
        storage: uploaded.storage,
        uploadedAt: new Date().toISOString(),
      };
      const saved = await savePieceSet({
        ...selectedPieceSet,
        boardAssets: {
          ...selectedPieceSet.boardAssets,
          [boardColor]: { ...selectedPieceSet.boardAssets?.[boardColor], [selectedPiece]: boardAsset },
        },
        updatedAt: new Date().toISOString(),
      });
      await activateForPlay(saved.id);
      setFeedback({ tone: "saved", text: `${pieceNames[selectedPiece]} SVG saved in this Piece Set.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Board piece upload failed." });
    }
  }

  async function uploadSoundForEvent(event: PieceSetSoundEvent) {
    if (!selectedPieceSet) return;
    const file = await chooseFile(".mp3,.wav,.ogg,.m4a,.webm,audio/*");
    if (!file) return;
    if (!isAudioFileAcceptable(file)) {
      setFeedback({ tone: "error", text: "Sound must be an audio file (MP3, WAV, OGG, M4A, WEBM)." });
      return;
    }
    setFeedback({ tone: "saving", text: `Uploading ${event} sound...` });
    try {
      const uploaded = await uploadSoundFileToServer(file, event);
      const asset: PieceSetSoundAsset = {
        assetId: uploaded.assetId,
        assetUrl: uploaded.assetUrl,
        bytes: uploaded.bytes,
        fileName: uploaded.fileName ?? file.name,
        objectName: uploaded.objectName,
        storage: uploaded.storage,
        uploadedAt: new Date().toISOString(),
      };
      const saved = await savePieceSet({
        ...selectedPieceSet,
        sounds: { ...selectedPieceSet.sounds, [event]: asset },
        updatedAt: new Date().toISOString(),
      });
      await activateForPlay(saved.id);
      setFeedback({ tone: "saved", text: `${event} sound saved.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Sound upload failed." });
    }
  }

  async function clearSoundForEvent(event: PieceSetSoundEvent) {
    if (!selectedPieceSet) return;
    const nextSounds = { ...(selectedPieceSet.sounds ?? {}) };
    delete nextSounds[event];
    try {
      await savePieceSet({
        ...selectedPieceSet,
        sounds: nextSounds,
        updatedAt: new Date().toISOString(),
      });
      setFeedback({ tone: "saved", text: `${event} sound cleared.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not clear sound." });
    }
  }

  function previewSoundForEvent(event: PieceSetSoundEvent) {
    const asset = selectedPieceSet?.sounds?.[event];
    if (!asset?.assetUrl) return;
    try {
      const audio = new Audio(resolveSoundAssetUri(asset.assetUrl));
      audio.volume = 0.6;
      void audio.play();
    } catch (e) {
      console.warn("[admin] sound preview failed", e);
    }
  }

  async function createAnimationSet() {
    if (!selectedPieceSet) return;
    const created = await services.animationStudio.createAnimationSet({
      description: "Opening and checkmate animation rules linked to this piece set.",
      name: `${selectedPieceSet.name} Ceremonies`,
      pieceSetId: selectedPieceSet.id,
    });
    setAnimationSetsState((current) => [...current.filter((set) => set.id !== created.id), created]);
    setSelectedAnimationSetId(created.id);
    await activateForPlay(selectedPieceSet.id, created.id);
    await reload();
  }

  async function uploadAnimationGlb() {
    if (!selectedPieceSet) return;
    const file = await chooseFile(".glb,.gltf,model/gltf-binary,model/gltf+json");
    if (!file) return;
    setFeedback({ tone: "saving", text: `Uploading ${pieceNames[selectedPiece]} ${animationSlot} GLB...` });
    try {
      const uploaded = await uploadAssetFileToServer(file, selectedPiece, animationSlot);
      const sourceAssetId = `piece-asset-${selectedPiece}-${animationSlot}-${Date.now()}`;
      const detected = await detectGlbAnimationClips(uploaded.assetUrl, selectedPiece, sourceAssetId);
      // Guard: replacing this slot's GLB must not drop a movement an animation currently uses,
      // or that animation would silently break. Block the replacement and tell the admin which.
      const previousGlbPath = selectedPieceSet.pieces[selectedPiece]?.assetSlots?.[animationSlot]?.path;
      if (previousGlbPath && previousGlbPath !== uploaded.assetUrl) {
        const missing = missingMovementsOnGlbReplace({
          allClips: clips,
          inUse: inUseClipIds(animationSetsState.filter((set) => set.pieceSetId === selectedPieceSet.id)),
          newClipNames: detected.map((clip) => clip.name),
          oldGlbPath: previousGlbPath,
        });
        if (missing.length > 0) {
          setFeedback({ tone: "error", text: `Replacement blocked — the new GLB is missing movement(s) still in use: ${missing.join(", ")}. Update or remove those animations first, or upload a GLB that still includes them.` });
          return;
        }
      }
      if (detected.length > 0) await services.animationStudio.saveAnimationClips(detected);
      setClips((current) => {
        const merged = new Map(current.map((clip) => [clip.id, clip]));
        detected.forEach((clip) => merged.set(clip.id, clip));
        return [...merged.values()];
      });
      const previous = selectedPieceSet.pieces[selectedPiece];
      const slot = {
        assetId: uploaded.assetId,
        fileName: uploaded.fileName ?? file.name,
        kind: "glb" as const,
        objectName: uploaded.objectName,
        path: uploaded.assetUrl,
        storage: uploaded.storage,
        uploadedAt: new Date().toISOString(),
      };
      const saved = await savePieceSet({
        ...selectedPieceSet,
        animationClipIds: Array.from(new Set([...selectedPieceSet.animationClipIds, ...detected.map((clip) => clip.id)])),
        pieces: {
          ...selectedPieceSet.pieces,
          [selectedPiece]: {
            ...previous,
            assetSlots: { ...previous?.assetSlots, [animationSlot]: slot, ...(animationSlot === "shared" ? { static: slot, move: slot, capture: slot, celebrate: slot } : {}) },
            detectedAnimationClipIds: Array.from(new Set([...(previous?.detectedAnimationClipIds ?? []), ...detected.map((clip) => clip.id)])),
            displayName: `${pieceNames[selectedPiece]} ceremony GLB`,
            glbPath: previous?.glbPath ?? uploaded.assetUrl,
            id: previous?.id ?? `piece-asset-${selectedPiece}-${Date.now()}`,
            piece: selectedPiece,
            uploadedAt: new Date().toISOString(),
          },
        },
      });
      await activateForPlay(saved.id);
      setTimeline(detected.slice(0, 2).map((clip, index) => ({ clipId: clip.id, durationMs: clip.durationMs, id: `clip-${Date.now()}-${index}`, kind: "clip" })));
      setFeedback({ tone: "saved", text: `${detected.length} animation clip${detected.length === 1 ? "" : "s"} linked to ${pieceNames[selectedPiece]}.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Animation GLB upload failed." });
    }
  }

  async function saveAnimationRule() {
    const isDirectional = action === "checkmate-finisher";
    // For checkmate-finisher the current lane plus the parked lanes form the full set of directions.
    const allDirTimelines: Partial<Record<MovementDirection, TimelineItem[]>> = { ...directionalTimelines, [mateDirection]: timeline };
    const authoredDirs = isDirectional ? movementDirections.filter((d) => (allDirTimelines[d]?.length ?? 0) > 0) : [];
    if (isDirectional ? authoredDirs.length === 0 : timeline.length === 0) {
      setFeedback({
        tone: "error",
        text: isDirectional
          ? "Author at least one direction (straight, left→right or right→left) before saving."
          : "Add at least one timeline step (Add animation) before saving.",
      });
      return;
    }
    if (!selectedPieceSet) {
      setFeedback({ tone: "error", text: "Select or create a piece set first." });
      return;
    }
    setFeedback({ tone: "saving", text: "Saving animation rule..." });
    try {
      // Save should always work: if no Animation Set exists yet, create one automatically.
      let targetSet = selectedAnimationSet;
      if (!targetSet) {
        targetSet = await services.animationStudio.createAnimationSet({
          description: "Animation rules for this piece set.",
          name: `${selectedPieceSet.name} animations`,
          pieceSetId: selectedPieceSet.id,
        });
        setAnimationSetsState((current) => [...current, targetSet as AnimationSet]);
        setSelectedAnimationSetId(targetSet.id);
      }
      const existingRule = targetSet.rules.find((item: AnimationRule) => item.piece === selectedPiece && item.action === action && (item.color ?? "both") === animationColor);
      const slotFromTimeline = (tl: TimelineItem[]) => ({
        choreographySteps: timelineToChoreographySteps(tl, clips, selectedPiece, action),
        clipStack: tl.flatMap((item, order) =>
          item.kind === "clip"
            ? [{ clipId: item.clipId, durationMs: timelineItemDurationMs(item, clips), order }]
            : [],
        ),
      });
      // Directional rules carry a slot per authored direction; the legacy clipStack/choreography
      // mirror the first authored direction so non-directional consumers still get a sane fallback.
      let directional: DirectionalSlots | undefined;
      let legacyTimeline = timeline;
      if (isDirectional) {
        directional = {};
        authoredDirs.forEach((d) => {
          directional![d] = slotFromTimeline(allDirTimelines[d]!);
        });
        legacyTimeline = allDirTimelines[authoredDirs[0]]!;
      }
      const legacy = slotFromTimeline(legacyTimeline);
      const rule: AnimationRule = {
        action,
        choreographySteps: legacy.choreographySteps,
        clipStack: legacy.clipStack,
        color: animationColor,
        ...(directional ? { directional } : {}),
        ...(isDirectional ? { loserReaction } : {}),
        enabled: true,
        id: existingRule?.id ?? `rule-${selectedPiece}-${action}-${Date.now()}`,
        piece: selectedPiece,
        speed: "medium",
      };
      const saved = await services.animationStudio.saveAnimationSet({
        ...targetSet,
        rules: [...targetSet.rules.filter((item: AnimationRule) => !(item.piece === selectedPiece && item.action === action && (item.color ?? "both") === animationColor)), rule],
      });
      setAnimationSetsState((current) => (current.some((set) => set.id === saved.id) ? current.map((set) => (set.id === saved.id ? saved : set)) : [...current, saved]));
      setSelectedAnimationSetId(saved.id);
      // Non-directional rules refresh the single timeline immediately; directional rules are
      // re-hydrated by the load effect after reload() (which resets to the "straight" lane).
      if (!isDirectional) setTimeline(timelineFromAnimationRule(rule));
      await activateForPlay(saved.pieceSetId, saved.id);
      setFeedback({ tone: "saved", text: `${pieceNames[selectedPiece]} ${animationActionLabel(action).toLowerCase()} rule saved.` });
      await reload();
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Could not save animation rule." });
    }
  }

  const timelineDurationMs = timelineTotalDurationMs(timeline, clips);
  const timelineStripWidth = Math.max(860, Math.round(timelineDurationMs / 8));
  const timelinePlayheadLeft = ((previewTick % timelineDurationMs) / timelineDurationMs) * timelineStripWidth;
  const timelineLaneHeight = 152;
  const timelineStripHeight = Math.max(136, timeline.length * timelineLaneHeight + 30);
  const livePreviewBoardSize = Math.round(Math.max(320, Math.min(680, (livePreviewFrame.width || 560) - 20)));
  const livePreviewPanel = selectedPieceSet ? (
    <View style={[styles.animationBuilderPanel, { alignSelf: "stretch", flex: 0, gap: 8, padding: 10 }]}>
      <View style={[styles.animationStudioSectionHeader, { marginTop: 0 }]}>
        <View>
          <Text style={styles.animationStudioSubTitle}>Live Preview</Text>
        </View>
      </View>
      {action === "checkmate-finisher" && (
        <Text style={[styles.muted, { fontSize: 12 }]}>
          Squares are dynamic in-game — the piece dances from its live square to the enemy king. This
          preview just samples a left and right box to show the {movementDirectionLabel[mateDirection].toLowerCase()} path.
        </Text>
      )}
      <AnimationBoardPreview
        action={action}
        boardSize={livePreviewBoardSize}
        boardAsset={selectedPieceSet.boardAssets?.[boardColor]?.[selectedPiece]}
        clips={clips}
        color={boardColor}
        mateDirection={action === "checkmate-finisher" ? mateDirection : undefined}
        pieceAsset={selectedPieceSet.pieces[selectedPiece]}
        piece={selectedPiece}
        selectedFromSquare={timeline[selectedTimelineIndex]?.from}
        selectedToSquare={timeline[selectedTimelineIndex]?.to}
        tick={previewTick}
        timeline={timeline}
      />
    </View>
  ) : null;

  return (
    <Panel title="Piece Sets + Animation Studio">
      <View style={styles.animationStudioHero}>
        <View style={styles.animationStudioHeroCopy}>
          <Text style={styles.animationStudioTitle}>Piece Sets and Animation Sets</Text>
      <Text style={styles.animationStudioCopy}>Piece Sets are SVG board art. Animation Sets hold GLB clips, turns, exact durations, and board movement.</Text>
        </View>
        <StudioButton accent disabled={!selectedPieceSet} onPress={() => selectedPieceSet && void activateForPlay(selectedPieceSet.id, selectedAnimationSet?.id)}>
          Activate Selected
        </StudioButton>
      </View>

      <View style={styles.adminTabBar}>
        {[
          ["pieces", "Piece Sets"],
          ["animations", "Animation Sets"],
          ["ceremony", "Ceremony Director"],
          ["releases", "Character Releases"],
        ].map(([value, label]) => (
          <Pressable key={value} onPress={() => setTab(value as typeof tab)} style={({ pressed }) => [styles.actionPill, tab === value && styles.actionPillActive, { flex: 1 }, pressed && styles.pressed]}>
            <Text style={[styles.actionPillText, tab === value && styles.actionPillTextActive, { textAlign: "center" }]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === "pieces" && (
        <View style={styles.adminTabContent}>
          <View style={styles.animationStudioInlineForm}>
            <TextInput value={newPieceSetName} onChangeText={setNewPieceSetName} placeholder="Piece set name" placeholderTextColor="#8aa0b6" style={styles.animationStudioInput} />
            <StudioButton accent onPress={() => void createPieceSet()}>Create Piece Set</StudioButton>
            {selectedPieceSet && !selectedPieceSet.isDefault && (
              <StudioButton onPress={() => void makeSelectedPieceSetDefault()}>Make default</StudioButton>
            )}
            {selectedPieceSet && (
              <StudioButton onPress={() => void deleteSelectedPieceSet()}>Delete piece set</StudioButton>
            )}
          </View>
          {editablePieceSets.length === 0 ? (
            <View style={styles.animationStudioEmptyState}>
              <Text style={styles.animationStudioSubTitle}>No piece sets yet</Text>
              <Text style={styles.muted}>Create a Piece Set, then upload transparent board images for each white and black piece.</Text>
            </View>
          ) : (
            <View style={styles.pieceSetCardGrid}>
              {editablePieceSets.map((pieceSet) => (
                <Pressable key={pieceSet.id} onPress={() => setSelectedPieceSetId(pieceSet.id)} style={({ pressed }) => [styles.pieceSetCard, selectedPieceSet?.id === pieceSet.id && styles.pieceSetCardActive, pressed && styles.pressed]}>
                  <Text style={styles.pieceSetCardTitle}>{pieceSet.name}{pieceSet.isDefault ? "  ·  default" : ""}</Text>
                  <Text numberOfLines={2} style={styles.muted}>{pieceSet.description}</Text>
                  <View style={styles.pieceSetRosterStrip}>
                    {pieceOrder.map((piece) => {
                      const wAsset = pieceSet.boardAssets?.w?.[piece];
                      const bAsset = pieceSet.boardAssets?.b?.[piece];
                      const wValid = wAsset && (wAsset.kind === "svg" || wAsset.kind === "image");
                      const bValid = bAsset && (bAsset.kind === "svg" || bAsset.kind === "image");
                      return (
                        <View key={piece} style={[styles.pieceRosterPip, !(wValid || bValid) && styles.pieceRosterPipMissing]}>
                          <Text style={styles.pieceRosterPipText}>{pieceGlyphs[piece]}</Text>
                        </View>
                      );
                    })}
                  </View>
                  <StatLine label="Board pieces" value={`${boardPieceCount(pieceSet)}/12`} />
                  <StatLine label="Animation sets" value={String((data.animationSets ?? []).filter((set: AnimationSet) => set.pieceSetId === pieceSet.id).length)} />
                </Pressable>
              ))}
            </View>
          )}

          {selectedPieceSet && (
            <View style={{ gap: 12 }}>
              <CollapsibleSection
                description="Upload static board pieces here. Piece Sets accept SVG only. GLB files belong in Animation Sets."
                icon={FileUp}
                onToggle={() => setPieceDetailOpen((s) => ({ ...s, boardUpload: !s.boardUpload }))}
                open={pieceDetailOpen.boardUpload}
                summary={`${boardPieceCount(selectedPieceSet)}/12 board pieces uploaded`}
                title="Board Piece Upload"
              >
                <View style={styles.pieceRosterGrid}>
                  {pieceOrder.map((piece) => (
                    <Pressable key={piece} onPress={() => setSelectedPiece(piece)} style={({ pressed }) => [styles.pieceRosterCard, selectedPiece === piece && styles.pieceRosterCardActive, pressed && styles.pressed]}>
                      <View style={styles.pieceRosterPreview}>
                        <BoardAssetPreview asset={selectedPieceSet.boardAssets?.[boardColor]?.[piece]} piece={piece} />
                      </View>
                      <Text style={styles.muted}>
                        {(() => {
                          const asset = selectedPieceSet.boardAssets?.[boardColor]?.[piece];
                          if (asset?.kind === "svg") return "SVG uploaded";
                          if (asset?.kind === "image") return "Image uploaded";
                          if (asset) return "Uploaded";
                          return "Missing";
                        })()}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.speedSegment}>
                  {(["w", "b"] as const).map((color) => (
                    <Pressable key={color} onPress={() => setBoardColor(color)} style={[styles.speedOption, boardColor === color && styles.speedOptionActive]}>
                      <Text style={[styles.speedOptionText, boardColor === color && styles.speedOptionTextActive]}>{color === "w" ? "White" : "Black"}</Text>
                    </Pressable>
                  ))}
                </View>
                <StudioButton accent onPress={() => void uploadBoardPiece()}>Upload SVG for {boardColor === "w" ? "White" : "Black"} {pieceNames[selectedPiece]}</StudioButton>
              </CollapsibleSection>
              {/* Sound Pack: per-event audio files associated with this piece set.
                  When the player has this piece set active, these files play
                  instead of the built-in synthesized sounds. */}
              <CollapsibleSection
                description="Audio files that play during gameplay when this piece set is active. Leave any event empty to use the built-in wooden synth sound."
                icon={Music}
                onToggle={() => setPieceDetailOpen((s) => ({ ...s, soundPack: !s.soundPack }))}
                open={pieceDetailOpen.soundPack}
                summary={`${SOUND_EVENT_DEFS.filter((row) => selectedPieceSet?.sounds?.[row.event]).length}/${SOUND_EVENT_DEFS.length} events configured`}
                title="Sound Pack"
              >
                <View style={{ gap: 10 }}>
                  {SOUND_EVENT_DEFS.map((row) => {
                    const asset = selectedPieceSet?.sounds?.[row.event];
                    const isConfigured = Boolean(asset);
                    return (
                      <View
                        key={row.event}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 12,
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                          backgroundColor: isConfigured ? "rgba(34, 197, 94, 0.06)" : "rgba(148, 163, 184, 0.08)",
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: isConfigured ? "rgba(34, 197, 94, 0.3)" : "rgba(148, 163, 184, 0.2)",
                        }}
                      >
                        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.6)", alignItems: "center", justifyContent: "center" }}>
                          <Text style={{ fontSize: 18 }}>{row.icon}</Text>
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={{ fontWeight: "700", fontSize: 14 }}>{row.label}</Text>
                          <Text style={[styles.muted, { fontSize: 12 }]} numberOfLines={1}>
                            {asset?.fileName ?? "— using built-in synth sound"}
                          </Text>
                        </View>
                        <View style={{ flexDirection: "row", gap: 6 }}>
                          {isConfigured && <StudioButton onPress={() => previewSoundForEvent(row.event)}>▶</StudioButton>}
                          <StudioButton accent onPress={() => void uploadSoundForEvent(row.event)}>
                            {isConfigured ? "Replace" : "Upload"}
                          </StudioButton>
                          {isConfigured && <StudioButton onPress={() => void clearSoundForEvent(row.event)}>Clear</StudioButton>}
                        </View>
                      </View>
                    );
                  })}
                </View>
              </CollapsibleSection>
            </View>
          )}
        </View>
      )}

      {tab === "animations" && (
        <View style={styles.adminTabContent}>
          {!selectedPieceSet ? (
            <Text style={styles.muted}>Create a Piece Set first.</Text>
          ) : (
            <>
              <View style={styles.animationStudioSectionHeader}>
                <View>
                  <Text style={styles.animationStudioSubTitle}>Animation Sets for {selectedPieceSet.name}</Text>
                  <Text style={styles.muted}>Upload GLBs here, list clips, add Turn steps, preview on the board, and save the timeline.</Text>
                </View>
                <StudioButton accent onPress={() => void createAnimationSet()}>New Animation Set</StudioButton>
              </View>
              <View style={styles.animationSetCardGrid}>
                {animationSets.map((animationSet: AnimationSet) => (
                  <Pressable key={animationSet.id} onPress={() => setSelectedAnimationSetId(animationSet.id)} style={({ pressed }) => [styles.animationSetCard, selectedAnimationSet?.id === animationSet.id && styles.animationSetCardActive, pressed && styles.pressed]}>
                    <Text style={styles.pieceSetCardTitle}>{animationSet.name}</Text>
                    <Text numberOfLines={2} style={styles.muted}>{animationSet.description}</Text>
                    <StatLine label="Rules" value={String(animationSet.rules.length)} />
                  </Pressable>
                ))}
              </View>

              <View style={{ gap: 14 }}>
                <View style={styles.animationBuilderPanel}>
                  <Text style={styles.animationStudioSubTitle}>Animation GLB Upload</Text>
                  <View style={styles.pieceRosterGrid}>
                    {pieceOrder.map((piece) => (
                      <Pressable key={piece} onPress={() => setSelectedPiece(piece)} style={({ pressed }) => [styles.pieceRosterCard, selectedPiece === piece && styles.pieceRosterCardActive, pressed && styles.pressed]}>
                        <View style={styles.pieceRosterPreview}><GlbAssetPreview asset={selectedPieceSet.pieces[piece]} piece={piece} /></View>
                        <Text style={styles.pieceRosterName}>{pieceNames[piece]}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.assetSlotGrid}>
                    {animationSlots.map((slot) => (
                      <Pressable key={slot.key} onPress={() => setAnimationSlot(slot.key)} style={({ pressed }) => [styles.assetSlotCard, animationSlot === slot.key && styles.assetSlotCardActive, pressed && styles.pressed]}>
                        <Text style={[styles.assetSlotTitle, animationSlot === slot.key && styles.assetSlotTitleActive]}>{slot.label}</Text>
                        <Text numberOfLines={2} style={styles.assetSlotDescription}>{slot.description}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <StudioButton accent onPress={() => void uploadAnimationGlb()}>Upload {pieceNames[selectedPiece]} GLB</StudioButton>
                </View>

                {createElement(
                  "div",
                  {
                    style: {
                      alignItems: "flex-start",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 14,
                      width: "100%",
                    },
                  },
                  createElement(
                    "div",
                    {
                      ref: bindLivePreviewAnchor,
                      style: {
                        flex: "2 1 640px",
                        maxWidth: "100%",
                        minWidth: 360,
                      },
                    },
                    livePreviewPanel,
                  ),
                  createElement(
                    "div",
                    {
                      style: {
                        flex: "1 1 320px",
                        maxWidth: "100%",
                        minWidth: 320,
                      },
                    },
                    <View style={styles.animationBuilderPanel}>
                <View style={styles.animationStudioSectionHeader}>
                  <View>
                    <Text style={styles.animationStudioSubTitle}>Timeline</Text>
                    <Text style={styles.muted}>Add GLB clips or Turn steps, set exact seconds, drag bars horizontally, then save the current action.</Text>
                  </View>
                  <Pressable onPress={openAddAnimation} style={({ pressed }) => [styles.animationAddButton, pressed && styles.pressed]}>
                    <View style={styles.animationAddButtonIcon}>
                      <Text style={styles.animationAddButtonIconText}>+</Text>
                    </View>
                    <Text style={styles.animationAddButtonText}>Add animation</Text>
                  </Pressable>
                </View>
                <View style={styles.actionPillWrap}>
                  {actions.map((item) => (
                    <Pressable key={item.id} onPress={() => setAction(item.id)} style={({ pressed }) => [styles.actionPill, action === item.id && styles.actionPillActive, pressed && styles.pressed]}>
                      <Text style={[styles.actionPillText, action === item.id && styles.actionPillTextActive]}>{item.label}</Text>
                    </Pressable>
                  ))}
                </View>
                {action === "checkmate-finisher" && (
                  <View style={{ backgroundColor: "rgba(37,99,235,0.05)", borderColor: "rgba(37,99,235,0.18)", borderRadius: 14, borderWidth: 1, gap: 10, padding: 12 }}>
                    <Text style={[styles.muted, { fontWeight: "700" }]}>
                      Mating-move direction — classified by the file the piece moves toward (a…h).
                    </Text>
                    <Text style={styles.muted}>
                      Author each lane, or fill just one and the rest reuse it automatically — the opposite side is mirrored (⇄). The lane you edit below is the highlighted one.
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                      {movementDirections.map((d) => {
                        const st = mateDirectionStatus[d];
                        const activeDir = mateDirection === d;
                        return (
                          <Pressable
                            key={d}
                            onPress={() => selectMateDirection(d)}
                            style={({ pressed }) => [
                              styles.actionPill,
                              { alignItems: "flex-start", flexDirection: "column", gap: 2, minWidth: 132 },
                              activeDir && styles.actionPillActive,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Text style={[styles.actionPillText, { fontWeight: "800" }, activeDir && styles.actionPillTextActive]}>{movementDirectionLabel[d]}</Text>
                            <Text style={[styles.actionPillText, { fontSize: 11, opacity: 0.85 }, activeDir && styles.actionPillTextActive, st.authored && { color: "#15803d" }]}>
                              {st.authored ? "● Custom" : st.reuse}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <View style={{ borderTopColor: "rgba(37,99,235,0.18)", borderTopWidth: 1, gap: 8, marginTop: 4, paddingTop: 10 }}>
                      <Text style={[styles.muted, { fontWeight: "700" }]}>Opponent king's sad move</Text>
                      <Text style={styles.muted}>{loserReactionDescription[loserReaction]}</Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {loserReactions.map((reaction) => {
                          const activeReaction = loserReaction === reaction;
                          return (
                            <Pressable
                              key={reaction}
                              onPress={() => setLoserReaction(reaction)}
                              style={({ pressed }) => [styles.actionPill, activeReaction && styles.actionPillActive, pressed && styles.pressed]}
                            >
                              <Text style={[styles.actionPillText, { fontWeight: "800" }, activeReaction && styles.actionPillTextActive]}>{loserReactionLabel[reaction]}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                )}
                <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
                  <View style={[styles.speedSegment, { flex: 1, minWidth: 240 }]}>
                    {(["both", "w", "b"] as const).map((color) => (
                      <Pressable key={color} onPress={() => setAnimationColor(color)} style={[styles.speedOption, animationColor === color && styles.speedOptionActive]}>
                        <Text style={[styles.speedOptionText, animationColor === color && styles.speedOptionTextActive]}>{color === "both" ? "Both" : color === "w" ? "White" : "Black"}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                    <StudioButton accent onPress={() => void saveAnimationRule()}>Save</StudioButton>
                  </View>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator style={{ minHeight: Math.min(820, timelineStripHeight + 16) }} contentContainerStyle={{ paddingBottom: 6, paddingTop: 4 }}>
                  {timeline.length === 0 ? (
                    <View style={[styles.clipCard, { minWidth: 320 }]}>
                      <View style={styles.clipCopy}>
                        <Text style={styles.clipTitle}>No animation steps yet</Text>
                        <Text style={styles.muted}>Use Add animation to build this rule.</Text>
                      </View>
                    </View>
                  ) : (
                    <View style={{ backgroundColor: "rgba(241, 246, 252, 0.88)", borderColor: "#dbe7f2", borderRadius: 18, borderWidth: 1, height: timelineStripHeight, overflow: "hidden", position: "relative", width: timelineStripWidth }}>
                      <View style={{ backgroundColor: "#2563eb", bottom: 8, left: timelinePlayheadLeft, position: "absolute", top: 8, width: 3, zIndex: 5 }} />
                      {timeline.map((item, index) => {
                          const duration = timelineItemDurationMs(item, clips);
                          const startMs = timelineItemStartMs(timeline, index, clips);
                          const left = Math.round((startMs / timelineDurationMs) * timelineStripWidth);
                          const width = Math.max(200, Math.round((duration / timelineDurationMs) * timelineStripWidth));
                          const top = 16 + index * timelineLaneHeight;
                          const isDragging = draggingTimelineBar?.index === index;
                          const mergedCount = timeline.filter((other, otherIndex) => {
                            if (otherIndex === index) return false;
                            const otherStart = timelineItemStartMs(timeline, otherIndex, clips);
                            const otherEnd = otherStart + timelineItemDurationMs(other, clips);
                            return startMs < otherEnd && startMs + duration > otherStart;
                          }).length;
                          return (
                            <View
                              key={item.id}
                              style={{
                                backgroundColor: selectedTimelineIndex === index ? "#f3fbfe" : "#ffffff",
                                borderColor: selectedTimelineIndex === index ? "#42a9c1" : "#d7e3ee",
                                borderRadius: 14,
                                borderWidth: 2,
                                height: 124,
                                left,
                                padding: 14,
                                position: "absolute",
                                top,
                                width,
                                zIndex: isDragging ? 8 : selectedTimelineIndex === index ? 3 : 1,
                              }}
                            >
                              {/* Click/drag the upper area to select + move; the name + the move it plays for. */}
                              <Pressable
                                onPress={() => setSelectedTimelineIndex(index)}
                                {...({ onPointerDown: (event: any) => beginTimelineBarDrag(index, event) } as any)}
                                style={{ flex: 1, minWidth: 0 }}
                              >
                                <Text numberOfLines={1} style={[styles.clipTitle, { fontSize: 14.5 }]}>{timelineItemLabel(item, clips)}</Text>
                                <Text numberOfLines={1} style={{ color: "#2563eb", fontSize: 16, fontWeight: "900", marginTop: 6 }}>{item.from ?? "?"} → {item.to ?? "?"}</Text>
                              </Pressable>
                              {/* Footer: duration + the two actions (edit / delete). */}
                              <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "space-between" }}>
                                <Text numberOfLines={1} style={[styles.muted, { flexShrink: 1 }]}>{formatDurationSeconds(duration)}s{mergedCount ? ` · merged ×${mergedCount + 1}` : ""}</Text>
                                <View style={{ flexDirection: "row", gap: 6 }}>
                                  <Pressable onPress={() => openEditAnimation(index)} style={styles.stackButton}><Text style={styles.stackButtonText}>✎</Text></Pressable>
                                  <Pressable onPress={() => setTimeline((current) => current.filter((entry) => entry.id !== item.id))} style={styles.stackButton}><Text style={styles.stackButtonText}>×</Text></Pressable>
                                </View>
                              </View>
                              {/* Drag-to-resize grips (plain Views so web pointer events fire) — drag to change duration. */}
                              <View
                                {...({ onPointerDown: (event: any) => beginTimelineResize(index, "start", event) } as any)}
                                style={{ backgroundColor: "#9bc0f5", borderRadius: 5, cursor: "ew-resize", height: 44, left: -5, marginTop: -22, position: "absolute", top: "50%", width: 9 } as any}
                              />
                              <View
                                {...({ onPointerDown: (event: any) => beginTimelineResize(index, "end", event) } as any)}
                                style={{ backgroundColor: "#9bc0f5", borderRadius: 5, cursor: "ew-resize", height: 44, marginTop: -22, position: "absolute", right: -5, top: "50%", width: 9 } as any}
                              />
                            </View>
                          );
                        })}
                    </View>
                  )}
                </ScrollView>
              </View>,
                  ),
                )}
              </View>
              {timelineEditor &&
                renderBodyPortal(createElement(
                  "div",
                  {
                    style: {
                      alignItems: "center",
                      backdropFilter: "blur(8px)",
                      backgroundColor: "rgba(10, 20, 35, 0.34)",
                      bottom: 0,
                      display: "flex",
                      justifyContent: "center",
                      left: 0,
                      overflow: "hidden",
                      padding: 24,
                      position: "fixed",
                      right: 0,
                      top: 0,
                      zIndex: 2500,
                    },
                  },
                  <View style={[styles.animationBuilderPanel, { alignSelf: "center", flex: 0, maxHeight: "calc(100vh - 48px)" as any, maxWidth: 620, overflow: "hidden" as any, paddingTop: 26, position: "relative", width: "min(620px, calc(100vw - 48px))" as any }]}>
                    <Pressable
                      accessibilityLabel="Close animation editor"
                      onPress={() => setTimelineEditor(null)}
                      style={[
                        styles.stackButton,
                        {
                          borderRadius: 16,
                          height: 44,
                          position: "absolute",
                          right: 18,
                          top: 18,
                          width: 44,
                          zIndex: 2,
                        },
                      ]}
                    >
                      <Text style={styles.stackButtonText}>×</Text>
                    </Pressable>
                    <View style={{ gap: 4, paddingRight: 58 }}>
                      <Text style={styles.animationStudioSubTitle}>{timelineEditor.mode === "add" ? "Add animation" : "Edit animation"}</Text>
                      <Text numberOfLines={2} style={styles.muted}>Choose a clip or configure a Turn step. Preview updates after save.</Text>
                    </View>
                    <View style={styles.speedSegment}>
                      {(["clip", "turn"] as const).map((kind) => (
                        <Pressable
                          key={kind}
                          onPress={() =>
                            setTimelineEditor((current) =>
                              current
                                ? {
                                    ...current,
                                    draft: kind === "clip"
                                      ? { ...defaultTimelineDraft(compatibleClips, selectedPiece), from: current.draft.from, startsAtMs: current.draft.startsAtMs, to: current.draft.to }
                                      : { degrees: 180, degreesX: 0, degreesY: 180, degreesZ: 0, durationMs: current.draft.durationMs || 700, from: current.draft.from, kind: "turn", startsAtMs: current.draft.startsAtMs, to: current.draft.to },
                                  }
                                : current,
                            )
                          }
                          style={[styles.speedOption, timelineEditor.draft.kind === kind && styles.speedOptionActive]}
                        >
                          <Text style={[styles.speedOptionText, timelineEditor.draft.kind === kind && styles.speedOptionTextActive]}>{kind === "clip" ? "GLB Clip" : "Turn"}</Text>
                        </Pressable>
                      ))}
                    </View>
                    {timelineEditor.draft.kind === "clip" ? (
                      <View style={{ gap: 10 }}>
                        <Text style={styles.muted}>Animation clip</Text>
                        {compatibleClips.length === 0 ? (
                          <Text style={styles.muted}>Upload a {pieceNames[selectedPiece]} GLB first.</Text>
                        ) : (
                          createElement(
                            "select",
                            {
                              onChange: (event: any) =>
                                setTimelineEditor((current) => {
                                  if (!current || current.draft.kind !== "clip") return current;
                                  const nextClipId = event.target.value;
                                  const nextClip = compatibleClips.find((clip) => clip.id === nextClipId);
                                  return { ...current, draft: { ...current.draft, clipId: nextClipId, durationMs: nextClip?.durationMs ?? current.draft.durationMs } };
                                }),
                              style: {
                                backgroundColor: "#ffffff",
                                border: "1px solid #dbe7f2",
                                borderRadius: 16,
                                color: "#20242a",
                                font: "inherit",
                                fontWeight: 800,
                                minHeight: 52,
                                outline: "none",
                                padding: "0 16px",
                                width: "100%",
                              },
                              value: timelineEditor.draft.clipId,
                            },
                            compatibleClips.map((clip) =>
                              createElement(
                                "option",
                                { key: clip.id, value: clip.id },
                                `${clip.name} · ${Math.round(clip.durationMs / 100) / 10}s`,
                              ),
                            ),
                          )
                        )}
                      </View>
                    ) : (
                      <View style={{ gap: 10 }}>
                        {[
                          ["X", "degreesX"],
                          ["Y", "degreesY"],
                          ["Z", "degreesZ"],
                        ].map(([label, key]) => (
                          <View key={key}>
                            <Text style={[styles.muted, { marginBottom: 4 }]}>{label}</Text>
                            <TextInput
                              keyboardType="numeric"
                              onChangeText={(text) => {
                                const val = Number(text.replace(/[^0-9.-]/g, "")) || 0;
                                setTimelineEditor((current) => {
                                  if (!current || current.draft.kind !== "turn") return current;
                                  const next = { ...current.draft, [key]: val };
                                  return { ...current, draft: { ...next, degrees: next.degreesZ || next.degrees } };
                                });
                              }}
                              placeholder="0"
                              placeholderTextColor="#8aa0b6"
                              style={styles.animationStudioInput}
                              value={String((timelineEditor.draft as Extract<TimelineEditorDraft, { kind: "turn" }>)[key as keyof Extract<TimelineEditorDraft, { kind: "turn" }>] ?? "")}
                            />
                          </View>
                        ))}
                      </View>
                    )}
                    {action === "checkmate-finisher" && (
                      <Text style={[styles.muted, { fontSize: 12 }]}>
                        No start/end squares here — a checkmate finisher always travels from the piece's
                        live square to the enemy king, decided by the game position.
                      </Text>
                    )}
                    <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                      {(action === "checkmate-finisher"
                        ? ([
                            ["Starts at (seconds)", "startsAtMs"],
                            ["Duration (seconds)", "durationMs"],
                          ] as const)
                        : ([
                            ["Starts at (seconds)", "startsAtMs"],
                            ["Start square", "from"],
                            ["End square", "to"],
                            ["Duration (seconds)", "durationMs"],
                          ] as const)
                      ).map(([label, key]) => (
                        <View key={key} style={{ flex: 1, minWidth: 150 }}>
                          <Text style={[styles.muted, { marginBottom: 4 }]}>{label}</Text>
                          <TextInput
                            autoCapitalize="none"
                            keyboardType={key === "durationMs" || key === "startsAtMs" ? "decimal-pad" : "default"}
                            onChangeText={(text) =>
                              setTimelineEditor((current) => {
                                if (!current) return current;
                                if (key === "durationMs") {
                                  return { ...current, draft: { ...current.draft, durationMs: secondsInputToDurationMs(text, current.draft.durationMs) } };
                                }
                                if (key === "startsAtMs") {
                                  return { ...current, draft: { ...current.draft, startsAtMs: secondsInputToStartMs(text, current.draft.startsAtMs) } };
                                }
                                return { ...current, draft: { ...current.draft, [key]: text } };
                              })
                            }
                            placeholder={key === "durationMs" || key === "startsAtMs" ? "1.2" : "e4"}
                            placeholderTextColor="#8aa0b6"
                            style={styles.animationStudioInput}
                            value={key === "durationMs" || key === "startsAtMs" ? formatDurationSeconds(timelineEditor.draft[key]) : String(timelineEditor.draft[key as keyof TimelineEditorDraft] ?? "")}
                          />
                        </View>
                      ))}
                    </View>
                    <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
                      <StudioButton onPress={() => setTimelineEditor(null)}>Cancel</StudioButton>
                      <StudioButton accent onPress={saveTimelineEditor}>Save</StudioButton>
                    </View>
                  </View>,
                ))}
            </>
          )}
        </View>
      )}

      {tab === "ceremony" && (
        <View style={styles.adminTabContent}>
          {/* The Ceremony Director owns the cinematic opening/checkmate config on the selected
              animation set. It gets the studio's current selection as its starting point and
              threads the shared feedback banner rendered at the bottom of this Panel. */}
          <CeremonyDirectorAdmin
            animationSetId={selectedAnimationSet?.id ?? ""}
            data={data}
            pieceSetId={selectedPieceSet?.id ?? ""}
            reload={reload}
            services={services}
            setFeedback={setFeedback}
            setSettings={setSettings}
            settings={settings}
          />
        </View>
      )}

      {tab === "releases" && (
        <View style={{ gap: 16 }}>
          <OgPackAdmin />
          <CharacterReleasesAdmin services={services} pieceSets={pieceSets} />
        </View>
      )}

      {feedback && <Text style={[styles.saveFeedback, feedback.tone === "error" && styles.saveFeedbackError, feedback.tone === "saving" && styles.saveFeedbackSaving]}>{feedback.text}</Text>}
    </Panel>
  );
}
