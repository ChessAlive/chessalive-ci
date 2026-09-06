// STITCH STUDIO — hand-align the coach's STITCHED lines against a real waveform.
//
// WHY THIS EXISTS. A templated coach line ("உங்க {piece} {square}-ல loose-ஆ இருக்கு.") can never be one
// whole-line recording, so it is spoken as a SEQUENCE: fixed "shell" prose plus closed-domain "atom"
// values. The offline pipeline renders each template as ONE natural CARRIER sentence and cuts the
// pieces back out at ElevenLabs per-character timestamps. Those automatic boundaries are usually right
// and occasionally tens of milliseconds off — which is precisely what a listener hears as an unnatural
// seam (a shell keeping a stray syllable, an atom losing its opening consonant). There was no way to
// fix one without re-running the whole offline pipeline.
//
// This screen closes that loop: render a carrier on demand (ElevenLabs, server-proxied — the browser
// never sees the key), see its WAVEFORM, DRAG the boundary between any two pieces, hear the re-stitched
// line immediately with any placeholder value, and publish the corrected fragments with no deploy.
//
// WHAT YOU HEAR IS WHAT SHIPS. Preview uses the runtime's own PCM helpers (concatPcmWithGaps /
// encodeWavPcm16 from coachStitchAssembler) and the runtime's own atom clips, so the preview is
// assembled by the same code that will assemble it in a game — only the shells come from the carrier
// being edited.
//
// SECOND JOB (owner ask): for lines that CANNOT be stitched — and for any line at all — re-render the
// audio outright or rewrite the text and publish that. See the "Whole line" mode.

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import {
  coachTemplateSlots,
  coachVoiceWorksheet,
  decomposeTemplateWithValues,
  preloadCoachVoiceLocale,
  type CoachClipSegment,
} from "@chessalive/chess-core";
import { realtimeHttpEndpoint, sessionAuthHeaders } from "@chessalive/services";

import { COACH_FRAGMENT_CLIPS_TA } from "@gameplay/audio/coachFragmentClipManifestTa";
import { FRAGMENT_CLIP_CACHE_VERSION, FRAGMENT_SILENT, fragmentId } from "@gameplay/audio/coachFragmentClips";
import { clipKey } from "@gameplay/audio/coachVoiceClips";
import { concatPcmWithGaps, encodeWavPcm16, STITCH_JOIN_GAP_SECONDS, STITCH_TRIM_THRESHOLD, STITCH_FADE_SECONDS } from "@gameplay/audio/coachStitchAssembler";
import { installVoiceClipOverlay, voiceOverlayFragmentUrl } from "@gameplay/audio/voiceClipOverlay";
import { styles } from "@app/shell/theme";
import { uiScale } from "@app/shell/uiScale";
import { Panel } from "@shared/primitives";

// ── API ───────────────────────────────────────────────────────────────────────────────────────────
const api = (path: string) => `${realtimeHttpEndpoint()}${path}`;
const originUrl = (path: string) => (/^https?:|^blob:/.test(path) ? path : `${realtimeHttpEndpoint().replace(/\/api$/, "")}${path}`);

async function postJson<T>(path: string, body: unknown, limitNote = ""): Promise<T> {
  const res = await fetch(api(path), {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `${path} failed (${res.status})${limitNote}`);
  return data;
}
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(api(path), { credentials: "include", headers: { ...sessionAuthHeaders() } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `${path} failed (${res.status}).`);
  return data;
}

// ── Audio helpers ─────────────────────────────────────────────────────────────────────────────────
// ONE AudioContext for the screen. (The runtime assembler keeps its own module singleton; this screen
// decodes far more than a game does, so it owns its context and never fights that cache.)
let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC = (globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { return null; }
  return ctx;
}
let adminAudio: HTMLAudioElement | null = null;
function playUrl(url: string): void {
  if (typeof Audio === "undefined") return;
  if (!adminAudio) adminAudio = new Audio();
  adminAudio.pause();
  adminAudio.src = url;
  void adminAudio.play().catch(() => undefined);
}
function stopAudio(): void {
  adminAudio?.pause();
}
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode blows the stack on a whole WAV in one call
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
};

