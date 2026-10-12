# Design 002 — System Architecture (2026-10-10)

**Status:** Delivered by Gemini (staff-architect review). Accepted as the build blueprint.

## Architecture

```
+-------------------------+         +-------------------------+
|   Flutter Mobile App    |         |  Next.js Web Dashboard  |
|  (Audio Record & State) |         |  (SSR Views & Sync UI)  |
+------------+------------+         +------------+------------+
             |                                   |
             +-----------------+------------------+
                               | Firebase Auth SDK (Google Sign-In)
                               v
                  +--------------------------+
                  |       Firebase Auth      |
                  +------------+-------------+
                               |
       +-----------------------+------------------------+
       v                                                v
+-------------------------------+           +---------------------------------+
|     Firebase Cloud Storage    |           |       Cloud Firestore           |
|   (Raw Audio: .m4a / .wav)    |           |   (Notes metadata & text)       |
+----------------+--------------+           +----------------^----------------+
                 |                                             |
                 | Storage Trigger (onObjectFinalized)         | Write Transcript
                 v                                             |
+---------------------------------+                            |
|     Firebase Cloud Function     | ---------------------------+
|    (Calls Google Cloud STT v2)  |
+---------------------------------+
```

## Components
1. **Flutter mobile app (iOS/Android):** one-tap recording (`record` package), local state, Firestore realtime sync.
2. **Next.js web dashboard (Vercel):** SSR notes list + Firebase Web SDK realtime updates.
3. **Firebase Auth:** Google Sign-In everywhere; JWT on every Firestore/Storage request.
4. **Cloud Storage:** raw audio at `users/{uid}/audio/{noteId}.m4a`.
5. **Cloud Functions (Node.js/TS):** `onObjectFinalized` trigger → Google Cloud STT v2 → updates Firestore.
6. **Google Cloud STT v2 (Chirp):** transcription engine.
7. **Firestore:** note metadata, transcripts, status, keyword arrays for search.

## Data flow (record → display)
1. Google Sign-In → persistent auth token.
2. Tap record → stop → local audio file; optimistic Firestore note doc with `status: "uploading"`.
3. Upload audio to `users/{userId}/audio/{noteId}.m4a`.
4. `onObjectFinalized` fires → Cloud Function calls STT v2.
5. Function writes transcript + `status: "completed"` + `keywords` array to Firestore.
6. Firestore SDKs push realtime update to mobile + web via WebSocket — no polling.

## Failure modes
- **Upload fails mid-way:** background task handler with auto-retry; note kept locally as `failed_upload` with UI retry button.
- **STT API error/timeout:** try/catch in function → doc status `failed`, error logged; note never stuck on "Transcribing".
- **Firestore write conflicts:** security rules enforce `request.auth.uid == resource.data.userId`; functions write server timestamps + immutable system fields.

## Top 3 risks & mitigations
1. **Audio format incompatibility** (iOS .m4a/AAC vs Android .aac/.ogg) → force mono, 16kHz, PCM/AAC in recorder config.
2. **Cloud Function cold starts (3–5s)** → lightweight function, minimal deps, min-instances if justified.
3. **Keyword search scaling** (no native full-text in Firestore) → MVP uses `array-contains` on a generated `keywords` field; no Algolia/Typesense yet.

## Source
Gemini chat (yvan1107@gmail.com): https://gemini.google.com/app/63b4b3c8e3d59350
