import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';

class NoteService {
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final FirebaseStorage _storage = FirebaseStorage.instance;
  final FirebaseAuth _auth = FirebaseAuth.instance;

  /// Creates an optimistic note document and uploads the audio file to Cloud Storage.
  Future<void> uploadAndCreateNote({
    required String localFilePath,
    required int durationSeconds,
  }) async {
    final User? user = _auth.currentUser;
    if (user == null) throw Exception('User must be authenticated to upload notes.');

    final notesCollection = _firestore.collection('users').doc(user.uid).collection('notes');
    final DocumentReference noteDocRef = notesCollection.doc(); // Generate noteId
    final String noteId = noteDocRef.id;

    final String storagePath = 'users/${user.uid}/audio/$noteId.m4a';
    final File audioFile = File(localFilePath);

    if (!await audioFile.exists()) {
      throw Exception('Local audio file not found at $localFilePath');
    }

    // 1. Create optimistic Firestore document with status 'uploading'
    await noteDocRef.set({
      'noteId': noteId,
      'userId': user.uid,
      'title': 'Voice Note (${_formatTimestamp(DateTime.now())})',
      'transcript': '',
      'status': 'uploading',
      'audioStoragePath': storagePath,
      'audioDurationSeconds': durationSeconds,
      'keywords': [],
      'deviceMetadata': {
        'platform': Platform.isIOS ? 'ios' : (Platform.isAndroid ? 'android' : 'web'),
        'appVersion': '1.0.0',
        'deviceId': user.uid,
      },
      'createdAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    });

    try {
      // 2. Upload raw audio file to Firebase Cloud Storage
      final Reference storageRef = _storage.ref().child(storagePath);
      final UploadTask uploadTask = storageRef.putFile(
        audioFile,
        SettableMetadata(contentType: 'audio/m4a'),
      );

      await uploadTask;

      // 3. Done. The Cloud Function now owns all status transitions
      // ('uploading' → 'transcribing' → 'completed'/'failed') via the Admin
      // SDK. The client must not write status — security rules forbid it.
    } catch (e) {
      // 4. On upload failure, delete the optimistic doc so it never orphans
      // in 'uploading'. The local file is kept so the user can retry Save.
      try {
        await noteDocRef.delete();
      } catch (_) {}
      rethrow;
    }
  }

  /// Best-effort cleanup of notes stuck in 'uploading' for over an hour —
  /// orphans from the app being killed between doc creation and file upload.
  /// Called once at app start; never throws.
  Future<void> cleanupStaleUploads() async {    final User? user = _auth.currentUser;
    if (user == null) return;
    try {
      final snap = await _firestore
          .collection('users')
          .doc(user.uid)
          .collection('notes')
          .where('status', isEqualTo: 'uploading')
          .get();
      final cutoff = DateTime.now().subtract(const Duration(hours: 1));
      for (final doc in snap.docs) {
        final createdAt = doc.data()['createdAt'];
        DateTime? created;
        if (createdAt is Timestamp) created = createdAt.toDate();
        // No timestamp yet (pending write) counts as stale only if really old;
        // missing timestamp → treat as stale to be safe.
        if (created == null || created.isBefore(cutoff)) {
          await doc.reference.delete();
        }
      }
    } catch (_) {}
  }

  /// Discards a recording: deletes local file and removes the optimistic doc if created.
  Future<void> discardNote({String? localFilePath, String? noteId}) async {
    if (localFilePath != null) {
      final file = File(localFilePath);
      if (await file.exists()) {
        await file.delete();
      }
    }

    if (noteId != null) {
      final User? user = _auth.currentUser;
      if (user != null) {
        await _firestore
            .collection('users')
            .doc(user.uid)
            .collection('notes')
            .doc(noteId)
            .delete();
      }
    }
  }

  String _formatTimestamp(DateTime dt) {
    return '${dt.month}/${dt.day} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  // ---------------------------------------------------------------------------
  // Phase 3.1: shareable web links.
  //
  // Token model: each link is a top-level `shares/{token}` doc whose ID is a
  // 256-bit random token (unguessable; listing is forbidden by rules). The doc
  // carries a denormalized copy of the note so public readers never touch the
  // owner's private note path. Revocation = deleting the share doc; the
  // onNoteDeleted Cloud Function also wipes all shares when a note is deleted.
  // ---------------------------------------------------------------------------

  /// Generates a URL-safe random share token (256-bit).
  String generateShareToken() {
    final random = Random.secure();
    final bytes = List<int>.generate(32, (_) => random.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
  }

  /// Publishes a read-only share link for a note. Returns the token.
  Future<String> createShareLink(
      String noteId, Map<String, dynamic> noteData) async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('Not signed in');
    final token = generateShareToken();
    final noteRef = _firestore
        .collection('users')
        .doc(user.uid)
        .collection('notes')
        .doc(noteId);
    final shareRef = _firestore.collection('shares').doc(token);
    final batch = _firestore.batch();
    batch.set(shareRef, {
      'token': token,
      'userId': user.uid,
      'noteId': noteId,
      'title': noteData['title'] ?? 'Voice Note',
      'transcript': noteData['transcript'] ?? '',
      'summary': noteData['summary'] ?? '',
      'actionItems': noteData['actionItems'] ?? [],
      'revoked': false,
      'createdAt': FieldValue.serverTimestamp(),
    });
    batch.update(noteRef, {
      'shareTokens': FieldValue.arrayUnion([token]),
      'updatedAt': FieldValue.serverTimestamp(),
    });
    await batch.commit();
    return token;
  }

  /// Revokes a share link. The token stops working immediately.
  Future<void> revokeShareLink(String noteId, String token) async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('Not signed in');
    final noteRef = _firestore
        .collection('users')
        .doc(user.uid)
        .collection('notes')
        .doc(noteId);
    final batch = _firestore.batch();
    batch.delete(_firestore.collection('shares').doc(token));
    batch.update(noteRef, {
      'shareTokens': FieldValue.arrayRemove([token]),
      'updatedAt': FieldValue.serverTimestamp(),
    });
    await batch.commit();
  }
}
