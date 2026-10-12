import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';

class AuthService {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final GoogleSignIn _googleSignIn = GoogleSignIn();

  // Stream of auth state changes
  Stream<User?> get authStateChanges => _auth.authStateChanges();

  // Current authenticated user helper
  User? get currentUser => _auth.currentUser;

  // Sign in with Google
  Future<User?> signInWithGoogle() async {
    try {
      // 1. Trigger Google Sign-In flow
      final GoogleSignInAccount? googleUser = await _googleSignIn.signIn();
      if (googleUser == null) {
        // User canceled the sign-in prompt
        return null;
      }

      // 2. Obtain auth details from the Google request
      final GoogleSignInAuthentication googleAuth =
          await googleUser.authentication;

      // 3. Create a Firebase credential using Google tokens
      final AuthCredential credential = GoogleAuthProvider.credential(
        accessToken: googleAuth.accessToken,
        idToken: googleAuth.idToken,
      );

      // 4. Authenticate with Firebase Auth
      final UserCredential userCredential =
          await _auth.signInWithCredential(credential);
      final User? user = userCredential.user;

      if (user != null) {
        await _handleUserDocument(user);
      }

      return user;
    } catch (e) {
      throw Exception('Failed to sign in with Google: $e');
    }
  }

  // Create or update user document in Cloud Firestore (users/{uid})
  Future<void> _handleUserDocument(User user) async {
    final userDocRef = _firestore.collection('users').doc(user.uid);
    final docSnapshot = await userDocRef.get();
    final now = FieldValue.serverTimestamp();

    if (!docSnapshot.exists) {
      // First login: create document with required schema fields
      await userDocRef.set({
        'uid': user.uid,
        'email': user.email ?? '',
        'displayName': user.displayName ?? 'VoxNote User',
        'createdAt': now,
        'lastLoginAt': now,
      });
    } else {
      // Returning login: update lastLoginAt timestamp
      await userDocRef.update({
        'lastLoginAt': now,
      });
    }
  }

  // Sign out
  Future<void> signOut() async {
    await _googleSignIn.signOut();
    await _auth.signOut();
  }
}