/** Decode any coach clip URL to mono PCM (the first channel — every coach clip is mono). */
async function decodeUrl(url: string): Promise<AudioBuffer | null> {
  const dec = audioCtx();
  if (!dec) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await dec.decodeAudioData(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// ── Domains for the placeholder dropdowns ─────────────────────────────────────────────────────────
const SQUARES = "abcdefgh".split("").flatMap((f) => "12345678".split("").map((r) => `${f}${r}`));
const FILES = "abcdefgh".split("");
const SLOT_KIND = new Map(coachTemplateSlots().map((s) => [s.name, s.kind]));

/** Atom dropdown domains in TAMIL — this studio edits the ta lane (the only one that stitches at
 *  runtime today), so piece/side/feel words come from the ta worksheet, not the English one. */
function taAtomDomains(): Record<string, string[]> {
  const ta = coachVoiceWorksheet("ta");
  const byPrefix = (p: string) => [...new Set(ta.filter((r) => r.key.startsWith(p)).map((r) => r.value))];
  return { square: SQUARES, file: FILES, piece: byPrefix("piece."), side: byPrefix("side."), feel: byPrefix("feel.") };
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────
type Row = {
  key: string;
  /** The ta text (template for stitchable rows, the literal line for whole-line rows). */
  value: string;
  template: boolean;
  slots: string[];
  /** Stitchable = templated AND every slot is closed-domain (open-domain slots are never stitched). */
  stitchable: boolean;
};

const slotNames = (text: string): string[] => {
  const out: string[] = [];
  const re = /\{([^}]+)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
};

/** The fragment clip URL the RUNTIME would use for this segment in the ta lane (published wins). */
function taFragmentUrl(seg: CoachClipSegment): string | null {
  const id = fragmentId(seg);
  const published = voiceOverlayFragmentUrl(id, "ta");
  if (published) return published;
  const bundled = COACH_FRAGMENT_CLIPS_TA[id];
  return bundled ? originUrl(`${bundled}?v=${FRAGMENT_CLIP_CACHE_VERSION}`) : null;
}

// ── Cut model ─────────────────────────────────────────────────────────────────────────────────────
/** One audio-bearing piece of the carrier: which fragment it is, and the slice of the carrier that
 *  currently represents it. `start`/`end` are SECONDS and are what the operator drags. */
type Cut = {
  fragmentId: string;
  kind: CoachClipSegment["kind"];
  text: string;
  start: number;
  end: number;
};

/** Initial boundaries from the render's per-character alignment — the same mapping the offline cutter
 *  uses (char span → time span), which is why an untouched line here sounds exactly like the shipped
 *  one. Characters are matched by walking the carrier string, so a segment's char range is exact by
 *  construction (the segments were concatenated to BUILD that string). */
function cutsFromAlignment(segments: CoachClipSegment[], alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): Cut[] | null {
  const st = alignment.character_start_times_seconds;
  const en = alignment.character_end_times_seconds;
  const chars = alignment.characters;
  if (!Array.isArray(chars) || chars.length !== st?.length || chars.length !== en?.length) return null;
  const cuts: Cut[] = [];
  let at = 0;
  for (const seg of segments) {
    const from = at;
    at += seg.text.length;
    if (FRAGMENT_SILENT.test(seg.text)) continue; // punctuation glue — no audio, never a cut
    const a = Math.max(0, Math.min(from, chars.length - 1));
    const b = Math.max(a + 1, Math.min(at, chars.length));
    cuts.push({ fragmentId: fragmentId(seg), kind: seg.kind, text: seg.text, start: st[a], end: en[b - 1] });
  }
  return cuts.length ? cuts : null;
}

/** Slice mono PCM out of a decoded buffer, with the runtime's own edge fade so a raw cut can't click. */
function slicePcm(buf: AudioBuffer, start: number, end: number): Float32Array {
  const sr = buf.sampleRate;
  const data = buf.getChannelData(0);
  const a = Math.max(0, Math.min(data.length, Math.floor(start * sr)));
  const b = Math.max(a, Math.min(data.length, Math.floor(end * sr)));
  const out = new Float32Array(data.subarray(a, b)); // copy — subarray aliases the decoded buffer
  const fade = Math.min(Math.floor(sr * STITCH_FADE_SECONDS), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i += 1) {
    const g = (i + 1) / (fade + 1);
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  return out;
}

const wavBlobUrl = (pcm: Float32Array, sampleRate: number): string =>
  URL.createObjectURL(new Blob([encodeWavPcm16(pcm, sampleRate)], { type: "audio/wav" }));

// ── Waveform ──────────────────────────────────────────────────────────────────────────────────────
const WAVE_H = 132;
/** Per-bucket peak amplitude — cheap, stable, and enough to see word boundaries and silences. */
function peaksOf(buf: AudioBuffer, buckets: number): Float32Array {
  const data = buf.getChannelData(0);
  const out = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(data.length / buckets));
  for (let i = 0; i < buckets; i += 1) {
    let peak = 0;
    const from = i * per;
    const to = Math.min(data.length, from + per);
    for (let j = from; j < to; j += 1) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

export function StitchStudioAdmin() {
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"stitch" | "whole">("stitch");
  const [limit, setLimit] = useState(25);
  const [feedback, setFeedback] = useState<{ tone: "error" | "ok" | "busy"; text: string } | null>(null);
  const [keyStatus, setKeyStatus] = useState<{ storedCount: number; envCount: number; voiceId?: string } | null>(null);
  const [keysDraft, setKeysDraft] = useState("");

  // Selected line + its editing state.
  const [sel, setSel] = useState<Row | null>(null);
  const [slotValues, setSlotValues] = useState<Record<string, string>>({});
  const [textDraft, setTextDraft] = useState("");
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [planned, setPlanned] = useState<Record<string, { cuts: Cut[]; text: string }>>({});
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveWrapRef = useRef<View | null>(null);
  const [waveW, setWaveW] = useState(880);

  const domains = useMemo(() => (ready ? taAtomDomains() : { square: SQUARES, file: FILES, piece: [], side: [], feel: [] }), [ready]);

  // The ta voice pack loads lazily — every row's text comes from it, so nothing can render first.
  useEffect(() => {
    let alive = true;
    void preloadCoachVoiceLocale("ta").then(() => {
      if (!alive) return;
      const sheet = coachVoiceWorksheet("ta");
      const built: Row[] = sheet
        .filter((r) => r.value && r.value !== r.en) // untranslated rows would edit the English lane
        .map((r) => {
          const slots = slotNames(r.value);
          return {
            key: r.key,
            value: r.value,
            template: slots.length > 0,
            slots,
            stitchable: slots.length > 0 && slots.every((s) => SLOT_KIND.get(s) != null),
          };
        });
      setRows(built);
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  // Server status: key presence (masked) + any previously saved alignment plan.
  const refreshStatus = useCallback(async () => {
    try {
      const s = await getJson<{ keys: { storedCount: number; envCount: number; voiceId?: string }; carriers: Record<string, { text: string; cuts: Cut[] }> }>("/stitch-studio/status");
      setKeyStatus(s.keys);
      const saved: Record<string, { cuts: Cut[]; text: string }> = {};
      for (const [k, v] of Object.entries(s.carriers ?? {})) saved[k] = { cuts: v.cuts as Cut[], text: v.text };
      setPlanned(saved);
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    }
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => (mode === "stitch" ? r.stitchable : !r.stitchable))
      .filter((r) => !q || r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q));
  }, [rows, query, mode]);

  /** Segments for the current selection at the current slot values. */
  const segments = useMemo(() => {
    if (!sel) return null;
    if (!sel.stitchable) return null;
    return decomposeTemplateWithValues(sel.value, slotValues);
  }, [sel, slotValues]);

  /** The exact sentence that gets rendered — segments joined, byte-identical to what a player hears. */
  const carrierText = useMemo(() => (segments ? segments.map((s) => s.text).join("") : textDraft), [segments, textDraft]);

  const selectRow = useCallback((row: Row) => {
    setSel(row);
    setBuffer(null);
    setCuts([]);
    setTextDraft(row.value);
    stopAudio();
    if (row.stitchable) {
      const dom = taAtomDomains();
      const vals: Record<string, string> = {};
      for (const s of row.slots) {
        const kind = SLOT_KIND.get(s);
        const list = kind ? dom[kind] ?? [] : [];
        vals[s] = kind === "square" ? "e4" : kind === "file" ? "d" : list[0] ?? "";
      }
      setSlotValues(vals);
      const saved = planned[`tpl:${row.key}`];
      if (saved) setCuts(saved.cuts);
    } else {
      setSlotValues({});
    }
    setMode(row.stitchable ? "stitch" : "whole");
  }, [planned]);

  // ── Render the carrier on ElevenLabs ────────────────────────────────────────────────────────────
  const renderCarrier = useCallback(async () => {
    if (!sel || !carrierText.trim()) return;
    setBusy("render");
    setFeedback({ tone: "busy", text: "Rendering on ElevenLabs…" });
    try {
      const res = await postJson<{ audioBase64: string; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } }>(
        "/stitch-studio/render",
        { text: carrierText },
      );
      const dec = audioCtx();
      if (!dec) throw new Error("This browser has no AudioContext.");
      const bytes = b64ToBytes(res.audioBase64);
      const buf = await dec.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      setBuffer(buf);
      if (segments) {
        // ALIGNMENT INTEGRITY: the cutter's own invariant — the characters the engine reports must be
        // the characters we sent, or every char→time mapping below is off by the difference.
        const spoken = res.alignment.characters.join("");
        if (spoken !== carrierText) {
          setFeedback({ tone: "error", text: `Alignment/text mismatch (${spoken.length} vs ${carrierText.length}) — boundaries would be wrong. Re-render.` });
          setBusy(null);
          return;
        }
        const next = cutsFromAlignment(segments, res.alignment);
        if (next) setCuts(next);
      }
      setFeedback({ tone: "ok", text: `Rendered ${buf.duration.toFixed(2)}s — drag the boundaries to taste.` });
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [sel, carrierText, segments]);

  // ── Draw the waveform + boundary bars ───────────────────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !buffer) return;
    // CSS size is LAYOUT px but the desktop zoom paints it uiScale()× larger — the buffer must cover
    // the VISUAL pixels or the waveform blurs on wide screens.
    const dpr = Math.min(2, (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1) * uiScale();
    const w = waveW;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(WAVE_H * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${WAVE_H}px`;
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, WAVE_H);
    g.fillStyle = "rgba(120,140,180,0.10)";
    g.fillRect(0, 0, w, WAVE_H);
    // The wave itself.
    const peaks = peaksOf(buffer, w);
    const mid = WAVE_H / 2;
    g.fillStyle = "rgba(90,120,190,0.85)";
    for (let x = 0; x < w; x += 1) {
      const h = Math.max(1, peaks[x] * (WAVE_H * 0.92));
      g.fillRect(x, mid - h / 2, 1, h);
    }
    // Cut regions: alternating tints so each piece is visually distinct, atoms brighter than shells.
    const dur = buffer.duration || 1;
    cuts.forEach((c, i) => {
      const x0 = (c.start / dur) * w;
      const x1 = (c.end / dur) * w;
      const atom = c.kind !== "shell";
      g.fillStyle = atom ? "rgba(240,188,94,0.30)" : i % 2 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
      g.fillRect(x0, 0, Math.max(1, x1 - x0), WAVE_H);
      g.fillStyle = atom ? "rgba(217,144,25,0.95)" : "rgba(90,120,190,0.65)";
      g.fillRect(x0, 0, 1.5, WAVE_H);
      g.fillRect(x1 - 1.5, 0, 1.5, WAVE_H);
    });
  }, [buffer, cuts, waveW]);

  // ── Drag a boundary ─────────────────────────────────────────────────────────────────────────────
  // RN-Web note: Pressable does NOT deliver pointerdown, so the handles are plain Views with a cast
  // onPointerDown, and move/up live on `document` — the pointer routinely leaves the 12px handle.
  const dragBoundary = useCallback((cutIndex: number, edge: "start" | "end") => (ev: { clientX: number; preventDefault?: () => void }) => {
    if (!buffer) return;
    ev.preventDefault?.();
    const dur = buffer.duration || 1;
    const wrap = (canvasRef.current?.getBoundingClientRect?.() ?? null) as DOMRect | null;
    if (!wrap) return;
    const toTime = (clientX: number) => Math.max(0, Math.min(dur, ((clientX - wrap.left) / wrap.width) * dur));
    const MIN = 0.04; // never let a piece collapse to nothing
    const onMove = (e: PointerEvent | MouseEvent) => {
      const t = toTime(e.clientX);
      setCuts((prev) => {
        const next = prev.map((c) => ({ ...c }));
        const c = next[cutIndex];
        if (!c) return prev;
        if (edge === "start") {
          const lo = cutIndex > 0 ? next[cutIndex - 1].start + MIN : 0;
          c.start = Math.max(lo, Math.min(c.end - MIN, t));
          // Boundaries are SHARED: moving this piece's start moves the previous piece's end, so the
          // stitch never grows a hole or an overlap the operator didn't ask for.
          if (cutIndex > 0) next[cutIndex - 1].end = c.start;
        } else {
          const hi = cutIndex < next.length - 1 ? next[cutIndex + 1].end - MIN : dur;
          c.end = Math.min(hi, Math.max(c.start + MIN, t));
          if (cutIndex < next.length - 1) next[cutIndex + 1].start = c.end;
        }
        return next;
      });
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove as EventListener);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("mousemove", onMove as EventListener);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("pointermove", onMove as EventListener);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("mousemove", onMove as EventListener);
    document.addEventListener("mouseup", onUp);
  }, [buffer]);

  // ── Preview ─────────────────────────────────────────────────────────────────────────────────────
  /** Play ONE cut straight out of the carrier — the fastest way to hear whether a boundary is right. */
  const playCut = useCallback((c: Cut) => {
    if (!buffer) return;
    playUrl(wavBlobUrl(slicePcm(buffer, c.start, c.end), buffer.sampleRate));
  }, [buffer]);

  /**
   * Play the line as the RUNTIME would build it: shells sliced from the carrier being edited, atoms
   * from their own shipped/published clips. That mix is the point — it proves the hand-tuned shells
   * join cleanly to the real atoms, which is the thing the offline pipeline could never show you.
   */
  const playStitch = useCallback(async () => {
    if (!buffer || !cuts.length) return;
    setBusy("preview");
    try {
      const sr = buffer.sampleRate;
      const parts: Float32Array[] = [];
      for (const c of cuts) {
        if (c.kind === "shell") {
          parts.push(slicePcm(buffer, c.start, c.end));
          continue;
        }
        const url = taFragmentUrl({ kind: c.kind, text: c.text, final: c.fragmentId.endsWith(":f") });
        const atom = url ? await decodeUrl(url) : null;
        // No shipped atom (a value never rendered) → fall back to the carrier's own slice so the
        // preview still plays the whole line instead of dropping a word.
        parts.push(atom ? new Float32Array(atom.getChannelData(0)) : slicePcm(buffer, c.start, c.end));
      }
      const gap = Math.round(sr * STITCH_JOIN_GAP_SECONDS);
      const fade = Math.round(sr * STITCH_FADE_SECONDS);
      const pcm = concatPcmWithGaps(parts, gap, STITCH_TRIM_THRESHOLD, fade, true);
      playUrl(wavBlobUrl(pcm, sr));
      setFeedback({ tone: "ok", text: `Preview: ${cuts.length} pieces, ${(pcm.length / sr).toFixed(2)}s.` });
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [buffer, cuts]);

  // ── Save + publish ──────────────────────────────────────────────────────────────────────────────
  const savePlan = useCallback(async () => {
    if (!sel || !cuts.length) return;
    setBusy("save");
    try {
      const entry = { carrierKey: `tpl:${sel.key}`, text: carrierText, cuts: cuts.map((c) => ({ fragmentId: c.fragmentId, start: c.start, end: c.end })) };
      await postJson("/stitch-studio/plan", { entries: [entry] });
      setPlanned((p) => ({ ...p, [entry.carrierKey]: { cuts, text: carrierText } }));
      setFeedback({ tone: "ok", text: "Alignment saved. Publish to make players hear it." });
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [sel, cuts, carrierText]);

  /** Publish the SHELLS of the current line (atoms already ship; a shell is what the carrier owns). */
  const publishLine = useCallback(async () => {
    if (!buffer || !cuts.length) return;
    setBusy("publish");
    setFeedback({ tone: "busy", text: "Publishing…" });
    try {
      const sr = buffer.sampleRate;
      const entries = cuts
        .filter((c) => c.kind === "shell")
        .map((c) => ({
          kind: "fragment" as const,
          locale: "ta" as const,
          id: c.fragmentId,
          wavBase64: bytesToB64(new Uint8Array(encodeWavPcm16(slicePcm(buffer, c.start, c.end), sr))),
        }));
      if (!entries.length) throw new Error("Nothing to publish — this line has no shell pieces.");
      const res = await postJson<{ published: number; counts: Record<string, number> }>("/stitch-studio/publish", { entries });
      await refreshOverlay();
      setFeedback({ tone: "ok", text: `Published ${res.published} fragment${res.published === 1 ? "" : "s"} — live for players now.` });
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [buffer, cuts]);

  /** Re-render the WHOLE line (no stitching) and publish it as a single whole-line clip. Covers the
   *  unstitchable rows and doubles as "this line's audio is just wrong, redo it". */
  const renderAndPublishWholeLine = useCallback(async () => {
    const text = textDraft.trim();
    if (!text) return;
    setBusy("whole");
    setFeedback({ tone: "busy", text: "Rendering the full line…" });
    try {
      const res = await postJson<{ audioBase64: string }>("/stitch-studio/render", { text });
      const dec = audioCtx();
      if (!dec) throw new Error("This browser has no AudioContext.");
      const buf = await dec.decodeAudioData(b64ToBytes(res.audioBase64).buffer.slice(0) as ArrayBuffer);
      const pcm = new Float32Array(buf.getChannelData(0));
      const wav = new Uint8Array(encodeWavPcm16(pcm, buf.sampleRate));
      playUrl(wavBlobUrl(pcm, buf.sampleRate));
      await postJson("/stitch-studio/publish", {
        entries: [{ kind: "coach", id: clipKey(text), wavBase64: bytesToB64(wav) }],
      });
      await refreshOverlay();
      setFeedback({ tone: "ok", text: `Published the whole line (${buf.duration.toFixed(2)}s). Playing it now.` });
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [textDraft]);

  /** PUBLISH ALL — every line that has a saved alignment plan gets re-rendered and re-cut. Sequential
   *  on purpose: ElevenLabs is per-character billed and rate-limited, and one publish call at the end
   *  keeps the manifest's read-modify-write to a single write. */
  const publishAll = useCallback(async () => {
    const keys = Object.keys(planned);
    if (!keys.length) { setFeedback({ tone: "error", text: "No saved alignments yet — align a line and Save first." }); return; }
    setBusy("publish-all");
    const dec = audioCtx();
    if (!dec) { setFeedback({ tone: "error", text: "This browser has no AudioContext." }); setBusy(null); return; }
    const entries: Array<{ kind: "fragment"; locale: "ta"; id: string; wavBase64: string }> = [];
    let done = 0;
    let failed = 0;
    for (const carrierKey of keys) {
      const plan = planned[carrierKey];
      setFeedback({ tone: "busy", text: `Publish all — rendering ${++done}/${keys.length}…` });
      try {
        const res = await postJson<{ audioBase64: string }>("/stitch-studio/render", { text: plan.text });
        const buf = await dec.decodeAudioData(b64ToBytes(res.audioBase64).buffer.slice(0) as ArrayBuffer);
        for (const c of plan.cuts) {
          if (!c.fragmentId.startsWith("sh:")) continue; // shells only — atoms have their own renders
          entries.push({ kind: "fragment", locale: "ta", id: c.fragmentId, wavBase64: bytesToB64(new Uint8Array(encodeWavPcm16(slicePcm(buf, c.start, c.end), buf.sampleRate))) });
        }
      } catch {
        failed += 1;
      }
    }
    try {
      if (entries.length) await postJson("/stitch-studio/publish", { entries });
      await refreshOverlay();
      setFeedback({ tone: failed ? "error" : "ok", text: `Published ${entries.length} fragments from ${keys.length - failed}/${keys.length} lines${failed ? ` — ${failed} failed` : ""}.` });
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [planned]);

  /** Re-pull the published manifest so status chips update without a reload. */
  const refreshOverlay = useCallback(async () => {
    try {
      const res = await fetch(api("/voice-studio/manifest"));
      const data = (await res.json()) as { value?: unknown };
      if (data?.value) installVoiceClipOverlay(data.value);
    } catch { /* status chips stay stale until reload — never blocks the publish */ }
  }, []);

  const saveKeys = useCallback(async () => {
    setBusy("keys");
    try {
      await postJson("/stitch-studio/keys", { keys: keysDraft });
      setKeysDraft("");
      await refreshStatus();
      setFeedback({ tone: "ok", text: "ElevenLabs key saved on the server." });
    } catch (e) {
      setFeedback({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [keysDraft, refreshStatus]);

  // ── Render ──────────────────────────────────────────────────────────────────────────────────────
  const pill = (label: string, active: boolean, onPress: () => void, tint?: string) => (
    <Pressable
      key={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionPill,
        { paddingHorizontal: 12, paddingVertical: 7 },
        active && { backgroundColor: tint ?? "rgba(90,120,190,0.22)", borderColor: tint ?? "rgba(90,120,190,0.5)" },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.actionPillText, active && { fontWeight: "800" }]}>{label}</Text>
    </Pressable>
  );

  const hasKey = Boolean(keyStatus && (keyStatus.storedCount > 0 || keyStatus.envCount > 0));

  return (
    <>
      <Panel title="Stitch Studio">
        <Text style={styles.muted}>
          Hand-align the coach&apos;s stitched Tamil lines against a real waveform: render the carrier, drag the boundary
          between any two pieces, hear it stitched with any placeholder value, and publish — no deploy, no offline script.
        </Text>

        {!hasKey ? (
          <View style={{ marginTop: 12, gap: 8 }}>
            <Text style={[styles.muted, { color: "#d99019" }]}>
              No ElevenLabs key on the server — rendering is disabled. Paste one (it is stored server-side; this screen only
              ever sees a masked tail).
            </Text>
            <TextInput
              value={keysDraft}
              onChangeText={setKeysDraft}
              placeholder="ElevenLabs API key"
              secureTextEntry
              style={[styles.input, { minWidth: 320 }]}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>{pill(busy === "keys" ? "Saving…" : "Save key", false, () => void saveKeys())}</View>
          </View>
        ) : (
          <Text style={[styles.muted, { marginTop: 8 }]}>
            ElevenLabs ready · voice {keyStatus?.voiceId?.slice(0, 8)}… · {keyStatus?.storedCount ? `${keyStatus.storedCount} stored key(s)` : `${keyStatus?.envCount} env key(s)`} ·{" "}
            {Object.keys(planned).length} saved alignment(s)
          </Text>
        )}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12, alignItems: "center" }}>
          {pill(`Needs stitching (${rows.filter((r) => r.stitchable).length})`, mode === "stitch", () => setMode("stitch"))}
          {pill(`Whole-line (${rows.filter((r) => !r.stitchable).length})`, mode === "whole", () => setMode("whole"))}
          <TextInput value={query} onChangeText={setQuery} placeholder="Filter by key or text…" style={[styles.input, { flexGrow: 1, minWidth: 220 }]} />
          {pill(busy === "publish-all" ? "Publishing all…" : `Publish all (${Object.keys(planned).length})`, false, () => void publishAll(), "rgba(240,188,94,0.28)")}
        </View>

        {!ready ? (
          <Text style={[styles.muted, { marginTop: 12 }]}>Loading the Tamil voice pack…</Text>
        ) : (
          <View style={{ marginTop: 12, gap: 6 }}>
            {visible.slice(0, limit).map((r) => {
              const isSel = sel?.key === r.key;
              const savedPlan = planned[`tpl:${r.key}`];
              return (
                <Pressable
                  key={r.key}
                  onPress={() => selectRow(r)}
                  style={({ pressed }) => [
                    styles.databaseRowCard,
                    { padding: 10 },
                    isSel && { borderColor: "rgba(90,120,190,0.7)", backgroundColor: "rgba(90,120,190,0.10)" },
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Text style={[styles.lessonStepTitle, { fontSize: 12 }]}>{r.key}</Text>
                    {savedPlan ? <Text style={[styles.muted, { color: "#d99019", fontSize: 11 }]}>● aligned</Text> : null}
                    {r.slots.length ? <Text style={[styles.muted, { fontSize: 11 }]}>{r.slots.map((s) => `{${s}}`).join(" ")}</Text> : null}
                  </View>
                  <Text style={[styles.muted, { marginTop: 2 }]} numberOfLines={2}>{r.value}</Text>
                </Pressable>
              );
            })}
            {visible.length > limit ? (
              <Pressable onPress={() => setLimit((n) => n + 25)} style={({ pressed }) => [styles.actionPill, { alignSelf: "flex-start" }, pressed && styles.pressed]}>
                <Text style={styles.actionPillText}>Show more ({visible.length - limit} left)</Text>
              </Pressable>
            ) : null}
            {!visible.length ? <Text style={styles.muted}>No lines match.</Text> : null}
          </View>
        )}
      </Panel>

      {sel ? (
        <Panel title={sel.stitchable ? "Align the placeholders" : "Whole line"}>
          <Text style={[styles.lessonStepTitle, { fontSize: 12 }]}>{sel.key}</Text>

          {sel.stitchable ? (
            <>
              {/* Placeholder dropdowns — changing one re-composes the carrier AND re-stitches the
                  preview against that value's own recorded atom. */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10, alignItems: "center" }}>
                {sel.slots.map((s) => {
                  const kind = SLOT_KIND.get(s);
                  const list = kind ? domains[kind] ?? [] : [];
                  return (
                    <View key={s} style={{ gap: 3 }}>
                      <Text style={[styles.muted, { fontSize: 11 }]}>{`{${s}}`}</Text>
                      {createElement("select", {
                        value: slotValues[s] ?? "",
                        onChange: (e: { target: { value: string } }) => setSlotValues((v) => ({ ...v, [s]: e.target.value })),
                        style: { padding: "6px 8px", borderRadius: 8, minWidth: 120 },
                      }, list.map((opt) => createElement("option", { key: opt, value: opt }, opt)))}
                    </View>
                  );
                })}
              </View>
              <Text style={[styles.muted, { marginTop: 10 }]}>{carrierText}</Text>
            </>
          ) : (
            <>
              <Text style={[styles.muted, { marginTop: 8 }]}>
                This line can&apos;t be stitched (no placeholders, or an open-domain one). Re-render its audio, or edit the
                text and publish the new recording.
              </Text>
              <TextInput
                value={textDraft}
                onChangeText={setTextDraft}
                multiline
                style={[styles.input, { marginTop: 8, minHeight: 72 }]}
              />
            </>
          )}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            {sel.stitchable ? pill(busy === "render" ? "Rendering…" : buffer ? "Re-render carrier" : "Render carrier", false, () => void renderCarrier()) : null}
            {sel.stitchable && buffer ? pill(busy === "preview" ? "Building…" : "▶ Play stitched", false, () => void playStitch(), "rgba(90,190,120,0.24)") : null}
            {sel.stitchable && cuts.length ? pill(busy === "save" ? "Saving…" : "Save alignment", false, () => void savePlan()) : null}
            {sel.stitchable && buffer ? pill(busy === "publish" ? "Publishing…" : "Publish this line", false, () => void publishLine(), "rgba(240,188,94,0.28)") : null}
            {!sel.stitchable ? pill(busy === "whole" ? "Rendering…" : "Render + publish line", false, () => void renderAndPublishWholeLine(), "rgba(240,188,94,0.28)") : null}
            {pill("Stop", false, () => stopAudio())}
          </View>

          {sel.stitchable && buffer ? (
            <View
              ref={waveWrapRef as never}
              onLayout={(e) => setWaveW(Math.max(320, Math.round(e.nativeEvent.layout.width)))}
              style={{ marginTop: 14, position: "relative" }}
            >
              {createElement("canvas", { ref: canvasRef, style: { width: "100%", height: WAVE_H, borderRadius: 10, display: "block" } })}
              {/* Draggable boundary handles, one per cut edge. Plain Views: RN-Web's Pressable never
                  delivers pointerdown, and the pointer leaves the handle within a few px of a drag.
                  FLAT on purpose — every RN-Web View is `position: relative`, so wrapping these in a
                  per-cut View made THAT the containing block (height 0, below the canvas) and the
                  handles silently landed off the waveform where no pointer could reach them. */}
              {cuts.flatMap((c, i) => {
                const dur = buffer.duration || 1;
                // PIXELS, not percentages: RN-Web silently drops a "%" string for `left` on a View
                // (every handle collapsed to x=0 and became undraggable). waveW is measured by the
                // wrapper's onLayout, so this stays correct across resizes.
                const handle = (t: number, edge: "start" | "end", key: string) => (
                  <View
                    key={key}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    {...({ onPointerDown: dragBoundary(i, edge) } as any)}
                    style={{
                      position: "absolute",
                      left: Math.round((t / dur) * waveW) - 7,
                      top: 0,
                      width: 14,
                      height: WAVE_H,
                      cursor: "ew-resize",
                      zIndex: 2,
                    } as never}
                  />
                );
                return [
                  ...(i === 0 ? [handle(c.start, "start", `${c.fragmentId}-${i}-s`)] : []),
                  handle(c.end, "end", `${c.fragmentId}-${i}-e`),
                ];
              })}
            </View>
          ) : null}

          {sel.stitchable && cuts.length ? (
            <View style={{ marginTop: 12, gap: 4 }}>
              {cuts.map((c, i) => (
                <View key={`${c.fragmentId}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={[styles.muted, { fontSize: 11, minWidth: 54, color: c.kind === "shell" ? undefined : "#d99019" }]}>
                    {c.kind === "shell" ? "shell" : c.kind}
                  </Text>
                  <Text style={[styles.muted, { fontSize: 11, minWidth: 96 }]}>
                    {c.start.toFixed(3)}s → {c.end.toFixed(3)}s
                  </Text>
                  <Pressable onPress={() => playCut(c)} style={({ pressed }) => [styles.actionPill, { paddingHorizontal: 8, paddingVertical: 3 }, pressed && styles.pressed]}>
                    <Text style={[styles.actionPillText, { fontSize: 11 }]}>▶</Text>
                  </Pressable>
                  <Text style={[styles.muted, { fontSize: 11, flexShrink: 1 }]} numberOfLines={1}>{c.text}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </Panel>
      ) : null}

      {feedback ? (
        <Panel title="Status">
          <Text style={[styles.muted, feedback.tone === "error" ? { color: "#e2574c" } : feedback.tone === "ok" ? { color: "#3f9f6a" } : undefined]}>
            {feedback.text}
          </Text>
        </Panel>
      ) : null}
    </>
  );
}
