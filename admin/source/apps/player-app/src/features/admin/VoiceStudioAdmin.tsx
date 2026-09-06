// VOICE STUDIO — the admin console for the coach + learn voice pipeline.
//
// One screen that (1) lists EVERY spoken line the product owns — the live-coach pools
// (coachVoiceWorksheet, 651), the coach phrase catalog (coachPhraseWorksheet spoken rows, 180) and the
// academy lesson utterances (lessonUtterances × language) — in English and Tamil side by side;
// (2) renders any line with an explicit Gemini TTS model/voice/style through the admin-gated
// /voice-studio/render endpoint (keys live SERVER-side; this screen only ever sees masked tails);
// (3) previews templated lines by picking placeholder values from their closed domains (squares,
// piece words, files, sides, feels) and stitching placeholder clips + shell clips into ONE seamless
// WAV with the same assembler the runtime uses (assembleStitchWav) — what you hear here is what a
// player would hear; and (4) PUBLISHES clips: bytes are already durable after render, so publish just
// maps the runtime lookup key (clipKey / fragmentId) to the clip URL in the server manifest that every
// client overlays on its bundled manifests at startup (voiceClipOverlay.ts). Published WHOLE-LINE
// clips reach players immediately via the live manifest tier; published FRAGMENTS wait behind
// COACH_STITCH_ENABLED (owner park, 2026-07-06) — this studio exists to make stitching worth
// re-enabling, not to silently re-enable it.

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import {
  parsePgnGame,
  coachPhraseWorksheet,
  coachTemplateSlots,
  coachVoiceWorksheet,
  decomposeTemplateWithValues,
  preloadCoachLanguage,
  type CoachClipSegment,
} from "@chessalive/chess-core";
import { boardThemes } from "@chessalive/assets";
import { realtimeHttpEndpoint, sessionAuthHeaders } from "@chessalive/services";

// The Academy lesson corpus is ~2.5 MB — it is loaded LAZILY (dynamic import when the "Learn" source
// is opened), NEVER statically, so an admin-only feature can't pull the whole catalog into the bundle.
// (AcademyScreen is lazy for the same reason — see app/RouteContent.tsx.)
import type { AcademyLesson } from "@features/academy/content";
import { lessonUtterances } from "@features/academy/lessonSpeech";
import { COACH_FRAGMENT_CLIPS } from "@gameplay/audio/coachFragmentClipManifest";
import { COACH_FRAGMENT_CLIPS_TA } from "@gameplay/audio/coachFragmentClipManifestTa";
import { FRAGMENT_CLIP_CACHE_VERSION, FRAGMENT_SILENT, fragmentId } from "@gameplay/audio/coachFragmentClips";
import { assembleStitchWav } from "@gameplay/audio/coachStitchAssembler";
import { COACH_VOICE_CLIPS } from "@gameplay/audio/coachVoiceClipManifest";
import { replaySnapshot } from "@gameplay/chessState";
import { clipKey } from "@gameplay/audio/coachVoiceClips";
import {
  installVoiceClipOverlay,
  voiceOverlayCoachUrl,
  voiceOverlayFragmentUrl,
  voiceOverlayLessonUrl,
} from "@gameplay/audio/voiceClipOverlay";
import { aiTeal, appColors, styles } from "@app/shell/theme";
import { AudioLines, KeyRound, Languages, ListFilter, Mic } from "@shared/icons";
import { MiniBoard } from "@shared/MiniBoard";
import { BoardPresentation } from "@features/play/BoardPresentation";
import { CollapsibleSection, Panel } from "@shared/primitives";

// ── TTS knobs ─────────────────────────────────────────────────────────────────────────────────────
// Latest Gemini TTS models first; the server accepts any model id, these are the dropdown options.
const MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-preview-tts",
  "gemini-2.5-flash-preview-tts",
];

// The full Gemini prebuilt-voice roster, alphabetical. Achird (the lesson narrator) is the default
// selection; Alnilam is the canonical coach voice (matches every bundled clip + render-on-miss).
const VOICES: Array<{ name: string; hint: string }> = [
  { name: "Achernar", hint: "soft" },
  { name: "Achird", hint: "friendly — lesson narrator" },
  { name: "Algenib", hint: "gravelly" },
  { name: "Algieba", hint: "smooth" },
  { name: "Alnilam", hint: "firm — coach voice" },
  { name: "Aoede", hint: "breezy" },
  { name: "Autonoe", hint: "bright" },
  { name: "Callirrhoe", hint: "easy-going" },
  { name: "Charon", hint: "informative" },
  { name: "Despina", hint: "smooth" },
  { name: "Enceladus", hint: "breathy" },
  { name: "Erinome", hint: "clear" },
  { name: "Fenrir", hint: "excitable" },
  { name: "Gacrux", hint: "mature" },
  { name: "Iapetus", hint: "clear" },
  { name: "Kore", hint: "firm" },
  { name: "Laomedeia", hint: "upbeat" },
  { name: "Leda", hint: "youthful" },
  { name: "Orus", hint: "firm" },
  { name: "Puck", hint: "upbeat" },
  { name: "Pulcherrima", hint: "forward" },
  { name: "Rasalgethi", hint: "informative" },
  { name: "Sadachbia", hint: "lively" },
  { name: "Sadaltager", hint: "knowledgeable" },
  { name: "Schedar", hint: "even" },
  { name: "Sulafat", hint: "warm" },
  { name: "Umbriel", hint: "easy-going" },
  { name: "Vindemiatrix", hint: "gentle" },
  { name: "Zephyr", hint: "bright" },
  { name: "Zubenelgenubi", hint: "casual" },
];

// ── Speaker settings (Audio Profile + Director's note) ────────────────────────────────────────────
// The structured prompt controls from the reference speaker-settings UI: a free-text Audio Profile
// plus Style / Pace / Accent directives. They COMPOSE into the style prompt sent with every render —
// the textarea below stays the source of truth (and stays hand-editable for one-off tweaks).
const DIRECTOR_STYLES: Array<{ name: string; desc: string }> = [
  { name: "Vocal Smile", desc: 'The "Vocal Smile": The soft palate is raised to keep the tone bright, sunny, and explicitly inviting.' },
  { name: "Newscaster", desc: "Professional, authoritative, clear articulation with standard broadcast cadence." },
  { name: "Whisper", desc: "Intimate, breathy, close-to-mic proximity effect." },
  { name: "Empathetic", desc: "Warm, understanding, soft tone with gentle inflections." },
  { name: "Promo/Hype", desc: "High energy, punchy consonants, elongated vowels on excitement words." },
  { name: "Deadpan", desc: "Flat affect, minimal pitch variation, dry delivery." },
];
const DIRECTOR_PACES: Array<{ name: string; desc: string }> = [
  { name: "Natural", desc: "Natural conversational pace." },
  { name: "Rapid Fire", desc: "Fast, energetic, no dead air. Sentences overlap slightly." },
  { name: "The Drift", desc: "Slow, liquid, zero urgency. Long pauses for breath." },
  { name: "Staccato", desc: "Short, clipped sentences with distinct pauses between words." },
];
const DIRECTOR_ACCENTS = [
  "Neutral",
  "American (Gen)",
  "American (Valley)",
  "American (South)",
  "British (RP)",
  "British (Brixton)",
  "Transatlantic",
  "Australian",
];

function composeSpeakerStyle(profile: string, styleName: string, paceName: string, accent: string): string {
  const s = DIRECTOR_STYLES.find((x) => x.name === styleName) ?? DIRECTOR_STYLES[0];
  const p = DIRECTOR_PACES.find((x) => x.name === paceName) ?? DIRECTOR_PACES[0];
  return [
    `Audio Profile: ${profile.trim() || "A vibrant and theatrical host."}`,
    `Director's note — Style (${s.name}): ${s.desc}`,
    `Pace (${p.name}): ${p.desc}`,
    accent === "Neutral" ? "Accent: neutral, unmarked." : `Accent: ${accent}.`,
    "Speak only the line.",
  ].join("\n");
}

// Default style prompts — MUST match STYLE_BY_LOCALE in apps/realtime-server/src/modules/coachTts.mjs
// so a studio render with untouched knobs is indistinguishable from render-on-miss lines.
const STYLE_DEFAULTS: Record<"en" | "ta", string> = {
  en: "Read this as a seasoned chess coach with a deep, smooth, resonant voice. Firm and grounded, lower-middle pitch, warm and natural with an easy unhurried flow. Confident and human, never soft, never clipped or robotic. Crisp and direct, but let each line breathe. Speak only the line.",
  ta: "Read this as an experienced Tamil chess coach — a native Tamil speaker with a firm, confident, affirmative voice that stays warm and teaching-friendly, the kind of mentor students love coming back to. Encouraging and engaging, never harsh, never robotic or theatrical. Natural modern spoken Tamil at a steady, assured pace. Read the inline English chess terms (knight, checkmate, kingside) smoothly in a natural Indian-English accent; read board coordinates like e4 clearly, one symbol at a time. Speak only the line.",
};

// Fragment prosody directives (mirroring scripts/coach-i18n/finalize-fragment-clips.mjs): a fragment is
// rendered with the persona of the main style prompt plus one of these, so mid-line pieces keep a rising
// "the sentence goes on" contour and final pieces land a natural close.
const MID_DIRECTIVE =
  "This is a MID-SENTENCE fragment that will be spliced into a longer line: keep the pitch UP and flowing at the end — continuing intonation, no final cadence, no trailing pause, as if the sentence keeps going. Speak only the fragment.";
const FINAL_DIRECTIVE =
  "This fragment ENDS the sentence: close it with a natural sentence-final falling cadence. Speak only the fragment.";
function fragmentStyle(style: string, final: boolean): string {
  const persona = style.replace(/\s*Speak only the line\.?\s*$/i, "").trim();
  return `${persona} ${final ? FINAL_DIRECTIVE : MID_DIRECTIVE}`;
}

// ── API helpers ───────────────────────────────────────────────────────────────────────────────────
const api = (path: string) => `${realtimeHttpEndpoint()}${path}`;
/** Root-relative clip paths (/coach-audio/pub/…) live at the API ORIGIN, not under its /api prefix. */
const clipUrl = (path: string) => (/^https?:|^blob:/.test(path) ? path : `${realtimeHttpEndpoint().replace(/\/api$/, "")}${path}`);

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(api(path), {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `${path} failed (${res.status}).`);
  return data;
}
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(api(path), { credentials: "include", headers: { ...sessionAuthHeaders() } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `${path} failed (${res.status}).`);
  return data;
}

