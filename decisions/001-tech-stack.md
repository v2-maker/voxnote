# Decision 001 — Tech Stack (2026-10-10)

**Status:** APPROVED by ys on 2026-10-10. Proceeding to architecture design.

## Decision
**Option C — Optimized Hybrid:** Flutter (mobile) + Next.js (web dashboard) + Firebase (Auth, Firestore, Cloud Storage, Cloud Functions) + Google Cloud Speech-to-Text v2 (Chirp model).

## Rationale
- **Mobile = Flutter:** voice-first app needs reliable audio recording across Android hardware and iOS background states; Flutter's audio packages are stable, Impeller gives smooth 60fps lists.
- **Web = Next.js (not Flutter Web):** the dashboard is a text-heavy document interface; Flutter Web's CanvasKit rendering means heavy bundles and poor text selection/DOM accessibility. Next.js + Tailwind + TypeScript gives fast loads, native text selection, responsive design.
- **Backend = Firebase:** Auth (Google Sign-In everywhere), Firestore realtime listeners for instant sync, Storage for audio, Cloud Functions for the transcription trigger.
- **Transcription = Google Cloud STT v2 (Chirp):** strong accuracy across accents, streaming + batch, integrates with Functions/Storage, single-vendor billing. Whisper considered but rejected for MVP (cross-vendor overhead).

## Rejected options
- **A — All-Flutter:** fastest single-language dev, but Flutter Web weaknesses for a text dashboard.
- **B — TypeScript hybrid (RN/Expo + Next.js + Supabase):** strong, best relational scaling story, but React Native audio less battle-tested than Flutter's for this use case; more vendors.

## Reference architecture flow
1. Firebase Auth — Google Sign-In on iOS, Android, web.
2. Mobile records audio (compressed .m4a/.wav) → uploads to Cloud Storage → creates Firestore note doc with status `transcribing`.
3. Cloud Function triggers on upload → Google Cloud STT v2 → writes transcript to Firestore, status `completed`.
4. Firestore SDKs stream updates to mobile + web instantly over WebSockets.

## Source
Gemini chat (yvan1107@gmail.com): https://gemini.google.com/app/63b4b3c8e3d59350
Full response text held in conversation transcript of 2026-10-10.
