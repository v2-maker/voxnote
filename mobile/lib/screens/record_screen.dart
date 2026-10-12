import 'dart:async';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';
import '../services/auth_service.dart';
import '../services/note_service.dart';

class RecordScreen extends StatefulWidget {
  const RecordScreen({super.key});

  @override
  State<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends State<RecordScreen> with SingleTickerProviderStateMixin {
  late final AudioRecorder _audioRecorder;
  final NoteService _noteService = NoteService();
  final AuthService _authService = AuthService();

  bool _isRecording = false;
  bool _hasRecordedFile = false;
  String? _recordedFilePath;
  int _recordingDurationSeconds = 0;
  Timer? _timer;
  late AnimationController _pulseController;
  late Animation<double> _pulseAnimation;
  String? _statusMessage;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _audioRecorder = AudioRecorder();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    )..repeat(reverse: true);
    _pulseAnimation = Tween<double>(begin: 1.0, end: 1.15).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pulseController.dispose();
    _audioRecorder.dispose();
    super.dispose();
  }

  Future<void> _checkAndStartRecording() async {
    // 1. Check microphone permission
    PermissionStatus status = await Permission.microphone.status;
    if (status.isDenied || status.isRestricted) {
      status = await Permission.microphone.request();
    }

    if (status.isPermanentlyDenied) {
      _showPermissionDeniedDialog();
      return;
    }

    if (!status.isGranted) {
      setState(() {
        _statusMessage = 'Microphone permission is required to record notes.';
      });
      return;
    }

    try {
      // 2. Prepare file path
      final Directory appDir = await getApplicationDocumentsDirectory();
      final String filePath = '${appDir.path}/voxnote_${DateTime.now().millisecondsSinceEpoch}.m4a';

      // 3. Start recording configured for Cloud STT v2 (Mono, 16kHz, AAC)
      await _audioRecorder.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          sampleRate: 16000,
          numChannels: 1,
        ),
        path: filePath,
      );

      setState(() {
        _isRecording = true;
        _hasRecordedFile = false;
        _recordedFilePath = filePath;
        _recordingDurationSeconds = 0;
        _statusMessage = null;
      });

      _startTimer();
    } catch (e) {
      setState(() {
        _statusMessage = 'Failed to start recording: $e';
      });
    }
  }

  void _startTimer() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      setState(() {
        _recordingDurationSeconds++;
      });
    });
  }

  Future<void> _stopRecording() async {
    _timer?.cancel();
    try {
      final String? path = await _audioRecorder.stop();
      setState(() {
        _isRecording = false;
        _hasRecordedFile = true;
        if (path != null) {
          _recordedFilePath = path;
        }
        _statusMessage = 'Recording stopped. Review and save.';
      });
    } catch (e) {
      setState(() {
        _statusMessage = 'Failed to stop recording: $e';
      });
    }
  }

  Future<void> _saveRecording() async {
    if (_recordedFilePath == null) return;

    setState(() {
      _isLoading = true;
      _statusMessage = 'Uploading note to cloud...';
    });

    try {
      await _noteService.uploadAndCreateNote(
        localFilePath: _recordedFilePath!,
        durationSeconds: _recordingDurationSeconds,
      );
      setState(() {
        _statusMessage = 'Note saved & uploading for transcription!';
        _hasRecordedFile = false;
        _recordedFilePath = null;
        _recordingDurationSeconds = 0;
      });
    } catch (e) {
      setState(() {
        _statusMessage = 'Upload failed: $e';
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _discardRecording() async {
    await _noteService.discardNote(localFilePath: _recordedFilePath);
    setState(() {
      _hasRecordedFile = false;
      _recordedFilePath = null;
      _recordingDurationSeconds = 0;
      _statusMessage = 'Recording discarded.';
    });
  }

  void _showPermissionDeniedDialog() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Microphone Permission Required'),
        content: const Text(
          'VoxNote needs microphone access to record voice notes. Please enable microphone permissions in your device settings.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              Navigator.pop(context);
              openAppSettings();
            },
            child: const Text('Open Settings'),
          ),
        ],
      ),
    );
  }

  String _formatTimer(int totalSeconds) {
    final int minutes = totalSeconds ~/ 60;
    final int seconds = totalSeconds % 60;
    return '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('VoxNote'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign Out',
            onPressed: () async => await _authService.signOut(),
          ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Spacer(),
              // Title / Tagline
              const Text(
                'Think it, say it — it\'s everywhere.',
                style: TextStyle(fontSize: 16, color: Colors.black54, fontWeight: FontWeight.w500),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              // Phase 4: multilingual transcription indicator
              const Text(
                '🎙 English + 中文 · language auto-detect',
                style: TextStyle(fontSize: 12, color: Colors.black45),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 48),
              // Timer Display
              Text(
                _formatTimer(_recordingDurationSeconds),
                style: const TextStyle(
                  fontSize: 56,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 2.0,
                  color: Colors.black87,
                ),
              ),
              const SizedBox(height: 12),
              // Status indicator
              if (_statusMessage != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16.0),
                  child: Text(
                    _statusMessage!,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: _statusMessage!.contains('failed') || _statusMessage!.contains('required')
                          ? Colors.red.shade700
                          : Colors.deepPurple,
                      fontSize: 14,
                    ),
                  ),
                ),
              const Spacer(),
              // Interactive Controls
              if (_isLoading)
                const CircularProgressIndicator(color: Colors.deepPurple)
              else if (!_hasRecordedFile) ...[
                // Record / Stop Button with Pulse Animation
                ScaleTransition(
                  scale: _isRecording ? _pulseAnimation : const AlwaysStoppedAnimation(1.0),
                  child: GestureDetector(
                    onTap: _isRecording ? _stopRecording : _checkAndStartRecording,
                    child: Container(
                      height: 100,
                      width: 100,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: _isRecording ? Colors.red.shade600 : Colors.deepPurple,
                        boxShadow: [
                          BoxShadow(
                            color: (_isRecording ? Colors.red : Colors.deepPurple).withOpacity(0.4),
                            blurRadius: 20,
                            spreadRadius: 5,
                          ),
                        ],
                      ),
                      child: Icon(
                        _isRecording ? Icons.stop_rounded : Icons.mic_rounded,
                        size: 50,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  _isRecording ? 'Tap to Stop Recording' : 'Tap to Record Note',
                  style: const TextStyle(fontSize: 14, color: Colors.black54),
                ),
              ] else ...[
                // Review Actions: Save or Discard
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _discardRecording,
                        icon: const Icon(Icons.delete_outline, color: Colors.red),
                        label: const Text('Discard', style: TextStyle(color: Colors.red)),
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          side: BorderSide(color: Colors.red.shade200),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: ElevatedButton.icon(
                        onPressed: _saveRecording,
                        icon: const Icon(Icons.cloud_upload_rounded, color: Colors.white),
                        label: const Text('Save Note', style: TextStyle(color: Colors.white)),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.deepPurple,
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          elevation: 2,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 32),
            ],
          ),
        ),
      ),
    );
  }
}
