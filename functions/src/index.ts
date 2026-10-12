import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { v2 as speechV2 } from "@google-cloud/speech";
import { GoogleGenerativeAI } from "@google/generative-ai";

admin.initializeApp();

setGlobalOptions({ region: "us-central1" });

const db = admin.firestore();
// v2 client: recognize() takes { recognizer, config, uri }.
const speechClient = new speechV2.SpeechClient();

// Gemini API key stored as a Cloud Secret (never in code).
// Set it with: firebase functions:secrets:set GEMINI_API_KEY
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Matches: users/{userId}/audio/{noteId}.m4a
const AUDIO_PATH_RE = /^users\/([^/]+)\/audio\/([^/]+)\.m4a$/;

const AI_MODEL = "gemini-3.8-flash"; // cheap + fast; swap via this constant
const EMBEDDING_MODEL = "gemini-embedding-001"; // default 3072 dims
const MAX_NOTES_FOR_SEMANTIC = 500;

// Phase 4: multilingual transcription (the VoxNote differentiator).
// STT_LANGUAGE_CODES: comma-separated BCP-47 codes, up to 3. v2 auto-detects
// the best-fit language per request and labels results with the detected tag.
// Default covers the Singapore code-switching case (English + Mandarin,
// including Singlish). Override per deploy, e.g. "en-US,ms-MY,ta-IN".
// STT_MODEL: optional v2 model identifier. Leave unset for the recognizer
// default, or set "chirp_3" — Google's multilingual ASR model with the
// strongest code-switching accuracy (GA in us/eu multi-regions).
function sttLanguageCodes(): string[] {
  const raw = (process.env.STT_LANGUAGE_CODES || "en-US,cmn-Hans-CN").trim();
  const codes = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 3);
  return codes.length > 0 ? codes : ["en-US"];
}

function genAI(): GoogleGenerativeAI {
  const key = geminiApiKey.value();
  if (!key) {
    throw new Error("GEMINI_API_KEY secret is not set");
  }
  return new GoogleGenerativeAI(key);
}

/** Unique keyword tokens for the MVP array-contains search.
 * Phase 4: Unicode-aware — keeps CJK (and any script's) tokens so keyword
 * search works for Mandarin transcripts too. Single non-ASCII chars count
 * as keywords (e.g. 我); ASCII needs 3+ chars to skip noise like "a"/"is".
 * CJK has no word spaces, so overlapping 2-char grams are also indexed —
 * array-contains needs exact element matches, and this makes partial-phrase
 * search (e.g. "开会") work against longer runs like "明天开会讨论". */
function extractKeywords(transcript: string): string[] {
  const words = transcript
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 2 || (w.length > 0 && /[^\u0000-\u007f]/.test(w)));
  const keywords = new Set<string>(words);
  for (const w of words) {
    if (w.length > 2 && /[^\u0000-\u007f]/.test(w)) {
      for (let i = 0; i + 2 <= w.length; i++) {
        keywords.add(w.slice(i, i + 2));
      }
    }
  }
  return Array.from(keywords).slice(0, 200);
}

/** Auto-title fallback: first ~7 words of the transcript, or a timestamp. */
function makeTitle(transcript: string): string {
  const words = transcript.trim().split(/\s+/).slice(0, 7).join(" ");
  if (words.length > 0) {
    return words.length > 60 ? words.slice(0, 60) + "…" : words;
  }
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `Voice Note ${mm}/${dd} ${hh}:${mi}`;
}

