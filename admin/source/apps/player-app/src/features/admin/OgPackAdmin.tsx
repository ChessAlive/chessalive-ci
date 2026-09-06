import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";

import { sessionAuthHeaders } from "@chessalive/services";

import { assetServerHttpEndpoint } from "@app/shell/env";
import { resolveBoardAssetUri, uploadOgPackImage } from "@assets/glbAssets";
import { styles } from "@app/shell/theme";
import type { CatalogPiece, OgPackManifest } from "@features/progression/characterCatalog";

// The Progression tab renders character portraits from this KV manifest (NOT from
// the JS bundle). Empty manifest => the cards fall back to a plain glyph. This
// admin panel uploads the per-piece portrait PNGs and (re)writes the manifest so
// the cards + on-board art render — the UI twin of scripts/upload-og-pack.mjs.
const MANIFEST_KEY = "og-pack-manifest:v1";

const PIECES: CatalogPiece[] = ["king", "queen", "rook", "bishop", "knight", "pawn"];
const PIECE_LABEL: Record<CatalogPiece, string> = { king: "King", queen: "Queen", rook: "Rook", bishop: "Bishop", knight: "Knight", pawn: "Pawn" };
const PIECE_GLYPH: Record<CatalogPiece, string> = { king: "♔", queen: "♕", rook: "♖", bishop: "♗", knight: "♘", pawn: "♙" };

type SlotKind = "card" | "board";
const SLOTS: { kind: SlotKind; label: string; hint: string }[] = [
  { kind: "card", label: "Card art", hint: "Progression roster card — the pristine 3D render." },
  { kind: "board", label: "Board art", hint: "On-board piece — transparent cutout." },
];