type RenderResponse = { url: string; cached: boolean; bytes?: number; textHash: string; variantHash: string };

// ── Playback — ONE admin audio element (desktop web; a click precedes every play) ─────────────────
let adminAudio: HTMLAudioElement | null = null;
function playUrl(url: string, onDone?: () => void): void {
  if (typeof Audio === "undefined") return;
  if (!adminAudio) adminAudio = new Audio();
  const el = adminAudio;
  el.pause();
  el.src = url;
  el.onended = () => onDone?.();
  el.onerror = () => onDone?.();
  void el.play().catch(() => onDone?.());
}
function stopAudio(): void {
  adminAudio?.pause();
}

// ── Languages ─────────────────────────────────────────────────────────────────────────────────────
// Two BUNDLED source languages (instant, from the checked-in packs) plus 20 TRANSLATE targets rendered
// on demand by Gemini (server-side). MUST stay in sync with VOICE_STUDIO_LANGUAGES in
// apps/realtime-server/src/modules/voiceStudio.mjs (the server maps code → name for the prompt).
type LangGroup = "International" | "Indian";
const VOICE_STUDIO_LANGS: Array<{ code: string; name: string; group: LangGroup }> = [
  { code: "es", name: "Spanish", group: "International" },
  { code: "ru", name: "Russian", group: "International" },
  { code: "zh", name: "Mandarin Chinese", group: "International" },
  { code: "de", name: "German", group: "International" },
  { code: "fr", name: "French", group: "International" },
  { code: "pt", name: "Portuguese", group: "International" },
  { code: "ar", name: "Arabic", group: "International" },
  { code: "tr", name: "Turkish", group: "International" },
  { code: "az", name: "Azerbaijani", group: "International" },
  { code: "no", name: "Norwegian", group: "International" },
  { code: "hi", name: "Hindi", group: "Indian" },
  { code: "bn", name: "Bengali", group: "Indian" },
  { code: "ta", name: "Tamil", group: "Indian" },
  { code: "te", name: "Telugu", group: "Indian" },
  { code: "mr", name: "Marathi", group: "Indian" },
  { code: "gu", name: "Gujarati", group: "Indian" },
  { code: "kn", name: "Kannada", group: "Indian" },
  { code: "ml", name: "Malayalam", group: "Indian" },
  { code: "or", name: "Odia", group: "Indian" },
  { code: "pa", name: "Punjabi", group: "Indian" },
];
const LANG_NAME = new Map(VOICE_STUDIO_LANGS.map((l) => [l.code, l.name]));
// The two bundled langs — everything else is a translate target.
const BUNDLED_LANGS = new Set(["en", "ta-tanglish"]);
const isBundledLang = (l: string) => BUNDLED_LANGS.has(l);
/** Which checked-in worksheet locale backs the row set for `lang` (translate langs read the EN source). */
const bundledLocaleOf = (l: string): "en" | "ta" => (l === "ta-tanglish" ? "ta" : "en");

// ── Catalog rows ──────────────────────────────────────────────────────────────────────────────────
type Source = "coach-voice" | "coach-phrase" | "lesson";
type Locale = "en" | "ta";

/** A per-row translation in the active target language. `saved` = it exists in the server cache
 *  (pre-filled or persisted); `dirty` = a hand edit not yet saved back. */
type XlateEntry = { text: string; tokensOk: boolean; saved?: boolean; dirty?: boolean };

type Row = {
  id: string;
  source: Source;
  key: string;
  en: string;
  /** Locale-resolved text — what the runtime actually speaks/displays for this locale. */
  value: string;
  template: boolean;
  /** Distinct placeholder names, in appearance order (templated rows only). */
  slots: string[];
};

const SLOT_KIND = new Map(coachTemplateSlots().map((s) => [s.name, s.kind]));
const slotNames = (text: string): string[] => {
  const out: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
};
/** Stitchable = every placeholder is a closed-domain atom (renderTemplateSegments' rejection rule). */
const isStitchable = (row: Row): boolean => row.template && row.slots.every((s) => SLOT_KIND.get(s) != null);

const SQUARES = "abcdefgh".split("").flatMap((f) => "12345678".split("").map((r) => `${f}${r}`));
const FILES = "abcdefgh".split("");

/** Atom dropdown domains, from the same worksheet the fragment pipeline renders (EN values — fragment
 *  stitching is English-only by contract). */
function atomDomains(): Record<string, string[]> {
  const en = coachVoiceWorksheet("en");
  const byPrefix = (p: string) => en.filter((r) => r.key.startsWith(p)).map((r) => r.en);
  return {
    square: SQUARES,
    piece: [...new Set(byPrefix("piece."))],
    file: FILES,
    side: [...new Set(byPrefix("side."))],
    feel: [...new Set(byPrefix("feel."))],
  };
}
const ATOM_DEFAULTS: Record<string, string> = { square: "e4", piece: "knight", file: "d", side: "kingside", feel: "" };

// ── Clip status lookups (bundled + published overlay) ─────────────────────────────────────────────
// ⚠️ The lesson narration map is ~196 KB of generated data. Importing it STATICALLY here put it in
// two async chunks (this admin screen and the Academy screen), and Metro hoists anything shared by
// 2+ async chunks into the EAGERLY loaded __common — so an admin-only status badge was costing
// every player 178 KB of boot payload. Same rule the header comment already applies to the lesson
// corpus. Loaded on demand instead; until it lands, a bundled-but-unpublished clip reads "none"
// for a moment and then corrects itself (loadLessonNarrationClips bumps a token).
let lessonNarrationClips: Record<string, string> | null = null;
let lessonNarrationClipsLoad: Promise<void> | null = null;
function loadLessonNarrationClips(): Promise<void> {
  if (!lessonNarrationClipsLoad) {
    lessonNarrationClipsLoad = import("@features/academy/lessonNarrationClips")
      .then((module) => {
        lessonNarrationClips = module.LESSON_NARRATION_CLIPS;
      })
      .catch(() => {
        lessonNarrationClips = {};
      });
  }
  return lessonNarrationClipsLoad;
}
type ClipStatus = "published" | "bundled" | "none";
function wholeLineStatusForText(text: string, source: Source): ClipStatus {
  const hash = clipKey(text.trim());
  if (source === "lesson") {
    if (voiceOverlayLessonUrl(hash)) return "published";
    return lessonNarrationClips?.[hash] ? "bundled" : "none";
  }
  if (voiceOverlayCoachUrl(hash)) return "published";
  return COACH_VOICE_CLIPS[hash] ? "bundled" : "none";
}
function fragmentUrlFor(seg: CoachClipSegment, loc: "en" | "ta" = "en"): string | null {
  const id = fragmentId(seg);
  // Overlay is en-only — its fragment map keys by the locale-blind fragmentId, so a published en atom
  // must never stand in for the ta lane's clip of the same id.
  const published = loc === "en" ? voiceOverlayFragmentUrl(id) : null;
  if (published) return published;
  const bundled = (loc === "ta" ? COACH_FRAGMENT_CLIPS_TA : COACH_FRAGMENT_CLIPS)[id];
  return bundled ? `${bundled}?v=${FRAGMENT_CLIP_CACHE_VERSION}` : null;
}

// ── Small UI atoms ────────────────────────────────────────────────────────────────────────────────
const domSelectStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #dbe7f2",
  borderRadius: 12,
  color: "#20242a",
  font: "inherit",
  fontWeight: 700,
  minHeight: 36,
  outline: "none",
  padding: "0 10px",
} as const;

function DomSelect({ onChange, options, value, width }: { onChange: (v: string) => void; options: Array<{ label: string; value: string; disabled?: boolean }>; value: string; width?: number }) {
  return createElement(
    "select",
    { onChange: (e: { target: { value: string } }) => onChange(e.target.value), style: { ...domSelectStyle, width: width ?? "100%" }, value },
    options.map((o, i) => createElement("option", { key: o.value || `_${i}`, value: o.value, disabled: o.disabled }, o.label)),
  );
}

function FieldLabel({ children }: { children: string }) {
  return <Text style={[styles.muted, { fontWeight: "800", marginBottom: 4 }]}>{children}</Text>;
}

/** DOM checkbox (admin is web-only) — supports an indeterminate (some-but-not-all) state. */
function Checkbox({ checked, indeterminate, onChange, title }: { checked: boolean; indeterminate?: boolean; onChange: () => void; title?: string }) {
  return createElement("input", {
    type: "checkbox",
    checked,
    title,
    ref: (el: HTMLInputElement | null) => { if (el) el.indeterminate = Boolean(indeterminate) && !checked; },
    onChange,
    style: { accentColor: "#2563eb", cursor: "pointer", height: 17, width: 17 },
  });
}

