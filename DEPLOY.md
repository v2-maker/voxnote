# VoxNote — Deployment runbook (Phase 5 groundwork)

From zero to a live VoxNote: backend, web, and mobile. Each step is copy-paste
where possible. The Firebase project in `.firebaserc` is `voxnote-mvp-dev`
(replace with your real project id everywhere if you create a fresh one).

## 0. Prerequisites

- Node 18+, npm, Flutter SDK 3.0+, Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project with the Blaze (pay-as-you-go) plan — required for Cloud
  Functions and Speech-to-Text API usage.
- A free Gemini API key from Google AI Studio (needed only for AI enrichment).

## 1. Google Cloud setup (one time)

```bash
firebase login
firebase use --add              # pick your project, or keep voxnote-mvp-dev
```

In the Google Cloud console for the project, enable:
- **Cloud Speech-to-Text API** (v2 — transcription)
- **Cloud Firestore**, **Cloud Storage**, **Cloud Functions**, **Firebase Auth**
- Google Sign-In provider under Authentication → Sign-in method (Android/iOS
  OAuth client ids must match the ones in the mobile/web Firebase configs).

## 2. Cloud Functions: secrets & config

AI enrichment is the only thing needing a secret. Transcription works without it.

```bash
firebase functions:secrets:set GEMINI_API_KEY
```

Optional runtime tuning (Cloud Functions gen-2 reads `functions/.env` per
project; create `functions/.env` or `functions/.env.voxnote-mvp-dev`):

```
STT_LANGUAGE_CODES=en-US,cmn-Hans-CN   # up to 3 BCP-47 codes, auto-detected
STT_MODEL=                             # leave empty for default v2 recognizer; set "chirp_3" for the multilingual ASR model
```

## 3. Deploy backend

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
```

This deploys: Firestore rules (owner-only notes, unlisted public read by share
token), keyword indexes, Storage rules, and all functions (transcription
trigger, enrichment, semantic search, share cleanup).

## 4. Deploy web dashboard

`firebase.json` has no hosting block yet, so wire up hosting first:

```bash
firebase init hosting    # point "public" at the Next.js output (standalone export or App Hosting)
```

Then:

```bash
cd web
cp .env.example .env.local   # fill in your Firebase project values
npm install && npm run build
cd ..
firebase deploy --only hosting
```

Note the deployed URL (e.g. `https://your-app.web.app`) — the mobile app needs
it as `WEB_BASE_URL` (step 5).

## 5. Build the mobile app

```bash
cd mobile
cp .env.example .env         # fill in your Firebase values
flutter pub get
flutter build apk --dart-define=WEB_BASE_URL=https://your-app.web.app
# iOS: flutter build ipa --dart-define=WEB_BASE_URL=https://your-app.web.app
```

Without `WEB_BASE_URL`, the share dialog shows a hint instead of a link.

## 6. Smoke test (5 minutes)

1. Sign in on the phone → record a 10-second note → note appears with transcript.
2. Check the web dashboard → same note, with AI title/summary/action items
   (only if `GEMINI_API_KEY` is set).
3. Mixed-language test: say "明天下午三点开会讨论 roadmap" → transcript keeps
   both scripts, detected language stored on the note, keyword search finds 开会.
4. Create a share link on web → open it in an incognito window → read-only page
   loads; revoke the link → page goes 404.
5. Edit a transcript on web → keywords refresh, re-enrich offers new summary.

## 7. Store release (when ready)

- Android: Play Console → new app → upload the signed APK/AAB bundle, fill the
  data-safety form (audio recordings, Google Sign-In), internal test track first.
- iOS: App Store Connect → TestFlight build via Xcode/Transporter, privacy
  nutrition label (microphone, account id), then App Review.

## Current blockers (as of 2026-10-10)

- `GEMINI_API_KEY` secret not yet set → AI features skip silently (by design).
- `WEB_BASE_URL` not yet known → depends on step 4.
- No end-to-end run against a configured project or device has happened yet —
  everything so far is compile-level + static-review verification.
