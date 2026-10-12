'use client';

import { useAuth } from '@/lib/auth-context';
import { db, storage, functions } from '@/lib/firebase';
import { doc, onSnapshot, Timestamp, DocumentData, writeBatch, arrayUnion, arrayRemove, serverTimestamp } from 'firebase/firestore';
import { ref, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

function formatDate(ts?: Timestamp): string {
  if (!ts) return '';
  return ts.toDate().toLocaleString();
}

export default function NoteDetailPage() {
  const { user, loading: authLoading } = useAuth();
  const params = useParams();
  const router = useRouter();
  const noteId = params.noteId as string;

  const [note, setNote] = useState<DocumentData | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [working, setWorking] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !noteId) return;
    const noteRef = doc(db, 'users', user.uid, 'notes', noteId);
    const unsub = onSnapshot(
      noteRef,
      async (snap) => {
        if (!snap.exists()) {
          setError('Note not found.');
          return;
        }
        const data = snap.data();
        setNote(data);
        const audioPath = data.audioStoragePath as string | undefined;
        if (audioPath && !audioUrl) {
          try {
            const url = await getDownloadURL(ref(storage, audioPath));
            setAudioUrl(url);
          } catch (e: any) {
            setError(`Could not load audio: ${e.message}`);
          }
        }
      },
      (err) => setError(err.message)
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, noteId]);

  const runCallable = async (name: string, payload: object, okMsg: string) => {
    setWorking(true);
    setError(null);
    try {
      await httpsCallable(functions, name)(payload);
    } catch (e: any) {
      setError(e.message || 'Something went wrong');
    } finally {
      setWorking(false);
    }
  };

  const saveEdit = async () => {
    const text = draft.trim();
    if (!text) return;
    await runCallable('updateTranscript', { noteId, transcript: text }, 'saved');
    setEditing(false);
  };

  // Phase 3.1: shareable web links (256-bit random tokens as doc IDs).
  const shareLink = (token: string) =>
    typeof window !== 'undefined' ? `${window.location.origin}/s/${token}` : `/s/${token}`;

  const createShare = async () => {
    if (!user) return;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    setWorking(true);
    setError(null);
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'shares', token), {
        token,
        userId: user.uid,
        noteId,
        title: note?.title || 'Voice Note',
        transcript: note?.transcript || '',
        summary: note?.summary || '',
        actionItems: note?.actionItems || [],
        revoked: false,
        createdAt: serverTimestamp(),
      });
      batch.update(doc(db, 'users', user.uid, 'notes', noteId), {
        shareTokens: arrayUnion(token),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (e: any) {
      setError(e.message || 'Could not create share link');
    } finally {
      setWorking(false);
    }
  };

  const revokeShare = async (token: string) => {
    if (!user) return;
    setWorking(true);
    setError(null);
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'shares', token));
      batch.update(doc(db, 'users', user.uid, 'notes', noteId), {
        shareTokens: arrayRemove(token),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (e: any) {
      setError(e.message || 'Could not revoke share link');
    } finally {
      setWorking(false);
    }
  };

  const copyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareLink(token));
      setCopied(token);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  if (!user) {
    router.push('/');
    return null;
  }

  const status = note?.status as string | undefined;
  const summary = (note?.summary as string) || '';
  const actionItems = (note?.actionItems as string[]) || [];
  const edited = note?.edited === true;
  const shareTokens = (note?.shareTokens as string[]) || [];

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-3xl mx-auto p-8">
        <button
          onClick={() => router.push('/')}
          className="mb-6 text-sm font-medium text-purple-600 hover:text-purple-800"
        >
          &larr; All notes
        </button>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
            {error}
          </div>
        )}

        {!note ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-purple-600"></div>
          </div>
        ) : (
          <article className="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
            <div className="flex items-start justify-between gap-4 mb-2">
              <h1 className="text-2xl font-bold">{note.title || 'Voice Note'}</h1>
              {edited && (
                <span className="shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                  Edited
                </span>
              )}
            </div>
            <p className="text-sm text-gray-400 mb-6">{formatDate(note.createdAt)}</p>

            {audioUrl && (
              <div className="mb-6">
                <audio controls src={audioUrl} className="w-full" />
              </div>
            )}

            {status === 'uploading' || status === 'transcribing' ? (
              <div className="flex items-center gap-3 py-8 justify-center text-gray-500">
                <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-purple-600"></div>
                <span>Transcribing your note… it will appear here automatically.</span>
              </div>
            ) : status === 'failed' ? (
              <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
                Transcription failed for this note. Your audio recording is still saved.
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-end gap-2 mb-4">
                  <button
                    disabled={working}
                    onClick={() => {
                      setDraft(note.transcript || '');
                      setEditing(true);
                    }}
                    className="text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-50"
                  >
                    Edit transcript
                  </button>
                  <button
                    disabled={working}
                    onClick={() => runCallable('reenrichNote', { noteId }, 'AI summary refreshed')}
                    className="text-sm font-medium text-purple-600 hover:text-purple-800 px-3 py-1.5 rounded-lg border border-purple-200 disabled:opacity-50"
                  >
                    {working ? 'Working…' : '✨ Re-run AI'}
                  </button>
                  <button
                    onClick={() => setShowShare((v) => !v)}
                    className="text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-lg border border-gray-200"
                  >
                    🔗 Share
                  </button>
                </div>

                {showShare && (
                  <div className="mb-5 p-5 rounded-xl bg-gray-50 border border-gray-200">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
                      Share links — anyone with a link can view this note
                    </h2>
                    {shareTokens.length === 0 && (
                      <p className="text-sm text-gray-500 mb-3">No share links yet.</p>
                    )}
                    <div className="space-y-2 mb-3">
                      {shareTokens.map((token) => (
                        <div key={token} className="flex items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2">
                          <code className="flex-1 text-xs truncate text-gray-600">
                            {shareLink(token)}
                          </code>
                          <button
                            onClick={() => copyLink(token)}
                            className="text-xs font-medium text-purple-600 hover:text-purple-800 px-2 py-1"
                          >
                            {copied === token ? 'Copied!' : 'Copy'}
                          </button>
                          <button
                            disabled={working}
                            onClick={() => revokeShare(token)}
                            className="text-xs font-medium text-red-600 hover:text-red-800 px-2 py-1 disabled:opacity-50"
                          >
                            Revoke
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      disabled={working}
                      onClick={createShare}
                      className="text-sm font-medium text-white bg-gray-900 hover:bg-gray-700 px-4 py-2 rounded-lg disabled:opacity-50"
                    >
                      {working ? 'Working…' : 'Create new link'}
                    </button>
                  </div>
                )}

                {summary && (
                  <div className="mb-5 p-5 rounded-xl bg-purple-50 border border-purple-100">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-600 mb-2">
                      ✨ AI Summary
                    </h2>
                    <p className="text-base leading-relaxed">{summary}</p>
                  </div>
                )}

                {actionItems.length > 0 && (
                  <div className="mb-5 p-5 rounded-xl bg-amber-50 border border-amber-200">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">
                      Action Items
                    </h2>
                    <ul className="space-y-1.5">
                      {actionItems.map((item, i) => (
                        <li key={i} className="text-base flex gap-2">
                          <span>•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
                  Transcript
                </h2>
                {editing ? (
                  <div>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={10}
                      className="w-full p-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500 text-base leading-relaxed"
                    />
                    <div className="flex justify-end gap-2 mt-3">
                      <button
                        onClick={() => setEditing(false)}
                        className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg"
                      >
                        Cancel
                      </button>
                      <button
                        disabled={working || !draft.trim()}
                        onClick={saveEdit}
                        className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg disabled:opacity-50"
                      >
                        {working ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-base leading-relaxed whitespace-pre-wrap">
                    {note.transcript || '(No transcript text)'}
                  </p>
                )}
              </div>
            )}
          </article>
        )}
      </div>
    </main>
  );
}
