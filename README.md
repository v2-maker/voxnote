# VoxNote MVP

> **"Think it, say it — it's everywhere."**
> A voice-first note-taking monorepo: Flutter (mobile), Next.js (web dashboard),
> Firebase (Auth, Firestore, Cloud Storage), Cloud Functions (TypeScript).

## Monorepo layout

```
voxnote/
├── firebase.json / .firebaserc / firestore.rules / storage.rules / firestore.indexes.json
├── mobile/      # Flutter app (iOS & Android)
├── web/         # Next.js dashboard
├── functions/   # Cloud Functions (TypeScript)
├── design/      # Architecture & data-model docs
└── decisions/   # Decision log
```

## Prerequisites

- Node.js v18+, npm
- Flutter SDK v3.0+
- Firebase CLI (`npm install -g firebase-tools`)
- Git

## Setup & local run

### 1. Firebase emulators

```bash
firebase login
firebase emulators:start
```

Emulator UI: http://localhost:4000

### 2. Cloud Functions

```bash
cd functions
npm install
npm run build
```

### 3. Web dashboard

```bash
cd web
cp .env.example .env.local   # fill in your Firebase project values
npm install
npm run dev                  # http://localhost:3000
```

### 4. Mobile app

```bash
cd mobile
cp .env.example .env         # fill in your Firebase values
flutter pub get
flutter run
```

## Build log

> 🗺️ Deployment: see [DEPLOY.md](DEPLOY.md) for the full zero-to-live runbook
> (Firebase setup, secrets, web hosting, mobile builds, smoke test, store release).

- 2026-10-10 — Phase 0: stack / architecture / data model (Gemini, staff-architect review)
- 2026-10-10 — Phase 1.1: monorepo scaffolding (Gemini)
- 2026-10-10 — Phase 1.2: Google Sign-In auth on Flutter + Next.js (Gemini)
- 2026-10-10 — Phase 1.3: recording screen + upload pipeline on Flutter (Gemini; Matt fixed 2 small issues)
- 2026-10-10 — Phase 1.4: transcription pipeline in Cloud Functions (Matt, direct build)
- 2026-10-10 — Phase 1.5: notes list + detail on Flutter + Next.js (Matt, direct build)
- 2026-10-10 — Phase 1.6: sync hardening review (Gemini) — 5 gaps found, all fixed
- 2026-10-10 — Phase 1.7: MVP acceptance review (Gemini) — verdict READY, no must-fix items
- 2026-10-10 — Phase 2: AI enrichment (titles/summaries/action items/embeddings), semantic search, secure transcript editing (Matt, direct build)
- 2026-10-10 — Phase 3.1: shareable web links — 256-bit token model, public read-only page, revocation, delete backstop (Matt, direct build)
- 2026-10-10 — Phase 4: multilingual transcription — STT v2 auto language detection (en-US + cmn-Hans-CN default, configurable), chirp_3 upgrade path, Unicode/CJK keyword indexing, multilingual AI enrichment (Matt, direct build)

## One-time backend setup

Phase 2's AI features call the Gemini API from Cloud Functions. Create a free
API key in Google AI Studio, then store it as a function secret:

```bash
firebase functions:secrets:set GEMINI_API_KEY
```

Without the secret, transcription still works — AI enrichment is skipped and
logged, and the note remains fully usable.

## Mobile build: share links need the web URL

The mobile app composes share links as `<WEB_BASE_URL>/s/<token>`, injected at
build time. Pass your deployed web app URL when building, otherwise the share
dialog shows a hint instead of a link:

```bash
flutter build apk --dart-define=WEB_BASE_URL=https://your-app.web.app
# or: flutter run --dart-define=WEB_BASE_URL=https://your-app.web.app
```
