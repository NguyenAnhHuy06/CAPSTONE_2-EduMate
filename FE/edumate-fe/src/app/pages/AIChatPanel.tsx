import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Loader2, Minus, X, MessageCircle } from 'lucide-react';
import api from '../../services/api';

interface Message {
  message_id: number;
  role: 'user' | 'assistant';
  message_text: string;
  created_at?: string;
}

interface AIChatPanelProps {
  documentId?: number;
  s3Key?: string;
  pdfPage?: number;
  pdfTotalPages?: number;
  documentTitle?: string;
  onClose?: () => void;
  floating?: boolean;
}

export function AIChatPanel({
  documentId,
  s3Key,
  pdfPage,
  pdfTotalPages,
  documentTitle,
  onClose,
  floating = true,
}: AIChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      message_id: 0,
      role: 'assistant',
      message_text:
        'Hello! I am your EduMate assistant. Ask me anything about this document.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prepareStartedRef = useRef(false);

  const scrollMessagesToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useEffect(() => {
    if (!minimized) scrollMessagesToBottom();
  }, [messages, isLoading, minimized]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 88)}px`;
  }, [input]);

  /** Index/embed in background when panel opens — first question is faster. */
  useEffect(() => {
    const hasDoc =
      (s3Key != null && String(s3Key).trim() !== '') ||
      (documentId != null && Number.isFinite(Number(documentId)));
    if (!hasDoc || prepareStartedRef.current) return;

    prepareStartedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const payload: Record<string, unknown> = {};
        if (s3Key != null && String(s3Key).trim() !== '') payload.s3Key = s3Key;
        if (documentId != null && Number.isFinite(Number(documentId))) {
          payload.documentId = Number(documentId);
        }
        await api.post('/chat/prepare', payload);
      } catch {
        /* silent — indexing still runs on first question if needed */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [s3Key, documentId]);

  const handleSend = async () => {
    const question = input.trim();
    if (!question || isLoading) return;

    const userMsg: Message = { message_id: Date.now(), role: 'user', message_text: question };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    setMinimized(false);

    try {
      const payload: Record<string, unknown> = { question, sessionId };
      if (s3Key != null && String(s3Key).trim() !== '') payload.s3Key = s3Key;
      if (documentId != null && Number.isFinite(Number(documentId)))
        payload.documentId = Number(documentId);
      if (
        pdfPage != null &&
        pdfTotalPages != null &&
        pdfTotalPages > 0 &&
        pdfPage >= 1 &&
        pdfPage <= pdfTotalPages
      ) {
        payload.pdfPage = pdfPage;
        payload.pdfTotalPages = pdfTotalPages;
      }

      const res: any = await api.post('/chat/ask', payload);

      if (res.success && res.data) {
        if (!sessionId && res.data.sessionId) setSessionId(res.data.sessionId);

        const contextFound = res.data.contextFound !== false;
        let answerText = res.data.answer;
        if (!contextFound && s3Key) {
          answerText +=
            '\n\n_(Note: This answer is not grounded in the open document. The file may have no extractable text or indexing failed.)_';
        }

        const aiMsg: Message = {
          message_id: res.data.messageId || Date.now() + 1,
          role: 'assistant',
          message_text: answerText,
        };
        setMessages((prev) => [...prev, aiMsg]);
      } else {
        throw new Error(res.message || 'Failed to get answer');
      }
    } catch (err: any) {
      console.error(err);
      setMessages((prev) => [
        ...prev,
        {
          message_id: Date.now() + 2,
          role: 'assistant',
          message_text:
            'Sorry, an error occurred while processing your question: ' + (err.message || 'Unknown error'),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const subtitle =
    documentTitle && documentTitle.trim()
      ? documentTitle.length > 28
        ? `${documentTitle.slice(0, 27)}…`
        : documentTitle
      : 'Ask about the document you are viewing';

  const panel = (
    <div
      role="dialog"
      aria-label="EduMate AI chat"
      className={`flex flex-col bg-white overflow-hidden border border-gray-200/80 ${
        floating
          ? 'fixed bottom-4 right-4 z-[200] rounded-2xl shadow-[0_8px_28px_rgba(0,0,0,0.18)]'
          : 'h-full rounded-lg shadow-lg'
      }`}
      style={
        floating
          ? {
              width: 'min(100vw - 2rem, 360px)',
              height: minimized ? 'auto' : 'min(420px, calc(100vh - 6rem))',
              maxHeight: minimized ? undefined : '520px',
            }
          : { maxHeight: 'calc(100vh - 100px)' }
      }
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 bg-white shrink-0">
        <div className="relative shrink-0">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white">
            <Bot size={18} />
          </div>
          <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full" />
        </div>
        <button
          type="button"
          className="flex-1 min-w-0 text-left"
          onClick={() => minimized && setMinimized(false)}
        >
          <p className="font-semibold text-[15px] text-gray-900 truncate leading-tight m-0">
            EduMate AI
          </p>
          <p className="text-xs text-gray-500 truncate m-0 mt-0.5">{subtitle}</p>
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            className="p-2 rounded-full text-blue-600 hover:bg-gray-100 transition-colors"
            aria-label={minimized ? 'Expand chat window' : 'Minimize chat window'}
            title={minimized ? 'Expand' : 'Minimize'}
          >
            <Minus size={18} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-full text-blue-600 hover:bg-gray-100 transition-colors"
              aria-label="Close chat"
              title="Close"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {!minimized && (
        <>
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-2 min-h-0 overscroll-y-contain"
            style={{ background: '#f0f2f5' }}
          >
            {messages.map((msg) => (
              <div
                key={msg.message_id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[82%] ${msg.role === 'user' ? '' : 'flex gap-1.5 items-end'}`}
                >
                  {msg.role === 'assistant' && (
                    <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white mb-0.5">
                      <Bot size={14} />
                    </div>
                  )}
                  <div>
                    <div
                      className={`px-3 py-2 text-[15px] leading-snug shadow-sm ${
                        msg.role === 'user'
                          ? 'bg-[#0084ff] text-white rounded-[18px] rounded-br-[4px]'
                          : 'bg-[#e4e6eb] text-gray-900 rounded-[18px] rounded-bl-[4px]'
                      }`}
                    >
                      <p className="whitespace-pre-wrap m-0">{msg.message_text}</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="flex gap-1.5 items-end max-w-[82%]">
                  <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white">
                    <Bot size={14} />
                  </div>
                  <div className="px-3 py-2.5 rounded-[18px] rounded-bl-[4px] bg-[#e4e6eb] shadow-sm flex items-center gap-2">
                    <Loader2 className="animate-spin text-blue-600" size={14} />
                    <span className="text-sm text-gray-600">Replying…</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 px-3 py-2 bg-white border-t border-gray-100">
            <div className="flex items-end gap-2">
              <div className="flex-1 flex items-end bg-[#f0f2f5] rounded-[20px] px-3 py-1.5 min-h-[36px]">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message..."
                  rows={1}
                  className="flex-1 bg-transparent text-[15px] text-gray-900 placeholder:text-gray-500 resize-none focus:outline-none max-h-[88px] py-1 leading-snug"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!input.trim() || isLoading}
                className="p-2 rounded-full bg-[#0084ff] text-white hover:bg-[#0073e6] disabled:opacity-40 disabled:cursor-not-allowed shrink-0 transition-colors"
                aria-label="Send"
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );

  if (floating && typeof globalThis.document !== 'undefined') {
    return createPortal(panel, globalThis.document.body);
  }

  return panel;
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

export function AIChatLauncher({
  onClick,
  unread = false,
}: {
  onClick: () => void;
  unread?: boolean;
}) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-4 right-4 z-[199] w-14 h-14 rounded-full bg-[#0084ff] text-white shadow-[0_4px_16px_rgba(0,132,255,0.45)] hover:bg-[#0073e6] flex items-center justify-center transition-transform hover:scale-105 relative"
      aria-label="Open EduMate AI chat"
      title="Chat with AI"
    >
      <MessageCircle size={26} />
      {unread && (
        <span className="absolute top-1 right-1 w-3 h-3 bg-red-500 border-2 border-white rounded-full" />
      )}
    </button>
  );

  if (typeof globalThis.document !== 'undefined') {
    return createPortal(btn, globalThis.document.body);
  }
  return btn;
}