function StudioButton({ label, onPress, busy, accent, disabled }: { label: string; onPress: () => void; busy?: boolean; accent?: boolean; disabled?: boolean }) {
  const off = Boolean(busy || disabled);
  return (
    <Pressable
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.actionPill, accent && styles.actionPillActive, (pressed || off) && styles.pressed, { opacity: off ? 0.55 : 1 }]}
    >
      <Text style={[styles.actionPillText, accent && styles.actionPillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function StatusDot({ status }: { status: ClipStatus }) {
  const color = status === "published" ? "#15803d" : status === "bundled" ? "#1d4ed8" : "#94a3b8";
  const label = status === "published" ? "published" : status === "bundled" ? "bundled" : "no clip";
  return (
    <View style={{ alignItems: "center", backgroundColor: `${color}14`, borderRadius: 999, flexDirection: "row", gap: 5, paddingHorizontal: 8, paddingVertical: 3 }}>
      <View style={{ backgroundColor: color, borderRadius: 5, height: 7, width: 7 }} />
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/** A small pill-shaped status badge — the shared visual for row-level chips (TEMPLATE, translation
 *  state, etc.) so every status reads as one consistent "chip" language across the screen. */
function Chip({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ backgroundColor: `${color}14`, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

type Feedback = { tone: "error" | "saved" | "saving"; text: string } | null;

type StudioShort = {
  id: string;
  title: string;
  narration: string;
  pgn: string;
  audioUrl: string;
  orientation: "w" | "b";
  updatedAt?: string;
};

const shortIdFromTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/**
 * Voice Studio's compact Short composer. Narration is rendered through the exact same model/voice/
 * director settings as every other row on this page; the PGN preview advances against the real
 * audio duration, which is also the timing model used by the Learn feed.
 */
function VoiceShortsAdmin({ renderClip }: { renderClip: (text: string, styleOverride?: string) => Promise<RenderResponse> }) {
  const [shorts, setShorts] = useState<StudioShort[]>([]);
  const [id, setId] = useState("");
  const [idManual, setIdManual] = useState(false);
  const [title, setTitle] = useState("");
  const [narration, setNarration] = useState("");
  const [pgn, setPgn] = useState("");
  const [orientation, setOrientation] = useState<"w" | "b">("w");
  const [rendered, setRendered] = useState<{ text: string; url: string } | null>(null);
  const [status, setStatus] = useState<Feedback>(null);
  const [previewPly, setPreviewPly] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const parsed = useMemo(() => {
    if (!pgn.trim()) return { snapshot: null, error: null };
    try {
      return { snapshot: parsePgnGame(pgn).snapshot, error: null };
    } catch (error) {
      return { snapshot: null, error: error instanceof Error ? error.message : "Invalid PGN." };
    }
  }, [pgn]);
  const previewSnapshot = useMemo(
    () => (parsed.snapshot ? replaySnapshot(parsed.snapshot, previewPly) : null),
    [parsed.snapshot, previewPly],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await getJson<{ value?: { shorts?: StudioShort[] } }>("/voice-studio/shorts");
      setShorts(Array.isArray(response.value?.shorts) ? response.value.shorts : []);
    } catch {
      setShorts([]);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => {
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
  }, []);

  const reset = useCallback(() => {
    previewAudioRef.current?.pause();
    setId("");
    setIdManual(false);
    setTitle("");
    setNarration("");
    setPgn("");
    setOrientation("w");
    setRendered(null);
    setPreviewPly(0);
    setPreviewPlaying(false);
    setStatus(null);
  }, []);

  const ensureRendered = useCallback(async () => {
    const text = narration.trim();
    if (!text) throw new Error("Add the narration first.");
    if (rendered?.text === text) return rendered.url;
    setStatus({ tone: "saving", text: "Rendering Short narration…" });
    const result = await renderClip(text);
    setRendered({ text, url: result.url });
    setStatus({ tone: "saved", text: result.cached ? "Narration ready from cache." : "Narration rendered and ready." });
    return result.url;
  }, [narration, renderClip, rendered]);

  const preview = useCallback(async () => {
    if (!parsed.snapshot) {
      setStatus({ tone: "error", text: parsed.error ?? "Add a valid PGN first." });
      return;
    }
    try {
      const url = await ensureRendered();
      if (typeof Audio === "undefined") return;
      previewAudioRef.current?.pause();
      const audio = new Audio(clipUrl(url));
      previewAudioRef.current = audio;
      setPreviewPly(0);
      audio.ontimeupdate = () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        setPreviewPly(Math.min(parsed.snapshot!.history.length, Math.floor((audio.currentTime / audio.duration) * (parsed.snapshot!.history.length + 0.999))));
      };
      audio.onended = () => {
        setPreviewPly(parsed.snapshot!.history.length);
        setPreviewPlaying(false);
      };
      audio.onerror = () => setPreviewPlaying(false);
      await audio.play();
      setPreviewPlaying(true);
    } catch (error) {
      setPreviewPlaying(false);
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not preview the Short." });
    }
  }, [ensureRendered, parsed]);

  const publish = useCallback(async () => {
    if (!parsed.snapshot) {
      setStatus({ tone: "error", text: parsed.error ?? "Add a valid PGN first." });
      return;
    }
    if (!id || id.length < 3) {
      setStatus({ tone: "error", text: "Add a Short id with at least 3 characters." });
      return;
    }
    if (!title.trim()) {
      setStatus({ tone: "error", text: "Add a title first." });
      return;
    }
    try {
      const audioUrl = await ensureRendered();
      setStatus({ tone: "saving", text: "Publishing Chess Short…" });
      await postJson("/voice-studio/shorts", {
        short: {
          id,
          title: title.trim(),
          narration: narration.trim(),
          pgn: pgn.trim(),
          audioUrl,
          orientation,
        },
      });
      await refresh();
      setStatus({ tone: "saved", text: `"${title.trim()}" is live in Learn → Chess Shorts.` });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not publish the Short." });
    }
  }, [ensureRendered, id, narration, orientation, parsed, pgn, refresh, title]);

  const edit = useCallback((item: StudioShort) => {
    previewAudioRef.current?.pause();
    setId(item.id);
    setIdManual(true);
    setTitle(item.title);
    setNarration(item.narration);
    setPgn(item.pgn);
    setOrientation(item.orientation);
    setRendered({ text: item.narration, url: item.audioUrl });
    setPreviewPly(0);
    setPreviewPlaying(false);
    setStatus({ tone: "saved", text: `Editing "${item.title}". Publish to save changes.` });
  }, []);

  const remove = useCallback(async (item: StudioShort) => {
    if (typeof confirm === "function" && !confirm(`Remove "${item.title}" from Chess Shorts?`)) return;
    setStatus({ tone: "saving", text: `Removing "${item.title}"…` });
    try {
      await postJson("/voice-studio/shorts", { action: "remove", id: item.id });
      await refresh();
      if (id === item.id) reset();
      else setStatus({ tone: "saved", text: `"${item.title}" was removed.` });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not remove the Short." });
    }
  }, [id, refresh, reset]);

  return (
    <Panel title="4 · Chess Shorts">
      <Text style={styles.muted}>
        Write the narration, paste a PGN, then preview. The board distributes the PGN moves across the real audio duration and publishes the same synchronized experience to Learn.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 16, marginTop: 12 }}>
        <View style={{ flex: 1, minWidth: 300, gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <View style={{ flex: 1, minWidth: 210 }}>
              <FieldLabel>Short title</FieldLabel>
              <TextInput
                onChangeText={(value) => {
                  setTitle(value);
                  if (!idManual) setId(shortIdFromTitle(value));
                }}
                placeholder="The Greek Gift in 30 seconds"
                placeholderTextColor="#8aa0b6"
                style={styles.animationStudioInput}
                value={title}
              />
            </View>
            <View style={{ width: 190 }}>
              <FieldLabel>Short id</FieldLabel>
              <TextInput
                autoCapitalize="none"
                onChangeText={(value) => { setIdManual(true); setId(shortIdFromTitle(value)); }}
                placeholder="greek-gift"
                placeholderTextColor="#8aa0b6"
                style={styles.animationStudioInput}
                value={id}
              />
            </View>
            <View style={{ width: 120 }}>
              <FieldLabel>Board side</FieldLabel>
              <DomSelect
                onChange={(value) => setOrientation(value === "b" ? "b" : "w")}
                options={[{ label: "White", value: "w" }, { label: "Black", value: "b" }]}
                value={orientation}
                width={120}
              />
            </View>
          </View>
          <View>
            <FieldLabel>Narration / on-screen copy</FieldLabel>
            <TextInput
              multiline
              numberOfLines={5}
              onChangeText={(value) => {
                setNarration(value);
                if (rendered?.text !== value.trim()) setRendered(null);
              }}
              placeholder="Explain the idea exactly as it should be spoken…"
              placeholderTextColor="#8aa0b6"
              style={[styles.animationStudioInput, { minHeight: 112, textAlignVertical: "top" }]}
              value={narration}
            />
          </View>
          <View>
            <FieldLabel>PGN moves</FieldLabel>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              numberOfLines={7}
              onChangeText={(value) => { setPgn(value); setPreviewPly(0); }}
              placeholder={"[White \"White\"]\n[Black \"Black\"]\n\n1. e4 e5 2. Nf3 Nc6 …"}
              placeholderTextColor="#8aa0b6"
              {...({ dataSet: { caMono: "1" } } as object)}
              style={[styles.animationStudioInput, { minHeight: 144, textAlignVertical: "top", fontFamily: "monospace" }]}
              value={pgn}
            />
            {parsed.error ? <Text style={{ color: "#dc2626", fontSize: 12, fontWeight: "700", marginTop: 4 }}>{parsed.error}</Text> : null}
            {parsed.snapshot ? <Text style={[styles.muted, { marginTop: 4 }]}>{parsed.snapshot.history.length} moves ready to synchronize</Text> : null}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 9 }}>
            <StudioButton accent busy={status?.tone === "saving"} disabled={!narration.trim() || !parsed.snapshot} label={previewPlaying ? "Playing preview…" : "▶ Render + preview"} onPress={() => void preview()} />
            <StudioButton accent busy={status?.tone === "saving"} disabled={!title.trim() || !narration.trim() || !parsed.snapshot} label="Publish to Learn" onPress={() => void publish()} />
            <StudioButton label="New Short" onPress={reset} />
            {status ? (
              <Text style={{ flexShrink: 1, color: status.tone === "error" ? "#dc2626" : status.tone === "saved" ? "#15803d" : appColors.aiMuted, fontSize: 12, fontWeight: "700" }}>
                {status.text}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ width: 330, maxWidth: "100%", gap: 8 }}>
          <FieldLabel>Short board preview</FieldLabel>
          {previewSnapshot ? (
            <BoardPresentation theme={boardThemes[0]} treatment="curved" width={320}>
              {(surfaceStyle) => (
                <View style={surfaceStyle}>
                  <MiniBoard frameless orientation={orientation} showCoordinates snapshot={previewSnapshot} theme={boardThemes[0]} />
                </View>
              )}
            </BoardPresentation>
          ) : (
            <View style={{ width: 320, maxWidth: "100%", aspectRatio: 1, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: appColors.subCardBg, borderWidth: 1, borderColor: appColors.aiLine }}>
              <Text style={[styles.muted, { textAlign: "center", padding: 24 }]}>Paste a valid PGN to see the board.</Text>
            </View>
          )}
          <Text style={styles.muted}>
            {previewPly === 0 ? "Starting position" : `Move ${previewPly} of ${parsed.snapshot?.history.length ?? 0}`}
          </Text>
        </View>
      </View>

      <View style={{ gap: 8, marginTop: 16 }}>
        <Text style={[styles.muted, { fontWeight: "900" }]}>LIVE IN LEARN · {shorts.length}</Text>
        {shorts.length === 0 ? (
          <Text style={styles.muted}>No published Shorts yet.</Text>
        ) : shorts.map((item) => (
          <View key={item.id} style={[styles.databaseRowCard, { flexDirection: "row", alignItems: "center", gap: 10 }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: appColors.aiInk, fontSize: 13.5, fontWeight: "900" }}>{item.title}</Text>
              <Text numberOfLines={1} style={styles.muted}>{item.id} · {item.orientation === "w" ? "White" : "Black"} side</Text>
            </View>
            <StudioButton label="Edit" onPress={() => edit(item)} />
            <StudioButton label="Remove" onPress={() => void remove(item)} />
          </View>
        ))}
      </View>
    </Panel>
  );
}

const PAGE = 30;

// The screen's own collapsible sections — Setup, Voice, and Placeholder Library stack on top of
// Voice Lines (which is never collapsed; it's the primary work area). Each is independently
// toggle-able so an operator can, say, tune the voice while keys/library stay tucked away.
type SectionKey = "setup" | "voice" | "library";

// ── The screen ────────────────────────────────────────────────────────────────────────────────────
export function VoiceStudioAdmin() {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; stopAudio(); }, []);

  const [openSection, setOpenSection] = useState<Record<SectionKey, boolean>>({ setup: false, voice: false, library: false });
  const toggleSection = useCallback((key: SectionKey) => setOpenSection((s) => ({ ...s, [key]: !s[key] })), []);
  // First-run affordance: once we know there are NO keys configured anywhere (stored or env), pop
  // Setup open automatically — a fresh install shouldn't force the operator to discover a collapsed
  // section just to find the one control that's actually blocking every render. Fires once.
  const autoOpenedSetup = useRef(false);

  // Keys
  type KeyStatus = { storedCount: number; storedMasked: string[]; envCount: number; activeGroup?: string | null };
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [keysDraft, setKeysDraft] = useState("");
  const [keyGroups, setKeyGroups] = useState<Array<{ name: string; count: number }>>([]);
  const refreshKeys = useCallback(async () => {
    try {
      const status = await getJson<KeyStatus>("/voice-studio/keys");
      if (aliveRef.current) {
        setKeyStatus(status);
        if (!autoOpenedSetup.current && status.storedCount === 0 && status.envCount === 0) {
          autoOpenedSetup.current = true;
          setOpenSection((s) => ({ ...s, setup: true }));
        }
      }
    } catch {
      if (aliveRef.current) setKeyStatus(null);
    }
  }, []);
  useEffect(() => { void refreshKeys(); }, [refreshKeys]);
  useEffect(() => {
    void getJson<{ groups: Array<{ name: string; count: number }> }>("/voice-studio/key-groups")
      .then((res) => { if (aliveRef.current) setKeyGroups(res.groups ?? []); })
      .catch(() => undefined);
  }, []);

  async function activateGroup(name: string) {
    if (!name) return;
    setFeedback({ tone: "saving", text: `Activating ${name}…` });
    try {
      const res = await postJson<{ storedCount: number }>("/voice-studio/keys", { group: name });
      await refreshKeys();
      setFeedback({ tone: "saved", text: `${name} active — ${res.storedCount} key${res.storedCount === 1 ? "" : "s"} in the pool.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Group activation failed." });
    }
  }

  async function saveKeys() {
    setFeedback({ tone: "saving", text: "Saving keys…" });
    try {
      const res = await postJson<{ storedCount: number }>("/voice-studio/keys", { keys: keysDraft });
      setKeysDraft("");
      await refreshKeys();
      setFeedback({ tone: "saved", text: `${res.storedCount} Gemini key${res.storedCount === 1 ? "" : "s"} stored server-side.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Saving keys failed." });
    }
  }

  // TTS knobs
  const [model, setModel] = useState(MODELS[0]);
  const [voice, setVoice] = useState("Achird");
  // Language selector: "en" / "ta-tanglish" are bundled (instant); the 20 codes are translate targets.
  const [lang, setLang] = useState<string>("en");
  const locale: Locale = bundledLocaleOf(lang);
  const isTranslate = !isBundledLang(lang);
  const langName = isTranslate ? LANG_NAME.get(lang) ?? lang : locale === "ta" ? "Tamil" : "English";
  // Speaker settings (Audio Profile + Director's note) — they compose the style prompt below.
  const [audioProfile, setAudioProfile] = useState("A vibrant and theatrical host.");
  const [dirStyle, setDirStyle] = useState("Promo/Hype");
  const [dirPace, setDirPace] = useState("Rapid Fire");
  const [dirAccent, setDirAccent] = useState("American (Gen)");
  const [style, setStyle] = useState(() => composeSpeakerStyle("A vibrant and theatrical host.", "Promo/Hype", "Rapid Fire", "American (Gen)"));
  const speakerMounted = useRef(false);
  useEffect(() => {
    // Recompose on any speaker-setting change (skip mount — the initial state already composed).
    if (!speakerMounted.current) {
      speakerMounted.current = true;
      return;
    }
    setStyle(composeSpeakerStyle(audioProfile, dirStyle, dirPace, dirAccent));
  }, [audioProfile, dirStyle, dirPace, dirAccent]);

  const renderClip = useCallback(
    (text: string, styleOverride?: string) => postJson<RenderResponse>("/voice-studio/render", { text, model, voice, style: styleOverride ?? style }),
    [model, voice, style],
  );

  // Tamil pack — the worksheets resolve `value` to English until the pack is installed.
  const [taReady, setTaReady] = useState(false);
  useEffect(() => {
    if (locale === "ta" && !taReady) {
      void preloadCoachLanguage("ta").then(() => { if (aliveRef.current) setTaReady(true); });
    }
  }, [locale, taReady]);

  // Published-manifest bump — refetch after each publish so status dots flip without a reload.
  const [overlayVersion, setOverlayVersion] = useState(0);
  // Pull the lesson narration map in the background and re-run the status memo once it lands.
  const [lessonClipsVersion, setLessonClipsVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void loadLessonNarrationClips().then(() => {
      if (!cancelled) setLessonClipsVersion((version) => version + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const refreshOverlay = useCallback(async () => {
    try {
      const data = await getJson<{ value?: unknown }>("/voice-studio/manifest");
      installVoiceClipOverlay(data?.value ?? null);
      if (aliveRef.current) setOverlayVersion((v) => v + 1);
    } catch { /* keep the last overlay */ }
  }, []);
  useEffect(() => { void refreshOverlay(); }, [refreshOverlay]);

  // Catalog
  const [source, setSource] = useState<Source>("coach-voice");
  // The Learn lesson corpus (~2.5 MB) is fetched on demand the first time the "Learn" source is
  // selected, so it never loads for the coach flows (or for anyone who never opens this admin tab).
  const [lessons, setLessons] = useState<AcademyLesson[] | null>(null);
  const [lessonsLoading, setLessonsLoading] = useState(false);
  useEffect(() => {
    if (source !== "lesson" || lessons || lessonsLoading) return;
    setLessonsLoading(true);
    void import("@features/academy/content")
      // ALL_LESSONS is populated asynchronously (the prose loads in its own
      // chunk), so wait for ensureLessonsReady before reading the catalog.
      .then((m) => m.ensureLessonsReady().then(() => { if (aliveRef.current) setLessons(m.ALL_LESSONS); }))
      .catch(() => { if (aliveRef.current) setFeedback({ tone: "error", text: "Could not load the lesson catalog." }); })
      .finally(() => { if (aliveRef.current) setLessonsLoading(false); });
  }, [source, lessons, lessonsLoading]);
  const [kidsMode, setKidsMode] = useState(false);
  const [query, setQuery] = useState("");
  const [templateFilter, setTemplateFilter] = useState<"all" | "template" | "static">("all");
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const setRowBusy = useCallback((id: string, text: string | null) => {
    setBusy((b) => {
      const next = { ...b };
      if (text === null) delete next[id];
      else next[id] = text;
      return next;
    });
  }, []);

  // ── Selection (checkboxes) for bulk "apply to selected" ──────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [source, kidsMode]); // row-id namespace changes with these
  const toggleSelected = useCallback((id: string) => {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  // ── Translation (pre-audio) ─────────────────────────────────────────────────────────────────────
  // Translated text per row, for the ACTIVE translate language (keyed by row id). Reset on language
  // change — the server caches by (lang, source hash), so existing translations are pre-filled (below)
  // and re-selecting a language re-fetches cheaply. `saved` = present in the server cache (vs a fresh
  // unsaved edit); `dirty` marks a hand edit not yet persisted.
  const [xlate, setXlate] = useState<Record<string, XlateEntry>>({});
  const bulkXlateAbort = useRef(false);
  useEffect(() => { setXlate({}); }, [lang]);

  /** Translate one row's English source into the active language (or read the server cache). */
  const translateRow = useCallback(async (row: Row): Promise<XlateEntry | null> => {
    const r = await postJson<{ text: string; tokensPreserved: boolean; cached: boolean }>("/voice-studio/translate", { text: row.en, lang });
    const entry: XlateEntry = { text: r.text, tokensOk: r.tokensPreserved !== false, saved: true };
    setXlate((x) => ({ ...x, [row.id]: entry }));
    return entry;
  }, [lang]);

  async function translateRowAction(row: Row) {
    setFeedback(null);
    setRowBusy(row.id, "Translating…");
    try {
      const entry = await translateRow(row);
      setRowBusy(row.id, null);
      if (entry && !entry.tokensOk) {
        setFeedback({ tone: "error", text: `${row.key}: a {placeholder} changed in translation — fix it in the field before rendering.` });
      }
    } catch (error) {
      setRowBusy(row.id, null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Translation failed." });
    }
  }

  /** Persist an admin-edited translation to the server cache (no model call). */
  async function saveTranslation(row: Row) {
    const edited = xlate[row.id]?.text ?? "";
    if (!edited.trim()) return;
    setRowBusy(row.id, "Saving…");
    try {
      const r = await postJson<{ text: string; tokensPreserved: boolean }>("/voice-studio/translate", { text: row.en, lang, override: edited });
      setXlate((x) => ({ ...x, [row.id]: { text: r.text, tokensOk: r.tokensPreserved !== false, saved: true } }));
      setRowBusy(row.id, null);
      setFeedback({ tone: "saved", text: `Saved ${langName} translation for ${row.key}.` });
    } catch (error) {
      setRowBusy(row.id, null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Save failed." });
    }
  }

  const rows = useMemo<Row[]>(() => {
    const loc: Locale = locale === "ta" && taReady ? "ta" : "en";
    if (source === "coach-voice") {
      return coachVoiceWorksheet(loc).map((p) => ({
        id: `cv:${p.key}`,
        source: "coach-voice" as const,
        key: p.key,
        en: p.en,
        value: p.value,
        template: p.template,
        slots: p.template ? slotNames(p.en) : [],
      }));
    }
    if (source === "coach-phrase") {
      return coachPhraseWorksheet(loc)
        .filter((p) => p.spoken && p.en) // voice pipeline: spoken lines only; skip empty sentinels
        .map((p) => ({
          id: `cp:${p.key}`,
          source: "coach-phrase" as const,
          key: p.key,
          en: p.en,
          value: p.value,
          template: p.template,
          slots: p.template ? slotNames(p.en) : [],
        }));
    }
    const utteranceRows: Row[] = [];
    for (const lesson of lessons ?? []) {
      const en = lessonUtterances(lesson, "en", kidsMode);
      const val = loc === "ta" ? lessonUtterances(lesson, "ta", kidsMode) : en;
      (["preText", "exText", "fullText", "recapText"] as const).forEach((part) => {
        if (!en[part] && !val[part]) return;
        const label = { preText: "play·pre", exText: "play·ex", fullText: "play·full", recapText: "recap" }[part];
        utteranceRows.push({
          id: `ls:${lesson.id}:${part}:${kidsMode ? "k" : "s"}`,
          source: "lesson" as const,
          key: `${lesson.id} · ${label}`,
          en: en[part],
          value: val[part],
          template: false,
          slots: [],
        });
      });
    }
    return utteranceRows;
  }, [source, locale, taReady, kidsMode, lessons]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (templateFilter === "template" && !r.template) return false;
      if (templateFilter === "static" && r.template) return false;
      if (q && !r.key.toLowerCase().includes(q) && !r.en.toLowerCase().includes(q) && !r.value.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, query, templateFilter]);
  useEffect(() => { setLimit(PAGE); }, [source, query, templateFilter, lang, kidsMode]);
  const visible = filtered.slice(0, limit);

  // PRE-FILL existing translations: for a translate language, load any translation ALREADY cached
  // server-side for the visible rows (read-only, no model calls) so the operator sees prior work and
  // can go straight to convert-to-audio → publish. Probed once per (row, lang); never clobbers a fresh
  // translate or a hand edit already in state.
  const xlateProbed = useRef<Set<string>>(new Set());
  useEffect(() => { xlateProbed.current = new Set(); }, [lang]);
  const visibleIdsKey = visible.map((r) => r.id).join("|");
  useEffect(() => {
    if (!isTranslate) return;
    const need = visible.filter((r) => !xlateProbed.current.has(r.id));
    if (!need.length) return;
    // NOTE: rows are marked "probed" only once this round-trip actually LANDS (in .then, not here) —
    // marking upfront meant a cancelled run (e.g. "Show more" changing visibleIdsKey mid-flight) left
    // those rows permanently stuck "untranslated": the guard above would then skip them forever even
    // though the fetch that would have filled them never got to run. Since a superset change (paging)
    // only ADDS rows, an unmarked row simply reappears in `need` on the next effect run and gets retried.
    let cancelled = false;
    void postJson<{ translations: Record<string, string> }>("/voice-studio/translations", { lang, texts: need.map((r) => r.en) })
      .then((res) => {
        if (cancelled || !aliveRef.current) return;
        need.forEach((r) => xlateProbed.current.add(r.id));
        const map = res.translations ?? {};
        setXlate((x) => {
          let changed = false;
          const next = { ...x };
          for (const r of need) {
            if (next[r.id] !== undefined) continue; // don't overwrite a fresh translate / hand edit
            const t = map[clipKey(r.en.trim())];
            if (typeof t === "string" && t) { next[r.id] = { text: t, tokensOk: r.slots.every((s) => t.includes(`{${s}}`)), saved: true }; changed = true; }
          }
          return changed ? next : x;
        });
      })
      .catch(() => undefined); // no cache / offline → rows stay unprobed, retried on the next visible-set change
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTranslate, lang, visibleIdsKey]);

  // status per visible row — overlayVersion + xlate are the invalidation tokens (voiceClipOverlay is
  // module state; translated text lives in xlate — both invisible to React's dep tracking otherwise).
  const statuses = useMemo(() => {
    const map = new Map<string, ClipStatus>();
    for (const r of visible) {
      if (r.template) { map.set(r.id, "none"); continue; }
      const text = isTranslate ? xlate[r.id]?.text : r.value;
      map.set(r.id, text ? wholeLineStatusForText(text, r.source) : "none");
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, overlayVersion, lessonClipsVersion, isTranslate, xlate]);

  const domains = useMemo(() => atomDomains(), []);
  // Per-row placeholder selections (dropdowns), keyed by row id.
  const [slotValues, setSlotValues] = useState<Record<string, Record<string, string>>>({});
  const valuesFor = useCallback(
    (row: Row): Record<string, string> => {
      const chosen = slotValues[row.id] ?? {};
      const out: Record<string, string> = {};
      for (const name of row.slots) {
        const kind = SLOT_KIND.get(name);
        if (!kind) continue;
        out[name] = chosen[name] ?? ATOM_DEFAULTS[kind] ?? domains[kind]?.[0] ?? "";
        if (!out[name]) out[name] = domains[kind]?.[0] ?? "";
      }
      return out;
    },
    [slotValues, domains],
  );

  const fillTemplate = (text: string, values: Record<string, string>): string => {
    let out = text;
    for (const [k, v] of Object.entries(values)) out = out.split(`{${k}}`).join(v);
    return out;
  };

  /** The base text for a row in the active language: bundled `value`, or the translated string when a
   *  translate language is active. Empty string when a translate language is active but not yet
   *  translated (callers surface "translate first"). Templated rows still carry their {tokens} here. */
  const baseTextFor = useCallback(
    (row: Row): string => (isTranslate ? xlate[row.id]?.text ?? "" : row.value),
    [isTranslate, xlate],
  );

  /** Style prompt for a render — appends a native-delivery hint when a translate language is active so
   *  the TTS speaks the target language naturally (Gemini also infers language from the text itself). */
  const styleForRender = useCallback(
    (baseStyle: string): string =>
      isTranslate ? `${baseStyle}\nSpeak entirely in ${langName} with a natural, native ${langName} accent; read any inline English or numeric tokens naturally.` : baseStyle,
    [isTranslate, langName],
  );

  // ── Row actions ─────────────────────────────────────────────────────────────────────────────────
  /** The exact text a row will speak: a non-templated line as-is, or the (translated) template FILLED
   *  with the chosen atom values. This is what render-on-miss speaks at runtime — one continuous clip. */
  const spokenTextFor = useCallback(
    (row: Row): string => {
      const base = baseTextFor(row);
      return row.template ? fillTemplate(base, valuesFor(row)) : base;
    },
    [baseTextFor, valuesFor],
  );

  // PREVIEW renders the WHOLE line in ONE Gemini call — natural prosody, no seams. Templated lines are
  // filled first, then rendered whole (NOT stitched from fragment clips): fragment concatenation adds a
  // small gap + a prosody reset at every join, which reads as slow/robotic. The seamless whole-line
  // render is exactly what the coach's render-on-miss voice plays, so what you hear is what ships.
  async function previewRow(row: Row) {
    setFeedback(null);
    try {
      const text = spokenTextFor(row);
      if (isTranslate && !baseTextFor(row)) throw new Error(`Translate this line to ${langName} first.`);
      setRowBusy(row.id, "Rendering…");
      const r = await renderClip(text, styleForRender(style));
      setRowBusy(row.id, "Playing…");
      playUrl(clipUrl(r.url), () => setRowBusy(row.id, null));
    } catch (error) {
      setRowBusy(row.id, null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Preview failed." });
    }
  }

  /** Audition the fragment stitch. For ENGLISH this is the parked runtime path (seams expected — the
   *  natural whole-line Preview is the recommended one). For TAMIL this IS the live runtime path
   *  (owner call 2026-07-28): the ta template decomposes into Tamil shells + English atoms and the
   *  stitch is what a player hears. */
  async function previewStitched(row: Row) {
    setFeedback(null);
    try {
      const loc = bundledLocaleOf(lang);
      const segs = decomposeTemplateWithValues(loc === "ta" ? row.value : row.en, valuesFor(row));
      if (!segs) throw new Error("This template could not be decomposed.");
      const audible = segs.filter((s) => !FRAGMENT_SILENT.test(s.text));
      const urls: string[] = [];
      for (let i = 0; i < audible.length; i += 1) {
        const existing = fragmentUrlFor(audible[i], bundledLocaleOf(lang));
        if (existing) { urls.push(existing); continue; }
        setRowBusy(row.id, `Rendering fragment ${i + 1}/${audible.length}…`);
        const r = await renderClip(audible[i].text.trim(), fragmentStyle(style, audible[i].final));
        urls.push(clipUrl(r.url));
      }
      setRowBusy(row.id, "Stitching…");
      const stitched = urls.length > 1 ? await assembleStitchWav(urls) : urls[0];
      setRowBusy(row.id, "Playing…");
      playUrl(stitched ?? urls[0], () => setRowBusy(row.id, null));
    } catch (error) {
      setRowBusy(row.id, null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Stitched preview failed." });
    }
  }

  async function publishWholeLine(row: Row) {
    setFeedback(null);
    try {
      const base = baseTextFor(row);
      if (isTranslate && !base) throw new Error(`Translate this line to ${langName} first.`);
      setRowBusy(row.id, "Rendering…");
      const r = await renderClip(base, styleForRender(style));
      setRowBusy(row.id, "Publishing…");
      const slot = row.source === "lesson" ? "lessons" : "coach";
      await postJson("/voice-studio/publish", { entries: [{ slot, key: r.textHash, url: r.url }] });
      await refreshOverlay();
      setRowBusy(row.id, null);
      setFeedback({ tone: "saved", text: `Published ${langName} · ${row.key} — the coach plays it when it speaks this exact line.` });
    } catch (error) {
      setRowBusy(row.id, null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Publish failed." });
    }
  }

  /** Render + publish the fixed SHELL fragments of a templated line (atoms come from the placeholder
   *  library below — shared across every template). */
  async function publishShells(row: Row) {
    setFeedback(null);
    try {
      const segs = decomposeTemplateWithValues(row.en, valuesFor(row));
      if (!segs) throw new Error("This template is not stitchable.");
      const shells = segs.filter((s) => s.kind === "shell" && !FRAGMENT_SILENT.test(s.text));
      if (!shells.length) throw new Error("No shell fragments in this template.");
      const entries: Array<{ slot: string; key: string; url: string }> = [];
      for (let i = 0; i < shells.length; i += 1) {
        setRowBusy(row.id, `Rendering shell ${i + 1}/${shells.length}…`);
        const r = await renderClip(shells[i].text.trim(), fragmentStyle(style, shells[i].final));
        entries.push({ slot: "fragments", key: fragmentId(shells[i]), url: r.url });
      }
      setRowBusy(row.id, "Publishing…");
      await postJson("/voice-studio/publish", { entries });
      await refreshOverlay();
      setRowBusy(row.id, null);
      setFeedback({ tone: "saved", text: `Published ${entries.length} shell fragment${entries.length === 1 ? "" : "s"} for ${row.key}.` });
    } catch (error) {
      setRowBusy(row.id, null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Shell publish failed." });
    }
  }

  // ── Bulk "apply to selected" ────────────────────────────────────────────────────────────────────
  // Resolve selection against the FULL filtered set (not just the visible page) so off-page picks apply.
  const selectedRows = () => filtered.filter((r) => selected.has(r.id));

  /** Translate every selected row into the active language (server-cached, resumable, abortable). */
  async function applyTranslateSelected() {
    setFeedback(null);
    bulkXlateAbort.current = false;
    const rowsToDo = selectedRows().filter((r) => !xlate[r.id]);
    if (!rowsToDo.length) { setFeedback({ tone: "saved", text: "All selected lines are already translated." }); return; }
    let done = 0;
    let warned = 0;
    for (const row of rowsToDo) {
      if (bulkXlateAbort.current) break;
      setBulkBusy(`Translating ${done + 1}/${rowsToDo.length} — ${row.key}`);
      try { const e = await translateRow(row); done += 1; if (e && !e.tokensOk) warned += 1; } catch { /* skip */ }
    }
    setBulkBusy(null);
    setFeedback({ tone: warned ? "error" : "saved", text: `Translated ${done}/${rowsToDo.length} to ${langName}${warned ? ` · ${warned} need a placeholder fix` : ""}${bulkXlateAbort.current ? " (stopped)" : ""}.` });
  }

  /** Apply the FULL pipeline to every selected line: (translate if a translate language is active) →
   *  render the whole line → publish. Templated lines can't be whole-line-published (their fills are
   *  infinite), so they're skipped and counted — filter to "Static only" to bulk-publish them. */
  async function applyRenderPublishSelected() {
    setFeedback(null);
    bulkXlateAbort.current = false;
    const all = selectedRows();
    const doable = all.filter((r) => !r.template);
    const skippedTemplates = all.length - doable.length;
    if (!doable.length) { setFeedback({ tone: "error", text: `Nothing to publish — all ${all.length} selected are templated (whole-line publish needs a non-templated line).` }); return; }
    const entries: Array<{ slot: string; key: string; url: string }> = [];
    let done = 0;
    let failed = 0;
    for (const row of doable) {
      if (bulkXlateAbort.current) break;
      try {
        let text = baseTextFor(row);
        if (isTranslate && !text) {
          setBulkBusy(`Translating ${done + 1}/${doable.length} — ${row.key}`);
          const e = await translateRow(row);
          text = e?.text ?? "";
        }
        if (!text) { failed += 1; continue; }
        setBulkBusy(`Rendering ${done + 1}/${doable.length} — ${row.key}`);
        const r = await renderClip(text, styleForRender(style));
        entries.push({ slot: row.source === "lesson" ? "lessons" : "coach", key: r.textHash, url: r.url });
        done += 1;
      } catch { failed += 1; }
    }
    if (entries.length) {
      setBulkBusy(`Publishing ${entries.length}…`);
      try { await postJson("/voice-studio/publish", { entries }); await refreshOverlay(); }
      catch (error) { setBulkBusy(null); setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Publish failed." }); return; }
    }
    setBulkBusy(null);
    setFeedback({
      tone: failed ? "error" : "saved",
      text: `Rendered + published ${entries.length}/${doable.length} in ${langName}${failed ? ` · ${failed} failed` : ""}${skippedTemplates ? ` · ${skippedTemplates} templated skipped` : ""}${bulkXlateAbort.current ? " (stopped)" : ""}.`,
    });
  }

  // ── Placeholder library (the closed atom domains, both prosody variants) ────────────────────────
  const atomInventory = useMemo(() => {
    const items: Array<{ seg: CoachClipSegment; id: string }> = [];
    for (const kind of ["square", "piece", "file", "side", "feel"] as const) {
      for (const value of domains[kind] ?? []) {
        for (const final of [false, true]) {
          const seg: CoachClipSegment = { kind, text: value, final };
          items.push({ seg, id: fragmentId(seg) });
        }
      }
    }
    return items;
  }, [domains]);
  const atomsMissing = useMemo(
    () => atomInventory.filter((a) => !fragmentUrlFor(a.seg)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atomInventory, overlayVersion],
  );
  const bulkAbort = useRef(false);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  async function renderMissingAtoms() {
    setFeedback(null);
    bulkAbort.current = false;
    const missing = atomsMissing;
    const entries: Array<{ slot: string; key: string; url: string }> = [];
    let failures = 0;
    try {
      for (let i = 0; i < missing.length; i += 1) {
        if (bulkAbort.current) break;
        setBulkBusy(`Rendering ${i + 1}/${missing.length} — ${missing[i].id}`);
        try {
          const r = await renderClip(missing[i].seg.text.trim(), fragmentStyle(style, missing[i].seg.final));
          entries.push({ slot: "fragments", key: missing[i].id, url: r.url });
        } catch (error) {
          failures += 1;
          if (failures >= 3) throw error; // keys dead / hard error — stop burning the queue
        }
      }
      if (entries.length) {
        setBulkBusy("Publishing…");
        await postJson("/voice-studio/publish", { entries });
        await refreshOverlay();
      }
      setBulkBusy(null);
      setFeedback({
        tone: failures ? "error" : "saved",
        text: `Placeholder library: ${entries.length} rendered + published${failures ? `, ${failures} failed` : ""}${bulkAbort.current ? " (stopped)" : ""}.`,
      });
    } catch (error) {
      if (entries.length) {
        // keep what we paid for — publish the partial batch before surfacing the error
        try { await postJson("/voice-studio/publish", { entries }); await refreshOverlay(); } catch { /* surfaced below */ }
      }
      setBulkBusy(null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Bulk render failed." });
    }
  }

  // Atom audition row
  const [auditionKind, setAuditionKind] = useState<string>("square");
  const [auditionValue, setAuditionValue] = useState<string>("e4");
  const [auditionFinal, setAuditionFinal] = useState(false);
  async function auditionAtom() {
    const seg: CoachClipSegment = { kind: auditionKind as CoachClipSegment["kind"], text: auditionValue, final: auditionFinal };
    const existing = fragmentUrlFor(seg);
    setFeedback(null);
    try {
      if (existing) {
        playUrl(existing);
        return;
      }
      setBulkBusy(`Rendering ${fragmentId(seg)}…`);
      const r = await renderClip(seg.text.trim(), fragmentStyle(style, seg.final));
      setBulkBusy(null);
      playUrl(clipUrl(r.url));
    } catch (error) {
      setBulkBusy(null);
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Atom render failed." });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────────────────────────
  // Grouped language dropdown: 2 bundled source langs, then 20 Gemini-translate targets (disabled
  // rows are visual section headers).
  const langOptions: Array<{ label: string; value: string; disabled?: boolean }> = [
    { label: "English (source)", value: "en" },
    { label: "Tamil — Tanglish (bundled)", value: "ta-tanglish" },
    { label: "── Translate · International ──", value: "", disabled: true },
    ...VOICE_STUDIO_LANGS.filter((l) => l.group === "International").map((l) => ({ label: l.name, value: l.code })),
    { label: "── Translate · Indian ──", value: "", disabled: true },
    ...VOICE_STUDIO_LANGS.filter((l) => l.group === "Indian").map((l) => ({ label: l.name, value: l.code })),
  ];

  // Collapsed-state summaries — a glance at current config without opening the section.
  const setupSummary = !keyStatus
    ? "Checking key status…"
    : `${keyStatus.activeGroup ? `${keyStatus.activeGroup} active` : keyStatus.storedCount ? "Custom keys" : keyStatus.envCount ? "Using env keys" : "No keys configured"} · ${keyStatus.storedCount ?? 0} stored · ${keyStatus.envCount ?? 0} from env`;
  const voiceSummary = `${voice} · ${langName} · ${dirStyle} · ${dirPace} · ${model}`;
  const libraryCovered = atomInventory.length - atomsMissing.length;
  const librarySummary = `${libraryCovered}/${atomInventory.length} placeholder clips covered${atomsMissing.length ? ` · ${atomsMissing.length} missing` : " · complete"}`;

  return (
    <>
      <CollapsibleSection
        description="Activate a preloaded token group, or paste your own Gemini keys. Stored server-side only — never shipped to the client."
        icon={KeyRound}
        onToggle={() => toggleSection("setup")}
        open={openSection.setup}
        summary={setupSummary}
        title="1 · API Keys"
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <View style={{ minWidth: 240 }}>
            <FieldLabel>API token group</FieldLabel>
            <DomSelect
              onChange={(v) => void activateGroup(v)}
              options={[
                { label: "Select a token group…", value: "" },
                ...keyGroups.map((g, i) => ({ label: `${i + 1}. ${g.name} — ${g.count} keys`, value: g.name })),
              ]}
              value={keyStatus?.activeGroup ?? ""}
              width={250}
            />
            <Text style={[styles.muted, { marginTop: 4 }]}>
              {keyStatus
                ? `${keyStatus.activeGroup ? `${keyStatus.activeGroup} active · ` : ""}${keyStatus.storedCount} stored · ${keyStatus.envCount} from env`
                : "Key status unavailable (admin session required)."}
            </Text>
          </View>
          <View style={{ flexGrow: 1, minWidth: 260 }}>
            <FieldLabel>Or paste keys (comma or newline separated)</FieldLabel>
            <TextInput
              multiline
              numberOfLines={2}
              onChangeText={setKeysDraft}
              placeholder="AIza… or AQ.…"
              placeholderTextColor="#8aa0b6"
              style={[styles.animationStudioInput, { minHeight: 56, textAlignVertical: "top" }]}
              value={keysDraft}
            />
            <View style={{ alignItems: "center", flexDirection: "row", gap: 10, marginTop: 6 }}>
              <StudioButton accent busy={feedback?.tone === "saving"} disabled={!keysDraft.trim()} label="Save keys" onPress={() => void saveKeys()} />
              {Boolean(keyStatus?.storedMasked?.length) && (
                <Text numberOfLines={1} style={[styles.muted, { flexShrink: 1 }]}>{keyStatus?.storedMasked?.join(", ")}</Text>
              )}
            </View>
          </View>
        </View>
      </CollapsibleSection>

      <CollapsibleSection
        description="Model, voice, target language, and the Director's-note style prompt sent with every render."
        icon={Mic}
        onToggle={() => toggleSection("voice")}
        open={openSection.voice}
        summary={voiceSummary}
        title="2 · Voice, Language & Style"
        tone={aiTeal}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <View style={{ minWidth: 230 }}>
            <FieldLabel>TTS model</FieldLabel>
            <DomSelect onChange={setModel} options={MODELS.map((m) => ({ label: m, value: m }))} value={model} width={240} />
          </View>
          <View style={{ minWidth: 210 }}>
            <FieldLabel>Voice</FieldLabel>
            <DomSelect
              onChange={setVoice}
              options={VOICES.map((v) => ({ label: `${v.name} — ${v.hint}`, value: v.name }))}
              value={voice}
              width={230}
            />
          </View>
          <View style={{ minWidth: 210 }}>
            <View style={{ alignItems: "center", flexDirection: "row", gap: 4, marginBottom: 4 }}>
              <Languages color={appColors.aiMuted} size={13} strokeWidth={2.25} />
              <Text style={[styles.muted, { fontWeight: "800" }]}>Language / Translate</Text>
            </View>
            <DomSelect onChange={setLang} options={langOptions} value={lang} width={230} />
          </View>
          <View style={{ alignSelf: "flex-end" }}>
            <StudioButton
              label="▶ Test voice"
              onPress={() =>
                void (async () => {
                  setFeedback({ tone: "saving", text: "Rendering test line…" });
                  try {
                    const enSample = "A clean move — the knight is doing real work now.";
                    let sample = locale === "ta" ? "நல்லா விளையாடுறீங்க — அந்த knight move அருமை." : enSample;
                    if (isTranslate) {
                      const tr = await postJson<{ text: string }>("/voice-studio/translate", { text: enSample, lang });
                      sample = tr.text;
                    }
                    const r = await renderClip(sample, styleForRender(style));
                    setFeedback(null);
                    playUrl(clipUrl(r.url));
                  } catch (error) {
                    setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Test render failed." });
                  }
                })()
              }
            />
          </View>
        </View>
        <View>
          <Text style={[styles.lessonStepTitle, { marginBottom: 6 }]}>Speaker settings</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
            <View style={{ flexGrow: 1, minWidth: 260 }}>
              <FieldLabel>Audio Profile</FieldLabel>
              <TextInput
                onChangeText={setAudioProfile}
                placeholder="A vibrant and theatrical host."
                placeholderTextColor="#8aa0b6"
                style={styles.animationStudioInput}
                value={audioProfile}
              />
            </View>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 10 }}>
            <View style={{ minWidth: 170 }}>
              <FieldLabel>Style</FieldLabel>
              <DomSelect onChange={setDirStyle} options={DIRECTOR_STYLES.map((s) => ({ label: s.name, value: s.name }))} value={dirStyle} width={180} />
              <Text style={[styles.muted, { fontSize: 11, marginTop: 3, maxWidth: 200 }]}>
                {DIRECTOR_STYLES.find((s) => s.name === dirStyle)?.desc}
              </Text>
            </View>
            <View style={{ minWidth: 170 }}>
              <FieldLabel>Pace</FieldLabel>
              <DomSelect onChange={setDirPace} options={DIRECTOR_PACES.map((p) => ({ label: p.name, value: p.name }))} value={dirPace} width={180} />
              <Text style={[styles.muted, { fontSize: 11, marginTop: 3, maxWidth: 200 }]}>
                {DIRECTOR_PACES.find((p) => p.name === dirPace)?.desc}
              </Text>
            </View>
            <View style={{ minWidth: 190 }}>
              <FieldLabel>Accent</FieldLabel>
              <DomSelect onChange={setDirAccent} options={DIRECTOR_ACCENTS.map((a) => ({ label: a, value: a }))} value={dirAccent} width={200} />
            </View>
          </View>
        </View>
        <View>
          <FieldLabel>Style prompt (composed from the speaker settings; editable — changing a speaker setting recomposes it)</FieldLabel>
          <TextInput
            multiline
            numberOfLines={4}
            onChangeText={setStyle}
            placeholderTextColor="#8aa0b6"
            style={[styles.animationStudioInput, { minHeight: 96, textAlignVertical: "top" }]}
            value={style}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
            <StudioButton label="Reset to canonical coach prompt" onPress={() => setStyle(STYLE_DEFAULTS[locale])} />
            <StudioButton label="Recompose from speaker settings" onPress={() => setStyle(composeSpeakerStyle(audioProfile, dirStyle, dirPace, dirAccent))} />
          </View>
        </View>
      </CollapsibleSection>

      <CollapsibleSection
        badge={
          <View style={{ backgroundColor: atomsMissing.length ? "rgba(180,83,9,0.12)" : "rgba(21,128,61,0.12)", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ color: atomsMissing.length ? "#b45309" : "#15803d", fontSize: 11, fontWeight: "600" }}>{libraryCovered}/{atomInventory.length}</Text>
          </View>
        }
        description="The closed placeholder domains — squares, piece words, files, sides, feels — each in mid-line and sentence-final prosody. Templated lines stitch these with their shell fragments."
        icon={AudioLines}
        onToggle={() => toggleSection("library")}
        open={openSection.library}
        summary={librarySummary}
        title="3 · Placeholder Library"
      >
        <Text style={styles.muted}>
          64 squares, {domains.piece.length} piece words, 8 files, 2 sides, {domains.feel.length} feels — mid-line (:m) and sentence-final (:f) prosody variants.
        </Text>
        <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <StudioButton
            accent
            busy={bulkBusy !== null}
            disabled={atomsMissing.length === 0}
            label={bulkBusy ?? (atomsMissing.length ? `Render + publish ${atomsMissing.length} missing` : "All placeholder audio covered ✓")}
            onPress={() => void renderMissingAtoms()}
          />
          {bulkBusy !== null && <StudioButton label="Stop" onPress={() => { bulkAbort.current = true; }} />}
        </View>
        <View style={{ alignItems: "flex-end", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <View>
            <FieldLabel>Audition placeholder</FieldLabel>
            <DomSelect
              onChange={(k) => { setAuditionKind(k); setAuditionValue(domains[k as keyof typeof domains]?.[0] ?? ""); }}
              options={Object.keys(domains).map((k) => ({ label: k, value: k }))}
              value={auditionKind}
              width={130}
            />
          </View>
          <View>
            <FieldLabel>Value</FieldLabel>
            <DomSelect
              onChange={setAuditionValue}
              options={(domains[auditionKind as keyof typeof domains] ?? []).map((v) => ({ label: v, value: v }))}
              value={auditionValue}
              width={170}
            />
          </View>
          <View>
            <FieldLabel>Prosody</FieldLabel>
            <DomSelect
              onChange={(v) => setAuditionFinal(v === "f")}
              options={[{ label: "mid-line (:m)", value: "m" }, { label: "sentence-final (:f)", value: "f" }]}
              value={auditionFinal ? "f" : "m"}
              width={160}
            />
          </View>
          <StudioButton label="▶ Play" onPress={() => void auditionAtom()} />
        </View>
      </CollapsibleSection>

      <VoiceShortsAdmin renderClip={renderClip} />

      <Panel title="5 · Voice Lines">
        <View style={[styles.databaseRowCard, { gap: 10 }]}>
          <View style={{ alignItems: "center", flexDirection: "row", gap: 6 }}>
            <ListFilter color={appColors.aiMuted} size={15} strokeWidth={2.25} />
            <Text style={[styles.muted, { fontWeight: "800" }]}>Filters</Text>
          </View>
          <View style={{ alignItems: "flex-end", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <View>
              <FieldLabel>Content</FieldLabel>
              <DomSelect
                onChange={(v) => { setSource(v as Source); setExpanded(null); }}
                options={[
                  { label: `Coach — live voice pool`, value: "coach-voice" },
                  { label: `Coach — phrases`, value: "coach-phrase" },
                  { label: `Learn — lessons`, value: "lesson" },
                ]}
                value={source}
                width={220}
              />
            </View>
            <View>
              <FieldLabel>Show</FieldLabel>
              <DomSelect
                onChange={(v) => setTemplateFilter(v as typeof templateFilter)}
                options={[
                  { label: "All lines", value: "all" },
                  { label: "Templated only", value: "template" },
                  { label: "Static only", value: "static" },
                ]}
                value={templateFilter}
                width={150}
              />
            </View>
            {source === "lesson" && (
              <View>
                <FieldLabel>Copy</FieldLabel>
                <DomSelect
                  onChange={(v) => setKidsMode(v === "kids")}
                  options={[{ label: "Standard", value: "std" }, { label: "Kids mode", value: "kids" }]}
                  value={kidsMode ? "kids" : "std"}
                  width={130}
                />
              </View>
            )}
            <View style={{ flexGrow: 1, minWidth: 200 }}>
              <FieldLabel>Search</FieldLabel>
              <TextInput
                onChangeText={setQuery}
                placeholder="key or text…"
                placeholderTextColor="#8aa0b6"
                style={styles.animationStudioInput}
                value={query}
              />
            </View>
          </View>
          <Text style={styles.muted}>
            {source === "lesson" && lessonsLoading ? "Loading lesson catalog (~2.5 MB)…" : `${filtered.length} lines`}
            {locale === "ta" && !taReady ? " · loading Tamil pack…" : ""}
            {isTranslate
              ? ` · ${langName} — ${visible.filter((r) => xlate[r.id]?.saved && !xlate[r.id]?.dirty).length}/${visible.length} shown already translated`
              : " · dot = clip status for the " + locale.toUpperCase() + " text"}
          </Text>
        </View>

        {/* Selection + bulk "apply to selected" toolbar. */}
        <View style={{ backgroundColor: "rgba(37,99,235,0.04)", borderColor: "#e2e8f0", borderRadius: 10, borderWidth: 1, gap: 8, marginTop: 10, padding: 10 }}>
          <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Checkbox
              checked={visible.length > 0 && visible.every((r) => selected.has(r.id))}
              indeterminate={visible.some((r) => selected.has(r.id))}
              title="Select all visible"
              onChange={() => setSelected((s) => {
                const n = new Set(s);
                if (visible.length > 0 && visible.every((r) => n.has(r.id))) visible.forEach((r) => n.delete(r.id));
                else visible.forEach((r) => n.add(r.id));
                return n;
              })}
            />
            <Text style={[styles.muted, { fontWeight: "800" }]}>
              {selected.size > 0 ? `${selected.size} selected` : "Select all visible"}
            </Text>
            {filtered.length > visible.length && (
              <StudioButton label={`Select all ${filtered.length}`} onPress={() => setSelected(new Set(filtered.map((r) => r.id)))} />
            )}
            {selected.size > 0 && <StudioButton label="Clear" onPress={() => setSelected(new Set())} />}
          </View>
          {(selected.size > 0 || bulkBusy !== null) && (
            <View style={{ gap: 8 }}>
              <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                {isTranslate && (
                  <StudioButton accent busy={bulkBusy !== null} disabled={selected.size === 0} label={`Translate selected → ${langName}`} onPress={() => void applyTranslateSelected()} />
                )}
                <StudioButton accent busy={bulkBusy !== null} disabled={selected.size === 0} label="Apply all → render + publish selected" onPress={() => void applyRenderPublishSelected()} />
                {bulkBusy !== null && <StudioButton label="Stop" onPress={() => { bulkXlateAbort.current = true; }} />}
              </View>
              {bulkBusy !== null && <Text style={[styles.muted, { color: "#1d4ed8", fontWeight: "800" }]}>{bulkBusy}</Text>}
              <Text style={[styles.muted, { fontSize: 11 }]}>Apply all runs the full pipeline on each selected line{isTranslate ? " (translate →" : " ("} render → publish). Templated lines skip whole-line publish — filter to “Static only” to bulk-publish them.</Text>
            </View>
          )}
        </View>

        <View style={{ gap: 8, marginTop: 10 }}>
          {visible.map((row) => {
            const isOpen = expanded === row.id;
            const rowBusy = busy[row.id];
            const values = valuesFor(row);
            const stitchable = isStitchable(row);
            return (
              <View key={row.id} style={styles.databaseRowCard}>
                <View style={{ alignItems: "flex-start", flexDirection: "row", gap: 10 }}>
                  <View style={{ paddingTop: 3 }}>
                    <Checkbox checked={selected.has(row.id)} onChange={() => toggleSelected(row.id)} title="Select for bulk apply" />
                  </View>
                  <Pressable onPress={() => setExpanded(isOpen ? null : row.id)} style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    <Text style={[styles.lessonStepTitle, { flexShrink: 1 }]} numberOfLines={1}>{row.key}</Text>
                    {row.template && (
                      <Chip color={stitchable ? "#b45309" : "#9f1239"} label={stitchable ? "TEMPLATE" : "TEMPLATE · open-domain"} />
                    )}
                    {!row.template && <StatusDot status={statuses.get(row.id) ?? "none"} />}
                    {isTranslate && (
                      <Chip
                        color={xlate[row.id] ? (xlate[row.id].tokensOk ? "#15803d" : "#b45309") : "#94a3b8"}
                        label={
                          !xlate[row.id]
                            ? "untranslated"
                            : !xlate[row.id].tokensOk
                              ? `${langName} ⚠ placeholder`
                              : xlate[row.id].dirty
                                ? `${langName} ✓ edited`
                                : xlate[row.id].saved
                                  ? `${langName} ✓ saved`
                                  : `${langName} ✓`
                        }
                      />
                    )}
                    {rowBusy && <Text style={[styles.muted, { color: "#1d4ed8", fontWeight: "800" }]}>{rowBusy}</Text>}
                  </View>
                  <Text style={[styles.muted, { marginTop: 3 }]} numberOfLines={isOpen ? undefined : 2}>{row.en}</Text>
                  {!isTranslate && locale === "ta" && row.value !== row.en && (
                    <Text style={[styles.muted, { marginTop: 2 }]} numberOfLines={isOpen ? undefined : 2}>{row.value}</Text>
                  )}
                  {isTranslate && xlate[row.id] && !isOpen && (
                    <Text style={[styles.muted, { color: "#1f2937", marginTop: 2 }]} numberOfLines={2}>{xlate[row.id].text}</Text>
                  )}
                  </Pressable>
                </View>
                {isOpen && (
                  <View style={{ gap: 10, marginTop: 10 }}>
                    {isTranslate && (
                      <View style={{ backgroundColor: "rgba(37,99,235,0.05)", borderRadius: 10, gap: 6, padding: 10 }}>
                        <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          <FieldLabel>{`${langName} translation${row.template ? " (keep {placeholders} intact)" : ""}`}</FieldLabel>
                          {xlate[row.id]?.saved && !xlate[row.id].dirty && (
                            <Text style={[styles.muted, { color: "#15803d", fontWeight: "800" }]}>already translated — saved</Text>
                          )}
                          {xlate[row.id]?.dirty && (
                            <Text style={[styles.muted, { color: "#b45309", fontWeight: "800" }]}>edited — Save to keep it</Text>
                          )}
                          {xlate[row.id] && !xlate[row.id].tokensOk && (
                            <Text style={[styles.muted, { color: "#b45309", fontWeight: "800" }]}>⚠ a placeholder is missing — fix before rendering</Text>
                          )}
                        </View>
                        <TextInput
                          multiline
                          onChangeText={(t) => setXlate((x) => ({ ...x, [row.id]: { text: t, tokensOk: row.slots.every((s) => t.includes(`{${s}}`)), saved: x[row.id]?.saved, dirty: true } }))}
                          placeholder={`Tap "Translate" to fill from Gemini, or type the ${langName} line…`}
                          placeholderTextColor="#8aa0b6"
                          style={[styles.animationStudioInput, { minHeight: 52, textAlignVertical: "top" }]}
                          value={xlate[row.id]?.text ?? ""}
                        />
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          <StudioButton busy={Boolean(rowBusy)} label={xlate[row.id] ? "↻ Re-translate" : "Translate"} onPress={() => void translateRowAction(row)} />
                          {xlate[row.id]?.dirty && <StudioButton accent label="Save edit" onPress={() => void saveTranslation(row)} />}
                        </View>
                        {Boolean(xlate[row.id]?.text) && (
                          <Text style={[styles.muted, { fontSize: 11 }]}>Translation ready — “▶ Preview” converts it to audio, then “Publish”.</Text>
                        )}
                      </View>
                    )}
                    {row.template && (
                      <View style={{ alignItems: "flex-end", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                        {row.slots.map((name) => {
                          const kind = SLOT_KIND.get(name);
                          if (!kind) {
                            return (
                              <Text key={name} style={[styles.muted, { color: "#9f1239" }]}>{`{${name}} — open domain (live TTS at runtime)`}</Text>
                            );
                          }
                          return (
                            <View key={name}>
                              <FieldLabel>{`{${name}} · ${kind}`}</FieldLabel>
                              <DomSelect
                                onChange={(v) => setSlotValues((s) => ({ ...s, [row.id]: { ...(s[row.id] ?? {}), [name]: v } }))}
                                options={(domains[kind as keyof typeof domains] ?? []).map((v) => ({ label: v, value: v }))}
                                value={values[name] ?? ""}
                                width={150}
                              />
                            </View>
                          );
                        })}
                      </View>
                    )}
                    {row.template && (isTranslate ? Boolean(xlate[row.id]?.text) : true) && (
                      <Text selectable style={styles.databaseJson}>{fillTemplate(baseTextFor(row), values)}</Text>
                    )}
                    <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                      <StudioButton busy={Boolean(rowBusy)} label="▶ Preview" onPress={() => void previewRow(row)} />
                      {!row.template && (
                        <StudioButton accent busy={Boolean(rowBusy)} label="Publish" onPress={() => void publishWholeLine(row)} />
                      )}
                      {row.template && stitchable && lang === "en" && (
                        <>
                          <StudioButton busy={Boolean(rowBusy)} label="▶ Stitched (raw)" onPress={() => void previewStitched(row)} />
                          <StudioButton accent busy={Boolean(rowBusy)} label="Publish shell fragments" onPress={() => void publishShells(row)} />
                        </>
                      )}
                      {row.template && stitchable && lang === "ta-tanglish" && (
                        <StudioButton busy={Boolean(rowBusy)} label="▶ Stitched (runtime)" onPress={() => void previewStitched(row)} />
                      )}
                      <StudioButton label="■ Stop" onPress={() => { stopAudio(); setRowBusy(row.id, null); }} />
                    </View>
                    {!isTranslate && row.template && stitchable && (
                      <Text style={styles.muted}>
                        “Preview” renders the whole filled line in one pass — natural, seamless (this is what the coach’s render-on-miss voice plays). “Stitched (raw)” concatenates fragment clips to audition the parked runtime stitch — expect seams/pauses. Publishing fragments prepares that library; whole-line publishes go live immediately.
                      </Text>
                    )}
                    {!isTranslate && row.template && locale === "ta" && (
                      <Text style={styles.muted}>Tamil templated lines STITCH at runtime (owner call 2026-07-28 — Tanglish atoms stay English; the case suffix rides the following shell). “Stitched (runtime)” is what a player hears; “Preview” renders the filled line whole for comparison. Note: {"{feel}"} previews substitute the English feel text — runtime uses the Tamil atom.</Text>
                    )}
                    {isTranslate && (
                      <Text style={styles.muted}>
                        {row.template
                          ? `Preview fills the translated template with the atom values above (kept in English, like the placeholder library) and renders it whole in ${langName}.`
                          : `Preview/Publish render the ${langName} translation above. Runtime playback of new languages needs the coach locale system extended — publishing stores the clip for when it is.`}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
        {filtered.length > visible.length && (
          <View style={{ alignItems: "center", marginTop: 10 }}>
            <StudioButton label={`Show more (${filtered.length - visible.length} left)`} onPress={() => setLimit((l) => l + PAGE)} />
          </View>
        )}
        {feedback && (
          <Text style={[styles.saveFeedback, feedback.tone === "error" && styles.saveFeedbackError, feedback.tone === "saving" && styles.saveFeedbackSaving]}>
            {feedback.text}
          </Text>
        )}
      </Panel>
    </>
  );
}
