'use client';

import { useAuth } from '@/lib/auth-context';
import { db, functions } from '@/lib/firebase';
import {
  collection,
  query,
  orderBy,
  where,
  onSnapshot,
  QueryDocumentSnapshot,
  DocumentData,
  Timestamp,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Note extends DocumentData {
  id: string;
  title?: string;
  transcript?: string;
  status?: string;
  createdAt?: Timestamp;
  score?: number;
}

function formatDate(ts?: Timestamp): string {
  if (!ts) return '';
  const dt = ts.toDate();
  const now = new Date();
  const sameDay =
    dt.getFullYear() === now.getFullYear() &&
    dt.getMonth() === now.getMonth() &&
    dt.getDate() === now.getDate();
  const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  return `${dt.toLocaleDateString()} ${time}`;
}

function statusStyle(status?: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-orange-100 text-orange-700';
  }
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'uploading':
      return 'Uploading…';
    case 'transcribing':
      return 'Transcribing…';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    default:
      return status ?? '';
  }
}

function SignInCard() {
  const { signInWithGoogle } = useAuth();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const handleSignIn = async () => {
    setErrorMsg(null);
    setIsSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to sign in with Google');
    } finally {
      setIsSigningIn(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-gray-100 p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-purple-100 text-purple-600 mb-6">
          <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 mb-2">VoxNote</h1>
        <p className="text-gray-500 mb-8">Think it, say it &mdash; it&apos;s everywhere.</p>
        {errorMsg && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
            {errorMsg}
          </div>
        )}
        <button
          onClick={handleSignIn}
          disabled={isSigningIn}
          className="w-full flex items-center justify-center gap-3 py-3 px-4 border border-gray-300 rounded-xl shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-all disabled:opacity-50"
        >
          {isSigningIn ? 'Signing in...' : 'Sign in with Google'}
        </button>
      </div>
    </main>
  );
}

export default function DashboardPage() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  // Phase 2.2: semantic search state
  const [useSemantic, setUseSemantic] = useState(false);
  const [semanticResults, setSemanticResults] = useState<Note[] | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);

  // Keyword search (realtime listener)
  useEffect(() => {
    if (!user || useSemantic) {
      if (!useSemantic) setNotes([]);
      return;
    }
    const notesRef = collection(db, 'users', user.uid, 'notes');
    const q =
      search.trim().length > 0
        ? query(
            notesRef,
            where('keywords', 'array-contains', search.trim().toLowerCase()),
            orderBy('createdAt', 'desc')
          )
        : query(notesRef, orderBy('createdAt', 'desc'));

    const unsub = onSnapshot(
      q,
      (snap) => {
        setListError(null);
        setNotes(
          snap.docs.map(
            (d: QueryDocumentSnapshot<DocumentData>) =>
              ({ id: d.id, ...d.data() } as Note)
          )
        );
      },
      (err) => setListError(err.message)
    );
    return () => unsub();
  }, [user, search, useSemantic]);

  // Semantic search (debounced callable)
  useEffect(() => {
    if (!useSemantic || !user || search.trim().length === 0) {
      setSemanticResults(null);
      return;
    }
    setSemanticLoading(true);
    const t = setTimeout(async () => {
      try {
        const call = httpsCallable(functions, 'semanticSearch');
        const res: any = await call({ query: search.trim(), limit: 10 });
        setListError(null);
        setSemanticResults(res.data.results as Note[]);
      } catch (e: any) {
        setListError(e.message || 'Semantic search failed');
        setSemanticResults([]);
      } finally {
        setSemanticLoading(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [useSemantic, user, search]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  if (!user) return <SignInCard />;

  const visibleNotes = useSemantic && search.trim() ? semanticResults ?? [] : notes;
  const isSearching = useSemantic && search.trim().length > 0;

  return (
    <main className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-purple-600 flex items-center justify-center text-white font-bold">
            V
          </div>
          <div>
            <h1 className="text-lg font-bold">VoxNote</h1>
            <p className="text-xs text-gray-500">Think it, say it &mdash; it&apos;s everywhere.</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-semibold text-gray-800">{user.displayName || 'User'}</p>
            <p className="text-xs text-gray-500">{user.email}</p>
          </div>
          <button
            onClick={() => signOut()}
            className="px-4 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors border border-red-200"
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="flex-1 max-w-4xl w-full mx-auto p-8">
        <div className="mb-6 flex gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={useSemantic ? 'Ask about your notes…' : 'Search your notes…'}
            className="flex-1 px-4 py-3 rounded-xl border border-gray-200 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
            onClick={() => setUseSemantic((v) => !v)}
            title="Toggle AI semantic search"
            className={`px-4 py-3 rounded-xl text-sm font-semibold border transition-colors ${
              useSemantic
                ? 'bg-purple-600 text-white border-purple-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-purple-300'
            }`}
          >
            ✨ AI search {useSemantic ? 'on' : 'off'}
          </button>
        </div>

        {listError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
            {listError}
          </div>
        )}

        {isSearching && semanticLoading && (
          <div className="flex items-center justify-center gap-3 py-10 text-gray-500">
            <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-purple-600"></div>
            <span className="text-sm">Thinking…</span>
          </div>
        )}

        {!(isSearching && semanticLoading) && visibleNotes.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <p className="text-lg font-medium mb-2">
              {search ? 'No notes match your search.' : 'No notes yet.'}
            </p>
            <p className="text-sm">
              {search ? 'Try a different keyword.' : 'Record your first voice note on the mobile app.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleNotes.map((note) => (
              <button
                key={note.id}
                onClick={() => router.push(`/notes/${note.id}`)}
                className="w-full text-left bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md hover:border-purple-200 transition-all"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate">
                      {note.title || 'Voice Note'}
                    </h3>
                    {note.transcript && (
                      <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                        {note.transcript}
                      </p>
                    )}
                    <p className="text-xs text-gray-400 mt-2">{formatDate(note.createdAt)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <span
                      className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statusStyle(note.status)}`}
                    >
                      {statusLabel(note.status)}
                    </span>
                    {typeof note.score === 'number' && (
                      <span className="text-xs font-medium text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">
                        {Math.round(note.score * 100)}% match
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