/** Parse the AI's JSON response, tolerant of markdown code fences. */
function parseEnrichmentJson(text: string): {
  title?: string;
  summary?: string;
  actionItems?: string[];
} {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in AI response");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

const ENRICHMENT_PROMPT = (transcript: string) => `You are VoxNote's AI assistant. The transcript below may mix languages (e.g. English and Mandarin, including Singlish code-switching) — understand it as written, without translating it.
Analyze it and return ONLY a JSON object (no markdown, no code fences) with exactly these keys:
- "title": a short, specific title for the note, max 8 words
- "summary": a 2-3 sentence summary of the key points
- "actionItems": an array of concrete action items or todos mentioned (empty array if none). Each item max 15 words.
Write the title and summary in the transcript's dominant language (the language the speaker mostly used).` + `

Transcript:
"""
${transcript.slice(0, 12000)}
"""`;

/**
 * Phase 2.1: AI enrichment. Generates title/summary/action items with the
 * Gemini API and an embedding vector for semantic search. Failure is
 * contained: the note stays usable with its transcript.
 */
async function enrichNote(userId: string, noteId: string, transcript: string): Promise<void> {
  const noteRef = db.collection("users").doc(userId).collection("notes").doc(noteId);
  try {
    const model = genAI().getGenerativeModel({ model: AI_MODEL });
    const result = await model.generateContent(ENRICHMENT_PROMPT(transcript));
    const parsed = parseEnrichmentJson(result.response.text());
    const actionItems = Array.isArray(parsed.actionItems)
      ? parsed.actionItems.filter((s) => typeof s === "string").slice(0, 20)
      : [];

    let embedding: number[] | null = null;
    try {
      const embModel = genAI().getGenerativeModel({ model: EMBEDDING_MODEL });
      const embResult = await embModel.embedContent(transcript.slice(0, 6000));
      embedding = embResult.embedding.values;
    } catch (embErr) {
      console.error(
        JSON.stringify({ event: "embedding_failed", noteId, error: String(embErr) }),
      );
    }

    const update: Record<string, unknown> = {
      title:
        typeof parsed.title === "string" && parsed.title.trim()
          ? parsed.title.trim().slice(0, 120)
          : makeTitle(transcript),
      summary:
        typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 2000) : "",
      actionItems,
      enrichmentStatus: "done",
      enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (embedding) {
      update.embedding = embedding;
    }
    await noteRef.update(update);
    console.log(JSON.stringify({ event: "enrich_done", noteId }));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "enrich_failed",
        noteId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    try {
      await noteRef.update({
        enrichmentStatus: "failed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {
      /* best effort */
    }
  }
}

/**
 * Background trigger: a new voice note audio file landed in Cloud Storage.
 * Transcribes it with Speech-to-Text v2, then runs AI enrichment.
 */
export const onAudioUploaded = onObjectFinalized(
  { secrets: [geminiApiKey] },
  async (event) => {
    const filePath = event.data.name;
    const bucket = event.data.bucket;
    console.log(JSON.stringify({ event: "audio_uploaded", filePath, bucket }));

    const match = filePath ? AUDIO_PATH_RE.exec(filePath) : null;
    if (!match) {
      console.log(
        JSON.stringify({ event: "skip", reason: "not_a_user_audio_path", filePath }),
      );
      return null;
    }
    const [, userId, noteId] = match;
    const noteRef = db.collection("users").doc(userId).collection("notes").doc(noteId);

    // Idempotency guard: onObjectFinalized has at-least-once delivery, so a
    // retry or concurrent duplicate trigger must not re-run paid transcription.
    const existing = await noteRef.get();
    if (existing.exists) {
      const currentStatus = existing.data()?.status;
      if (currentStatus === "completed" || currentStatus === "transcribing") {
        console.log(
          JSON.stringify({
            event: "skip",
            reason: "already_processed",
            noteId,
            status: currentStatus,
          }),
        );
        return null;
      }
    }
    // Claim the note before the expensive STT call so a concurrent duplicate
    // trigger sees 'transcribing' and backs off. (Admin SDK bypasses rules.)
    await noteRef.set(
      {
        status: "transcribing",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    try {
      const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
      if (!projectId) {
        throw new Error("GCLOUD_PROJECT env var is not set");
      }

      // Default v2 recognizer ("_"). STT_MODEL optionally pins a model
      // identifier (e.g. "chirp_3") on the request config instead.
      const recognizer = `projects/${projectId}/locations/global/recognizers/_`;
      const gcsUri = `gs://${bucket}/${filePath}`;
      const languageCodes = sttLanguageCodes();
      const sttModel = (process.env.STT_MODEL || "").trim();

      console.log(
        JSON.stringify({ event: "transcribe_start", noteId, userId, languageCodes, sttModel: sttModel || "default" }),
      );

      const [response] = await speechClient.recognize({
        recognizer,
        config: {
          // Input is AAC/mono/16kHz (enforced by the mobile recorder);
          // auto-decoding handles the container detection.
          autoDecodingConfig: {},
          // Phase 4: up to 3 languages; v2 auto-detects the best fit and
          // labels each result with the detected language tag.
          languageCodes,
          ...(sttModel ? { model: sttModel } : {}),
        },
        uri: gcsUri,
      });

      const transcript = (response.results ?? [])
        .map((r) => r.alternatives?.[0]?.transcript ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (!transcript) {
        throw new Error("Empty transcript returned by Speech-to-Text");
      }

      // v2 labels results with the detected language when multiple codes
      // are configured; store it for display and debugging.
      const detectedLanguage =
        response.results?.[0]?.languageCode || languageCodes[0];

      const noteUpdate: Record<string, unknown> = {
        transcript,
        title: makeTitle(transcript),
        keywords: extractKeywords(transcript),
        status: "completed",
        languageCodes,
        detectedLanguage,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await noteRef.update(noteUpdate);

      console.log(
        JSON.stringify({ event: "transcribe_done", noteId, chars: transcript.length }),
      );

      // Phase 2.1: AI enrichment runs after transcription; failures are contained.
      await enrichNote(userId, noteId, transcript);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "transcribe_failed",
          noteId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // A note must never be stuck in "transcribing".
      try {
        await noteRef.update({
          status: "failed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (updateErr) {
        console.error(
          JSON.stringify({
            event: "status_update_failed",
            noteId,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          }),
        );
      }
    }

    return null;
  },
);

/** Load a note doc and verify the caller owns it. */
async function getOwnedNote(uid: string, noteId: string) {
  const ref = db.collection("users").doc(uid).collection("notes").doc(noteId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== uid) {
    throw new HttpsError("not-found", "Note not found.");
  }
  return { ref, data: snap.data() as Record<string, unknown> };
}

/**
 * Re-run AI enrichment on demand (e.g. after the model improves, or the
 * first attempt failed). Callable: { noteId }.
 */
export const reenrichNote = onCall({ secrets: [geminiApiKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const noteId = String(request.data?.noteId ?? "");
  if (!noteId) {
    throw new HttpsError("invalid-argument", "noteId is required.");
  }
  const { data } = await getOwnedNote(request.auth.uid, noteId);
  const transcript = String(data.transcript ?? "");
  if (!transcript.trim()) {
    throw new HttpsError("failed-precondition", "Note has no transcript yet.");
  }
  await enrichNote(request.auth.uid, noteId, transcript);
  return { ok: true };
});

/**
 * Phase 2.3: secure transcript editing. Clients cannot write transcripts
 * directly (security rules forbid it), so edits go through here: ownership
 * is verified, the original is preserved, and keywords + embedding refresh
 * so search stays accurate. Callable: { noteId, transcript }.
 */
export const updateTranscript = onCall({ secrets: [geminiApiKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const noteId = String(request.data?.noteId ?? "");
  const transcript = String(request.data?.transcript ?? "").trim();
  if (!noteId) {
    throw new HttpsError("invalid-argument", "noteId is required.");
  }
  if (!transcript || transcript.length > 50000) {
    throw new HttpsError("invalid-argument", "Transcript must be 1–50000 characters.");
  }
  const uid = request.auth.uid;
  const { ref, data } = await getOwnedNote(uid, noteId);
  const alreadyEdited = data.edited === true;

  let embedding: number[] | undefined;
  try {
    const embModel = genAI().getGenerativeModel({ model: EMBEDDING_MODEL });
    const embResult = await embModel.embedContent(transcript.slice(0, 6000));
    embedding = embResult.embedding.values;
  } catch (e) {
    console.error(JSON.stringify({ event: "embedding_failed", noteId, error: String(e) }));
  }

  const update: Record<string, unknown> = {
    transcript,
    edited: true,
    keywords: extractKeywords(transcript),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!alreadyEdited) {
    update.originalTranscript = data.transcript ?? "";
  }
  if (embedding) {
    update.embedding = embedding;
  }
  await ref.update(update);
  return { ok: true };
});

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Phase 2.2: semantic search. Embeds the query server-side (API key never
 * touches clients), ranks the user's notes by cosine similarity, and returns
 * the top matches. Callable: { query, limit? }.
 */
export const semanticSearch = onCall({ secrets: [geminiApiKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const query = String(request.data?.query ?? "").trim().slice(0, 500);
  const limit = Math.min(Math.max(Number(request.data?.limit ?? 8) || 8, 1), 20);
  if (!query) {
    throw new HttpsError("invalid-argument", "query is required.");
  }
  const uid = request.auth.uid;

  const embModel = genAI().getGenerativeModel({ model: EMBEDDING_MODEL });
  const embResult = await embModel.embedContent(query);
  const qvec = embResult.embedding.values;

  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("notes")
    .orderBy("createdAt", "desc")
    .limit(MAX_NOTES_FOR_SEMANTIC)
    .get();

  const scored: { id: string; title: string; snippet: string; score: number }[] = [];
  for (const d of snap.docs) {
    const data = d.data();
    const evec = data.embedding;
    if (!Array.isArray(evec) || evec.length === 0) continue;
    const score = cosineSimilarity(qvec, evec as number[]);
    scored.push({
      id: d.id,
      title: String(data.title ?? "Voice Note"),
      snippet: String(data.summary ?? data.transcript ?? "").slice(0, 160),
      score,
    });
  }
  scored.sort((x, y) => y.score - x.score);
  return {
    results: scored.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      score: Math.round(r.score * 1000) / 1000,
    })),
  };
});

/**
 * Phase 3.1 backstop: when a note is deleted, every public share link for it
 * dies too. Clients also delete share docs directly, but this trigger covers
 * any path that removes the note, so a stale link can never outlive its note.
 */
export const onNoteDeleted = onDocumentDeleted(
  "users/{userId}/notes/{noteId}",
  async (event) => {
    const userId = event.params.userId as string;
    const noteId = event.params.noteId as string;
    console.log(JSON.stringify({ event: "note_deleted", userId, noteId }));
    const snap = await db
      .collection("shares")
      .where("userId", "==", userId)
      .where("noteId", "==", noteId)
      .get();
    if (snap.empty) {
      return null;
    }
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log(
      JSON.stringify({ event: "shares_cleaned", noteId, count: snap.size }),
    );
    return null;
  },
);
