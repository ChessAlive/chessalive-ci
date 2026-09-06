// Admin panel for managing the monthly Character Release calendar. Each release
// is a themed pair of pieces (currently King + Queen) with three visual
// variants (Base / Shadow / Shiny). Each variant slot links to an existing
// PieceSet — admins assign already-uploaded piece sets to the variant slots
// rather than re-uploading. New piece sets are still uploaded in the Piece
// Sets tab; this panel is purely about *curation* of the release calendar.

import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { CharacterRelease, CharacterReleaseStatus, CharacterVariant, PieceSet } from "@chessalive/funny-mode";
import type { ChessAliveServices } from "@chessalive/services";
import { styles } from "@app/shell/theme";

type Feedback = { tone: "idle" | "saving" | "saved" | "error"; text: string };

interface Props {
  services: ChessAliveServices;
  pieceSets: PieceSet[];
}

const VARIANT_ORDER: CharacterVariant[] = ["base", "shadow", "shiny"];

const VARIANT_LABEL: Record<CharacterVariant, string> = {
  base: "Base",
  shadow: "Shadow",
  shiny: "Shiny",
};

// Each variant gets a tint so the admin can scan the matrix at a glance and
// spot which slots are still empty.
const VARIANT_TINT: Record<CharacterVariant, string> = {
  base: "rgba(148, 163, 184, 0.10)",   // slate
  shadow: "rgba(99, 102, 241, 0.12)",  // indigo
  shiny: "rgba(234, 179, 8, 0.14)",    // gold
};

const STATUS_LABEL: Record<CharacterReleaseStatus, string> = {
  upcoming: "Upcoming",
  active: "Active",
  distributed: "Distributed",
  archived: "Archived",
};

const STATUS_OPTIONS: CharacterReleaseStatus[] = ["upcoming", "active", "distributed", "archived"];

// Build the YYYY-MM key for a default release (next month). Admins can override
// in the form — this is just a sensible starting value when creating a release.
function defaultMonthKey(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

// First day 00:00 UTC of the given monthKey (YYYY-MM).
function monthStartIso(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, (month ?? 1) - 1, 1, 0, 0, 0)).toISOString();
}

// Last day 23:59:59 UTC of the given monthKey.
function monthEndIso(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month ?? 1, 0, 23, 59, 59)).toISOString();
}

