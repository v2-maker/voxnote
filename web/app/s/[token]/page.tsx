'use client';

import { db } from '@/lib/firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface SharedNote {
  title?: string;
  transcript?: string;
  summary?: string;
  actionItems?: string[];
  createdAt?: Timestamp;
}

function formatDate(ts?: Timestamp): string {
  if (!ts) return '';
  return ts.toDate().toLocaleString();
}

/**
 * Phase 3.1: public read-only page for a shared note.
 * No sign-in required — the token in the URL is the capability.
 * Invalid, revoked, or missing links show a dead-link state.
 */
export default function SharedNotePage() {
  const params = useParams();
  const token = params.token as string;
  const [share, setShare] = useState<SharedNote | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'invalid'>('loading');

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    getDoc(doc(db, 'shares', token))
      .then((snap) => {
        if (snap.exists()) {
          setShare(snap.data() as SharedNote);
          setState('ok');
        } else {
          setState('invalid');
        }
      })
      .catch(() => setState('invalid'));
  }, [token]);

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-purple-600 flex items-center justify-center text-white font-bold">
          V
        </div>
        <div>
          <h1 className="text-lg font-bold">VoxNote</h1>
          <p className="text-xs text-gray-500">Shared note</p>
        </div>
      </header>

      <div className="max-w-3xl mx-auto p-8">
        {state === 'loading' && (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-purple-600"></div>
          </div>
        )}

        {state === 'invalid' && (
          <div className="text-center py-20">
            <p className="text-xl font-semibold mb-2">This link doesn&apos;t work anymore.</p>
            <p className="text-gray-500 text-sm">
              It may have been revoked, or the note was deleted.
            </p>
          </div>
        )}

        {state === 'ok' && share && (
          <article className="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
            <h1 className="text-2xl font-bold mb-2">{share.title || 'Shared note'}</h1>
            <p className="text-sm text-gray-400 mb-6">{formatDate(share.createdAt)}</p>

            {share.summary && (
              <div className="mb-5 p-5 rounded-xl bg-purple-50 border border-purple-100">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-600 mb-2">
                  ✨ AI Summary
                </h2>
                <p className="text-base leading-relaxed">{share.summary}</p>
              </div>
            )}

            {share.actionItems && share.actionItems.length > 0 && (
              <div className="mb-5 p-5 rounded-xl bg-amber-50 border border-amber-200">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">
                  Action Items
                </h2>
                <ul className="space-y-1.5">
                  {share.actionItems.map((item, i) => (
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
            <p className="text-base leading-relaxed whitespace-pre-wrap">
              {share.transcript || '(No transcript text)'}
            </p>

            <div className="mt-8 pt-6 border-t border-gray-100 text-center">
              <p className="text-xs text-gray-400">
                Shared via VoxNote — think it, say it, it&apos;s everywhere.
              </p>
            </div>
          </article>
        )}
      </div>
    </main>
  );
}
