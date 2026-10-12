# Design 003 — Firestore Data Model & Security Rules (2026-10-10)

**Status:** Delivered by Gemini (staff-architect review). Accepted as the build blueprint.

## Structure
Hierarchical subcollections: `users/{userId}/notes/{noteId}` — every note is naturally bound to its owner.

## Users collection (`users/{userId}`)
| Field | Type | Notes |
|---|---|---|
| `uid` | String | Firebase Auth UID (= document ID) |
| `email` | String | Google account email |
| `displayName` | String | From Google profile |
| `createdAt` | Timestamp | Account creation |
| `lastLoginAt` | Timestamp | Last auth |

## Notes subcollection (`users/{userId}/notes/{noteId}`)
| Field | Type | Notes |
|---|---|---|
| `noteId` | String | Auto-generated doc ID |
| `userId` | String | Owner UID (redundant, for rules) |
| `title` | String | First 5–7 words of transcript or timestamp |
| `transcript` | String | Full text from Cloud STT v2 |
| `status` | String | `uploading` \| `transcribing` \| `completed` \| `failed` |
| `audioStoragePath` | String | e.g. `users/{uid}/audio/{noteId}.m4a` |
| `audioDurationSeconds` | Number | Recording length |
| `keywords` | Array<String> | Lowercased unique tokenized words (MVP search) |
| `deviceMetadata` | Map | `{ platform: ios\|android\|web, appVersion, deviceId? }` |
| `createdAt` | Timestamp | Server timestamp, recording start |
| `updatedAt` | Timestamp | Server timestamp, last modification |

## Composite indexes (`firestore.indexes.json`)
- `notes`: `userId ASC` + `createdAt DESC` (newest-first listing)
- `notes`: `userId ASC` + `keywords CONTAINS` + `createdAt DESC` (keyword search)

## Firestore security rules (key points)
- `isOwner(userId)`: `request.auth != null && request.auth.uid == userId`
- Notes: read/list/create/update/delete only by owner; create requires `userId == uid` and `status == 'uploading'`; update cannot change `userId`.
- Cloud Functions use the Admin SDK and bypass rules.

## Storage security rules (key points)
- `users/{userId}/audio/{allPaths=**}`: read/write only when `request.auth.uid == userId`.

## Optimization highlights
- Newest-first listing via `createdAt DESC` with minimal doc scans.
- Subcollection listeners sync only the active user's data.
- MVP search = `array-contains` on the `keywords` array built during transcription; no external search engine.

## Phase 2 additions (2026-10-10)

New fields on `users/{userId}/notes/{noteId}`, written by the Cloud Function
(Admin SDK) or the secure callable functions — never directly by clients:

| Field | Type | Written by | Notes |
|---|---|---|---|
| `summary` | String | `enrichNote` | 2–3 sentence AI summary |
| `actionItems` | Array<String> | `enrichNote` | Extracted todos, max 20 |
| `embedding` | Array<Number> | `enrichNote` / `updateTranscript` | 768-dim vector for semantic search |
| `enrichmentStatus` | String | `enrichNote` | `done` \| `failed` |
| `enrichedAt` | Timestamp | `enrichNote` | Server timestamp |
| `edited` | Boolean | `updateTranscript` callable | True once user-edited |
| `originalTranscript` | String | `updateTranscript` callable | Pre-edit transcript, kept once |

Callable Cloud Functions (all require auth, all verify note ownership):
- `reenrichNote({ noteId })` — re-run AI enrichment on demand.
- `updateTranscript({ noteId, transcript })` — secure transcript edit;
  preserves original, refreshes keywords + embedding.
- `semanticSearch({ query, limit? })` — embed query server-side, cosine-rank
  the user's notes (up to 500 most recent with embeddings), return top matches.

Secret required: `GEMINI_API_KEY` (set via `firebase functions:secrets:set`).

## Phase 3.1 additions (2026-10-10) — shareable web links

**Token model.** Each share link is a top-level doc at `shares/{token}` where
`{token}` is a 256-bit random URL-safe token generated client-side
(`Random.secure()` / `crypto.getRandomValues`) — unguessable, and `allow list:
if false` means tokens can't be enumerated. The share doc carries a
denormalized copy of the note so public readers never touch the owner's
private note path:

```
shares/{token}
  token: String            # == doc ID (rules verify the match)
  userId: String           # note owner
  noteId: String           # source note
  title / transcript / summary: String
  actionItems: Array<String>
  revoked: Boolean
  createdAt: Timestamp
```

**Rules.** `allow get` for anyone holding the token (denied when
`revoked == true`); only the owner can create (token must match doc ID),
flip `revoked`, or delete. Owners track their links in the note's
`shareTokens` array (the only new client-writable note field besides
title/updatedAt).

**Deletion semantics.** Revoking = deleting the share doc; the token stops
working immediately (public page shows a dead-link state). When a note is
deleted, the `onNoteDeleted` Cloud Function wipes all its share docs
(backstop; clients also delete them directly), so a link can never outlive
its note.

**Public page.** `web/app/s/[token]/page.tsx` — read-only, no sign-in
required; the token in the URL is the capability.

## Phase 4 additions (2026-10-10) — multilingual transcription

**STT config.** The transcription function now sends up to 3 BCP-47 language
codes per request (v2 auto-detects the best fit and labels results with the
detected tag):
- `STT_LANGUAGE_CODES` env, comma-separated, default `"en-US,cmn-Hans-CN"`
  (override per deploy, e.g. `"en-US,ms-MY,ta-IN"`).
- `STT_MODEL` env, optional v2 model identifier. Unset = recognizer default.
  Set `"chirp_3"` for Google's multilingual ASR model with the strongest
  code-switching accuracy (GA in us/eu multi-regions).
- Each note stores `languageCodes` (requested) and `detectedLanguage`
  (per-result tag from the API) for display/debugging.

**Honest scope.** v2 with multiple codes auto-detects the *dominant* language
per request — ideal for "recorded in Mandarin today, English yesterday" and
short mixed utterances. True mid-sentence code-switching quality (Singlish:
"I tapao chicken rice, then go MRT") depends on the model; `chirp_3` is the
recommended upgrade path.

**Keywords.** `extractKeywords` is now Unicode-aware (`\p{L}\p{N}`): CJK
tokens are kept, and overlapping 2-char grams are indexed for CJK runs so
partial-phrase `array-contains` search (e.g. "开会") works. Semantic search
remains the best path for meaning-based retrieval across languages.

**AI enrichment.** The prompt now instructs Gemini to understand mixed-language
transcripts as written (no translation) and to write title/summary in the
transcript's dominant language.

## Source
Gemini chat (yvan1107@gmail.com): https://gemini.google.com/app/63b4b3c8e3d59350