function emptyRelease(): CharacterRelease {
  const monthKey = defaultMonthKey();
  return {
    id: `release-${monthKey}-${Math.random().toString(36).slice(2, 8)}`,
    characterName: "",
    monthKey,
    description: "",
    pieces: ["king", "queen"],
    variants: {
      base:   { king: "", queen: "" },
      shadow: { king: "", queen: "" },
      shiny:  { king: "", queen: "" },
    },
    status: "upcoming",
    releaseStartsAt: monthStartIso(monthKey),
    releaseEndsAt: monthEndIso(monthKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function completionCount(release: CharacterRelease): { filled: number; total: number } {
  let filled = 0;
  let total = 0;
  for (const v of VARIANT_ORDER) {
    for (const p of release.pieces) {
      total += 1;
      if (release.variants[v]?.[p]) filled += 1;
    }
  }
  return { filled, total };
}

export function CharacterReleasesAdmin({ services, pieceSets }: Props) {
  const [releases, setReleases] = useState<CharacterRelease[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CharacterRelease | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({ tone: "idle", text: "" });

  useEffect(() => {
    void services.characterReleases.listReleases().then(setReleases).catch((e) => {
      setFeedback({ tone: "error", text: e instanceof Error ? e.message : "Could not load releases." });
    });
  }, [services]);

  const selectedRelease = useMemo(
    () => (selectedId ? releases.find((r) => r.id === selectedId) ?? null : null),
    [releases, selectedId],
  );

  function startNewRelease() {
    const fresh = emptyRelease();
    setDraft(fresh);
    setSelectedId(fresh.id);
  }

  function editExisting(release: CharacterRelease) {
    // Clone so the form mutations don't bleed into the list state until save.
    setDraft(JSON.parse(JSON.stringify(release)));
    setSelectedId(release.id);
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.characterName.trim()) {
      setFeedback({ tone: "error", text: "Character name is required." });
      return;
    }
    setFeedback({ tone: "saving", text: "Saving release..." });
    try {
      const saved = await services.characterReleases.saveRelease(draft);
      setReleases((current) => {
        const index = current.findIndex((r) => r.id === saved.id);
        const next = [...current];
        if (index >= 0) next[index] = saved;
        else next.unshift(saved);
        return next.sort((a, b) => b.monthKey.localeCompare(a.monthKey));
      });
      setDraft(saved);
      setFeedback({ tone: "saved", text: `${saved.characterName} release saved.` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Save failed." });
    }
  }

  async function deleteSelected() {
    if (!selectedRelease) return;
    if (typeof window !== "undefined" && !window.confirm(`Delete release "${selectedRelease.characterName}"?`)) return;
    try {
      await services.characterReleases.deleteRelease(selectedRelease.id);
      setReleases((current) => current.filter((r) => r.id !== selectedRelease.id));
      setSelectedId(null);
      setDraft(null);
      setFeedback({ tone: "saved", text: "Release deleted." });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Delete failed." });
    }
  }

  function updateDraft(patch: Partial<CharacterRelease>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateVariantSlot(variant: CharacterVariant, piece: "king" | "queen", pieceSetId: string) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        variants: {
          ...current.variants,
          [variant]: { ...current.variants[variant], [piece]: pieceSetId },
        },
      };
    });
  }

  return (
    <View style={[styles.adminTabContent, { flexDirection: "row", gap: 16 }]}>
      {/* Left rail: releases list */}
      <View style={{ width: 280, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={styles.animationStudioSubTitle}>Releases</Text>
          <Pressable onPress={startNewRelease} style={({ pressed }) => [styles.actionPill, styles.actionPillActive, pressed && styles.pressed]}>
            <Text style={[styles.actionPillText, styles.actionPillTextActive]}>+ New</Text>
          </Pressable>
        </View>
        <ScrollView style={{ maxHeight: 540 }}>
          {releases.length === 0 && (
            <Text style={styles.muted}>No releases yet. Tap "+ New" to create the first one.</Text>
          )}
          {releases.map((release) => {
            const { filled, total } = completionCount(release);
            const isSelected = release.id === selectedId;
            return (
              <Pressable
                key={release.id}
                onPress={() => editExisting(release)}
                style={({ pressed }) => [{
                  borderWidth: 1,
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 8,
                  backgroundColor: isSelected ? "rgba(59, 130, 246, 0.08)" : "rgba(255,255,255,0.02)",
                  borderColor: isSelected ? "rgba(59, 130, 246, 0.5)" : "rgba(148, 163, 184, 0.2)",
                  opacity: pressed ? 0.7 : 1,
                }]}
              >
                <Text style={{ fontWeight: "700", fontSize: 14 }}>{release.characterName || "(unnamed)"}</Text>
                <Text style={[styles.muted, { fontSize: 12 }]}>{release.monthKey} · {STATUS_LABEL[release.status]}</Text>
                <Text style={[styles.muted, { fontSize: 12, marginTop: 2 }]}>{filled}/{total} variant slots filled</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Right: editor */}
      <View style={{ flex: 1 }}>
        {!draft ? (
          <View style={styles.animationStudioPanel}>
            <Text style={styles.animationStudioSubTitle}>Character Releases</Text>
            <Text style={styles.muted}>
              Each release defines a themed character pair (King + Queen) earned through the monthly tier system.
              Each variant (Base / Shadow / Shiny) links to an existing Piece Set uploaded in the Piece Sets tab.
            </Text>
            <Text style={[styles.muted, { marginTop: 12 }]}>
              Select a release on the left, or create a new one to begin.
            </Text>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
            <View style={styles.animationStudioPanel}>
              <Text style={styles.animationStudioSubTitle}>
                {selectedRelease ? "Edit Release" : "New Release"}
              </Text>

              {/* Basic fields */}
              <View style={{ marginTop: 12, gap: 10 }}>
                <View>
                  <Text style={{ fontWeight: "600", marginBottom: 4 }}>Character name</Text>
                  <TextInput
                    value={draft.characterName}
                    onChangeText={(text) => updateDraft({ characterName: text })}
                    placeholder="e.g. Scorpion"
                    placeholderTextColor="#94a3b8"
                    style={inputStyle}
                  />
                </View>
                <View>
                  <Text style={{ fontWeight: "600", marginBottom: 4 }}>Month (YYYY-MM)</Text>
                  <TextInput
                    value={draft.monthKey}
                    onChangeText={(text) => {
                      const m = text.trim();
                      updateDraft({
                        monthKey: m,
                        releaseStartsAt: /^\d{4}-\d{2}$/.test(m) ? monthStartIso(m) : draft.releaseStartsAt,
                        releaseEndsAt:   /^\d{4}-\d{2}$/.test(m) ? monthEndIso(m)   : draft.releaseEndsAt,
                      });
                    }}
                    placeholder="2026-12"
                    placeholderTextColor="#94a3b8"
                    style={inputStyle}
                  />
                </View>
                <View>
                  <Text style={{ fontWeight: "600", marginBottom: 4 }}>Description (optional)</Text>
                  <TextInput
                    value={draft.description ?? ""}
                    onChangeText={(text) => updateDraft({ description: text })}
                    placeholder="Short note about the theme"
                    placeholderTextColor="#94a3b8"
                    multiline
                    style={[inputStyle, { minHeight: 60 }]}
                  />
                </View>
                <View>
                  <Text style={{ fontWeight: "600", marginBottom: 4 }}>Status</Text>
                  <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                    {STATUS_OPTIONS.map((s) => (
                      <Pressable
                        key={s}
                        onPress={() => updateDraft({ status: s })}
                        style={({ pressed }) => [
                          styles.actionPill,
                          draft.status === s && styles.actionPillActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.actionPillText, draft.status === s && styles.actionPillTextActive]}>
                          {STATUS_LABEL[s]}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>

              {/* Variant matrix */}
              <Text style={[styles.animationStudioSubTitle, { marginTop: 24 }]}>Variant Pieces</Text>
              <Text style={[styles.muted, { marginBottom: 12 }]}>
                Link each variant to an existing Piece Set. Higher variants are rarer rewards — Shiny King is reserved for the global Top 1% Grandmaster tier each month.
              </Text>

              <View style={{ gap: 10 }}>
                {VARIANT_ORDER.map((variant) => (
                  <View
                    key={variant}
                    style={{
                      backgroundColor: VARIANT_TINT[variant],
                      borderRadius: 10,
                      padding: 12,
                      borderWidth: 1,
                      borderColor: "rgba(148, 163, 184, 0.2)",
                    }}
                  >
                    <Text style={{ fontWeight: "700", fontSize: 14, marginBottom: 8 }}>
                      {VARIANT_LABEL[variant]}
                    </Text>
                    {(["king", "queen"] as const).map((piece) => (
                      <View key={piece} style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
                        <Text style={{ width: 64, fontWeight: "500", textTransform: "capitalize" }}>{piece}</Text>
                        <PieceSetPicker
                          pieceSets={pieceSets}
                          selectedId={draft.variants[variant][piece]}
                          onSelect={(id) => updateVariantSlot(variant, piece, id)}
                        />
                      </View>
                    ))}
                  </View>
                ))}
              </View>

              {/* Actions */}
              <View style={{ flexDirection: "row", gap: 10, marginTop: 20, alignItems: "center", flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => void saveDraft()}
                  style={({ pressed }) => [styles.actionPill, styles.actionPillActive, pressed && styles.pressed, { paddingHorizontal: 18 }]}
                >
                  <Text style={[styles.actionPillText, styles.actionPillTextActive]}>Save Release</Text>
                </Pressable>
                {selectedRelease && (
                  <Pressable
                    onPress={() => void deleteSelected()}
                    style={({ pressed }) => [styles.actionPill, pressed && styles.pressed, { paddingHorizontal: 18, borderColor: "rgba(239, 68, 68, 0.4)" }]}
                  >
                    <Text style={[styles.actionPillText, { color: "#ef4444" }]}>Delete</Text>
                  </Pressable>
                )}
                {feedback.text && (
                  <Text style={{
                    color: feedback.tone === "error" ? "#ef4444" :
                           feedback.tone === "saved" ? "#22c55e" :
                           feedback.tone === "saving" ? "#3b82f6" : "#94a3b8",
                    fontWeight: "500",
                  }}>
                    {feedback.text}
                  </Text>
                )}
              </View>
            </View>
          </ScrollView>
        )}
      </View>
    </View>
  );
}

// Compact picker showing all available piece sets, highlighting the chosen one.
// A "search by name" filter would be a nice future addition once we have many
// piece sets — for v1 we just list them all.
function PieceSetPicker({
  pieceSets,
  selectedId,
  onSelect,
}: {
  pieceSets: PieceSet[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  if (pieceSets.length === 0) {
    return <Text style={[styles.muted, { fontStyle: "italic" }]}>No piece sets uploaded yet — upload one in the Piece Sets tab first.</Text>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {pieceSets.map((set) => {
          const isSelected = set.id === selectedId;
          return (
            <Pressable
              key={set.id}
              onPress={() => onSelect(set.id)}
              style={({ pressed }) => [{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 8,
                borderWidth: 1,
                backgroundColor: isSelected ? "rgba(59, 130, 246, 0.18)" : "rgba(255,255,255,0.04)",
                borderColor: isSelected ? "rgba(59, 130, 246, 0.6)" : "rgba(148, 163, 184, 0.25)",
                opacity: pressed ? 0.7 : 1,
              }]}
            >
              <Text style={{ fontSize: 12, fontWeight: isSelected ? "700" : "500" }}>{set.name}</Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const inputStyle = {
  borderWidth: 1,
  borderColor: "rgba(148, 163, 184, 0.3)",
  borderRadius: 8,
  paddingHorizontal: 10,
  paddingVertical: 8,
  backgroundColor: "rgba(255,255,255,0.04)",
  color: "#e2e8f0",
} as const;
