import 'package:audioplayers/audioplayers.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/note_service.dart';

class NoteDetailScreen extends StatefulWidget {
  final String noteId;
  const NoteDetailScreen({super.key, required this.noteId});

  @override
  State<NoteDetailScreen> createState() => _NoteDetailScreenState();
}

class _NoteDetailScreenState extends State<NoteDetailScreen> {
  final AudioPlayer _player = AudioPlayer();
  bool _isPlaying = false;
  bool _isWorking = false;
  String? _audioUrl;
  String? _audioError;

  @override
  void initState() {
    super.initState();
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _isPlaying = false);
    });
    _loadAudioUrl();
  }

  Future<void> _loadAudioUrl() async {
    try {
      final uid = FirebaseAuth.instance.currentUser?.uid;
      if (uid == null) return;
      final doc = await FirebaseFirestore.instance
          .collection('users')
          .doc(uid)
          .collection('notes')
          .doc(widget.noteId)
          .get();
      final path = doc.data()?['audioStoragePath'] as String?;
      if (path == null || path.isEmpty) return;
      final url = await FirebaseStorage.instance.ref().child(path).getDownloadURL();
      if (mounted) setState(() => _audioUrl = url);
    } catch (e) {
      if (mounted) setState(() => _audioError = 'Could not load audio: $e');
    }
  }

  Future<void> _togglePlay() async {
    if (_audioUrl == null) return;
    try {
      if (_isPlaying) {
        await _player.pause();
        setState(() => _isPlaying = false);
      } else {
        await _player.play(UrlSource(_audioUrl!));
        setState(() => _isPlaying = true);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Playback failed: $e')),
        );
      }
    }
  }

  Future<void> _callFunction(
      String name, Map<String, Object?> data, String successMessage) async {
    setState(() => _isWorking = true);
    try {
      await FirebaseFunctions.instance.httpsCallable(name).call(data);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(successMessage)));
      }
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message ?? 'Something went wrong')));
      }
    } finally {
      if (mounted) setState(() => _isWorking = false);
    }
  }

  Future<void> _showEditDialog(String currentTranscript) async {
    final controller = TextEditingController(text: currentTranscript);
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Edit transcript'),
        content: TextField(
          controller: controller,
          maxLines: 10,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            hintText: 'Transcript text',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (result != null && result.isNotEmpty && result != currentTranscript) {
      await _callFunction(
        'updateTranscript',
        {'noteId': widget.noteId, 'transcript': result},
        'Transcript updated',
      );
    }
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  /// Web origin for share links, injected at build time:
  /// flutter build ... --dart-define=WEB_BASE_URL=https://your-app.web.app
  static const String _webBaseUrl =
      String.fromEnvironment('WEB_BASE_URL', defaultValue: '');

  String _shareLinkFor(String token) =>
      _webBaseUrl.isEmpty ? '' : '$_webBaseUrl/s/$token';

  /// Phase 3.1: manage the note's public share links.
  Future<void> _showShareDialog(
      String noteId, Map<String, dynamic> data) async {
    final service = NoteService();
    var tokens =
        ((data['shareTokens'] as List?) ?? []).whereType<String>().toList();

    await showDialog(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Share note'),
          content: SizedBox(
            width: double.maxFinite,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_webBaseUrl.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 12),
                    child: Text(
                      'Sharing needs the web app URL — rebuild with --dart-define=WEB_BASE_URL=https://your-app.web.app',
                      style: TextStyle(fontSize: 12, color: Colors.black54),
                    ),
                  ),
                if (tokens.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 8),
                    child: Text('No share links yet.',
                        style: TextStyle(color: Colors.black54)),
                  )
                else
                  Flexible(
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: tokens.length,
                      itemBuilder: (context, i) {
                        final link = _shareLinkFor(tokens[i]);
                        return ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(
                            link.isEmpty ? tokens[i] : link,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12),
                          ),
                          subtitle: const Text('Anyone with this link can view',
                              style: TextStyle(fontSize: 11)),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                icon: const Icon(Icons.copy, size: 18),
                                tooltip: 'Copy link',
                                onPressed: link.isEmpty
                                    ? null
                                    : () {
                                        Clipboard.setData(
                                            ClipboardData(text: link));
                                        ScaffoldMessenger.of(context)
                                            .showSnackBar(const SnackBar(
                                                content:
                                                    Text('Link copied')));
                                      },
                              ),
                              IconButton(
                                icon: const Icon(Icons.delete_outline,
                                    size: 18),
                                tooltip: 'Revoke link',
                                onPressed: () async {
                                  try {
                                    await service.revokeShareLink(
                                        noteId, tokens[i]);
                                    setDialogState(() {
                                      tokens =
                                          List.of(tokens)..removeAt(i);
                                    });
                                    if (context.mounted) {
                                      ScaffoldMessenger.of(context)
                                          .showSnackBar(const SnackBar(
                                              content:
                                                  Text('Link revoked')));
                                    }
                                  } catch (e) {
                                    if (context.mounted) {
                                      ScaffoldMessenger.of(context)
                                          .showSnackBar(SnackBar(
                                              content:
                                                  Text('Failed: $e')));
                                    }
                                  }
                                },
                              ),
                            ],
                          ),
                        );
                      },
                    ),
                  ),
                const SizedBox(height: 8),
                ElevatedButton.icon(
                  onPressed: _webBaseUrl.isEmpty
                      ? null
                      : () async {
                          try {
                            final token = await service.createShareLink(
                                noteId, data);
                            setDialogState(
                                () => tokens = [...tokens, token]);
                            final link = _shareLinkFor(token);
                            await Clipboard.setData(
                                ClipboardData(text: link));
                            if (context.mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                      content: Text(
                                          'Link created and copied')));
                            }
                          } catch (e) {
                            if (context.mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                      content: Text('Failed: $e')));
                            }
                          }
                        },
                  icon: const Icon(Icons.add_link),
                  label: const Text('Create new link'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }

  String _formatDate(dynamic ts) {
    if (ts is Timestamp) {
      final dt = ts.toDate();
      return '${dt.month}/${dt.day}/${dt.year} '
          '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    }
    return '';
  }

  @override
  Widget build(BuildContext context) {
    final uid = FirebaseAuth.instance.currentUser?.uid;
    if (uid == null) {
      return const Scaffold(body: Center(child: Text('Not signed in')));
    }
    final docRef = FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('notes')
        .doc(widget.noteId);

    return Scaffold(
      appBar: AppBar(title: const Text('Note')),
      body: StreamBuilder<DocumentSnapshot>(
        stream: docRef.snapshots(),
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return Center(child: Text('Error: ${snapshot.error}'));
          }
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (!snapshot.hasData || !snapshot.data!.exists) {
            // The note was deleted on another device while open here —
            // exit gracefully instead of spinning forever.
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted && Navigator.canPop(context)) {
                Navigator.pop(context);
              }
            });
            return const Center(child: Text('This note was deleted.'));
          }
          final data = snapshot.data!.data() as Map<String, dynamic>;
          final status = (data['status'] as String?) ?? 'uploading';
          final title = (data['title'] as String?) ?? 'Voice Note';
          final transcript = (data['transcript'] as String?) ?? '';
          final summary = (data['summary'] as String?) ?? '';
          final edited = (data['edited'] as bool?) ?? false;
          final actionItems =
              ((data['actionItems'] as List?) ?? []).whereType<String>().toList();

          return SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: const TextStyle(
                            fontSize: 24, fontWeight: FontWeight.bold),
                      ),
                    ),
                    if (edited)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: Colors.blue.shade50,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: Colors.blue.shade200),
                        ),
                        child: Text(
                          'Edited',
                          style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: Colors.blue.shade800),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  _formatDate(data['createdAt']),
                  style: const TextStyle(color: Colors.black54, fontSize: 13),
                ),
                const SizedBox(height: 16),
                // Audio playback row
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(
                    color: Colors.deepPurple.shade50,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      IconButton(
                        icon: Icon(
                          _isPlaying
                              ? Icons.pause_circle_filled
                              : Icons.play_circle_filled,
                          size: 40,
                          color: Colors.deepPurple,
                        ),
                        onPressed: _audioUrl == null ? null : _togglePlay,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: _audioError != null
                            ? Text(_audioError!,
                                style: const TextStyle(
                                    fontSize: 12, color: Colors.red))
                            : Text(
                                _audioUrl == null
                                    ? 'Loading audio…'
                                    : 'Original recording',
                                style: const TextStyle(fontSize: 14),
                              ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                if (status == 'uploading' || status == 'transcribing') ...[
                  const Center(
                    child: Column(
                      children: [
                        CircularProgressIndicator(),
                        SizedBox(height: 12),
                        Text('Transcribing your note…',
                            style: TextStyle(color: Colors.black54)),
                      ],
                    ),
                  ),
                ] else if (status == 'failed') ...[
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.red.shade50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.red.shade200),
                    ),
                    child: const Text(
                      'Transcription failed for this note. Your audio recording is still saved — try recording again.',
                      style: TextStyle(color: Colors.red),
                    ),
                  ),
                ] else ...[
                  // AI actions row
                  Row(
                    children: [
                      const Spacer(),
                      if (_isWorking)
                        const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      else ...[
                        TextButton.icon(
                          onPressed: () => _showEditDialog(transcript),
                          icon: const Icon(Icons.edit_outlined, size: 18),
                          label: const Text('Edit'),
                        ),
                        TextButton.icon(
                          onPressed: () => _callFunction(
                            'reenrichNote',
                            {'noteId': widget.noteId},
                            'AI summary refreshed',
                          ),
                          icon:
                              const Icon(Icons.auto_awesome_outlined, size: 18),
                          label: const Text('Re-run AI'),
                        ),
                        TextButton.icon(
                          onPressed: () =>
                              _showShareDialog(widget.noteId, data),
                          icon: const Icon(Icons.share_outlined, size: 18),
                          label: const Text('Share'),
                        ),
                      ],
                    ],
                  ),
                  // AI summary card
                  if (summary.isNotEmpty) ...[
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: Colors.deepPurple.shade50,
                        borderRadius: BorderRadius.circular(12),
                        border:
                            Border.all(color: Colors.deepPurple.shade100),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: const [
                              Icon(Icons.auto_awesome,
                                  size: 16, color: Colors.deepPurple),
                              SizedBox(width: 6),
                              Text(
                                'AI Summary',
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: Colors.deepPurple,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          Text(summary,
                              style: const TextStyle(
                                  fontSize: 15, height: 1.5)),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
                  // Action items card
                  if (actionItems.isNotEmpty) ...[
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: Colors.amber.shade50,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.amber.shade200),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: const [
                              Icon(Icons.checklist_rounded,
                                  size: 16, color: Colors.brown),
                              SizedBox(width: 6),
                              Text(
                                'Action Items',
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: Colors.brown,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          for (final item in actionItems)
                            Padding(
                              padding:
                                  const EdgeInsets.symmetric(vertical: 3),
                              child: Row(
                                crossAxisAlignment:
                                    CrossAxisAlignment.start,
                                children: [
                                  const Text('•  ',
                                      style: TextStyle(fontSize: 15)),
                                  Expanded(
                                    child: Text(item,
                                        style: const TextStyle(
                                            fontSize: 15, height: 1.4)),
                                  ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
                  const Text(
                    'Transcript',
                    style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: Colors.black54),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    transcript.isEmpty ? '(No transcript text)' : transcript,
                    style: const TextStyle(fontSize: 16, height: 1.5),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}