function pickImageFile(): Promise<File | null> {
  const documentRef = (globalThis as { document?: Document }).document;
  if (!documentRef) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = documentRef.createElement("input");
    input.type = "file";
    input.accept = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export function OgPackAdmin() {
  const [manifest, setManifest] = useState<OgPackManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "info" | "error" | "saved"; text: string } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${assetServerHttpEndpoint()}/database/kv?key=${encodeURIComponent(MANIFEST_KEY)}`, { credentials: "include" });
      const json = (await res.json().catch(() => ({}))) as { value?: OgPackManifest | null };
      setManifest(json?.value ?? null);
    } catch {
      setManifest(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function writeManifest(next: OgPackManifest) {
    const res = await fetch(`${assetServerHttpEndpoint()}/database/kv`, {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ key: MANIFEST_KEY, value: next }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Manifest write failed (${res.status}).`);
    }
  }

  async function handleUpload(piece: CatalogPiece, kind: SlotKind) {
    const file = await pickImageFile();
    if (!file) return;
    const slotId = `${piece}:${kind}`;
    setBusySlot(slotId);
    setFeedback({ tone: "info", text: `Uploading ${PIECE_LABEL[piece]} ${kind} art…` });
    try {
      const entry = await uploadOgPackImage(file, piece, kind);
      const base: OgPackManifest = manifest ?? { packId: "og", version: 1, uploadedAt: new Date().toISOString(), pieces: {} };
      const next: OgPackManifest = {
        ...base,
        packId: "og",
        version: base.version || 1,
        uploadedAt: new Date().toISOString(),
        pieces: { ...base.pieces, [piece]: { ...(base.pieces[piece] ?? {}), [kind]: entry } },
      };
      // Persist after every upload so a half-finished pack still shows what's done
      // (the Progression screen falls back to a glyph per-piece for anything missing).
      await writeManifest(next);
      setManifest(next);
      setFeedback({ tone: "saved", text: `${PIECE_LABEL[piece]} ${kind} art published.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Upload failed." });
    } finally {
      setBusySlot(null);
    }
  }

  const cardCount = PIECES.filter((p) => manifest?.pieces[p]?.card?.assetUrl).length;
  const boardCount = PIECES.filter((p) => manifest?.pieces[p]?.board?.assetUrl).length;

  return (
    <View style={[styles.animationBuilderPanel, { gap: 14 }]}>
      <View style={styles.animationStudioSectionHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.animationStudioSubTitle}>Starter Pack (OG) — Progression portraits</Text>
          <Text style={styles.muted}>
            These power the character cards in the Progression tab and the equipped piece art on the board. Upload a Card image (roster) and a Board image (on-board cutout) per piece. Saving writes the {MANIFEST_KEY} manifest immediately.
          </Text>
        </View>
        <Pressable onPress={() => void reload()} style={({ pressed }) => [styles.actionPill, pressed && styles.pressed]}>
          <Text style={styles.actionPillText}>↻ Refresh</Text>
        </Pressable>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <View style={{ backgroundColor: cardCount === 6 ? "rgba(21,128,61,0.10)" : "rgba(37,99,235,0.06)", borderColor: cardCount === 6 ? "rgba(21,128,61,0.3)" : "rgba(37,99,235,0.18)", borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={[styles.muted, { fontWeight: "800", color: cardCount === 6 ? "#15803d" : undefined }]}>Cards {cardCount}/6</Text>
        </View>
        <View style={{ backgroundColor: boardCount === 6 ? "rgba(21,128,61,0.10)" : "rgba(37,99,235,0.06)", borderColor: boardCount === 6 ? "rgba(21,128,61,0.3)" : "rgba(37,99,235,0.18)", borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={[styles.muted, { fontWeight: "800", color: boardCount === 6 ? "#15803d" : undefined }]}>Board {boardCount}/6</Text>
        </View>
        {loading && <Text style={[styles.muted, { alignSelf: "center" }]}>Loading manifest…</Text>}
      </View>

      {feedback && (
        <View style={{ backgroundColor: feedback.tone === "error" ? "#fdecec" : feedback.tone === "saved" ? "#e9f8ef" : "#eef4ff", borderRadius: 10, padding: 10 }}>
          <Text style={{ color: feedback.tone === "error" ? "#b42318" : feedback.tone === "saved" ? "#15803d" : "#1d4ed8", fontWeight: "700" }}>{feedback.text}</Text>
        </View>
      )}

      <View style={{ gap: 10 }}>
        {PIECES.map((piece) => (
          <View key={piece} style={{ backgroundColor: "rgba(241,246,252,0.6)", borderColor: "#e2e8f0", borderRadius: 14, borderWidth: 1, flexDirection: "row", flexWrap: "wrap", gap: 12, padding: 12 }}>
            <View style={{ alignItems: "center", justifyContent: "center", minWidth: 76 }}>
              <Text style={{ fontSize: 30, lineHeight: 36 }}>{PIECE_GLYPH[piece]}</Text>
              <Text style={[styles.muted, { fontWeight: "800" }]}>{PIECE_LABEL[piece]}</Text>
            </View>
            {SLOTS.map((slot) => {
              const entry = manifest?.pieces[piece]?.[slot.kind];
              const uri = entry?.assetUrl ? resolveBoardAssetUri(entry.assetUrl) : "";
              const busy = busySlot === `${piece}:${slot.kind}`;
              return (
                <View key={slot.kind} style={{ alignItems: "center", borderColor: uri ? "#42a9c1" : "#d7e3ee", borderRadius: 12, borderWidth: 1, gap: 6, minWidth: 150, padding: 10 }}>
                  <Text style={[styles.muted, { fontWeight: "800" }]}>{slot.label}</Text>
                  <View style={{ alignItems: "center", backgroundColor: "#ffffff", borderRadius: 8, height: 72, justifyContent: "center", overflow: "hidden", width: 72 }}>
                    {uri ? (
                      <Image source={{ uri }} resizeMode="contain" style={{ height: "100%", width: "100%" }} />
                    ) : (
                      <Text style={{ color: "#94a3b8", fontSize: 28 }}>{PIECE_GLYPH[piece]}</Text>
                    )}
                  </View>
                  <Pressable disabled={busy} onPress={() => void handleUpload(piece, slot.kind)} style={({ pressed }) => [styles.actionPill, uri && styles.actionPillActive, (pressed || busy) && styles.pressed, { opacity: busy ? 0.6 : 1 }]}>
                    <Text style={[styles.actionPillText, uri && styles.actionPillTextActive]}>{busy ? "Uploading…" : uri ? "Replace" : "Upload"}</Text>
                  </Pressable>
                  <Text numberOfLines={2} style={[styles.muted, { fontSize: 11, textAlign: "center" }]}>{slot.hint}</Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>

      <Text style={[styles.muted, { fontStyle: "italic" }]}>
        Tip: after publishing, reload the player app to see updated portraits (the manifest is fetched once on startup). PNG/JPG/WEBP supported.
      </Text>
    </View>
  );
}
