import React, { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, Loader2, BookOpen } from 'lucide-react';
import api from '../../services/api';

interface Citation {
  citation_id: number;
  excerpt: string;
  segment_id: number;
}

interface Message {
  message_id: number;
  role: 'user' | 'assistant';
  message_text: string;
  citations?: Citation[];
  created_at?: string;
}

interface AIChatPanelProps {
  documentId?: number;
  s3Key?: string;
  onClose?: () => void;
}

export function AIChatPanel({ documentId, s3Key, onClose }: AIChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      message_id: 0,
      role: 'assistant',
      message_text: 'Hello! I am your AI assistant. You can ask me questions about this document or general academic topics.',
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    const question = input.trim();
    if (!question) return;

    // Add user message to UI immediately
    const userMsg: Message = { message_id: Date.now(), role: 'user', message_text: question };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res: any = await api.post('/chat/ask', {
        question,
        s3Key,
        sessionId
      });

      if (res.success && res.data) {
        if (!sessionId && res.data.sessionId) setSessionId(res.data.sessionId);
        
        const aiMsg: Message = {
          message_id: res.data.messageId || Date.now() + 1,
          role: 'assistant',
          message_text: res.data.answer,
          citations: res.data.citations || []
        };
        setMessages(prev => [...prev, aiMsg]);
      } else {
        throw new Error(res.message || 'Failed to get answer');
      }
    } catch (err: any) {
      console.error(err);
      setMessages(prev => [...prev, {
        message_id: Date.now() + 2,
        role: 'assistant',
        message_text: 'Sorry, an error occurred while processing your question: ' + (err.message || 'Unknown error')
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 overflow-hidden shadow-lg" style={{ maxHeight: 'calc(100vh - 100px)' }}>
      <div className="bg-blue-600 text-white p-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Bot size={24} />
          <h3 className="font-semibold text-lg m-0 p-0 text-white">EduMate AI</h3>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-blue-100 hover:text-white transition-colors">
            Close
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6 bg-gray-50">
        {messages.map((msg) => (
          <div key={msg.message_id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`flex gap-3 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                msg.role === 'user' ? 'bg-blue-100 text-blue-600' : 'bg-green-100 text-green-600'
              }`}>
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              
              <div className="flex flex-col gap-1">
                <div className={`p-3 rounded-2xl ${
                  msg.role === 'user' 
                    ? 'bg-blue-600 text-white rounded-tr-none' 
                    : 'bg-white border border-gray-200 text-gray-800 rounded-tl-none shadow-sm'
                }`}>
                  <p className="whitespace-pre-wrap leading-relaxed text-sm">{msg.message_text}</p>
                </div>
                
                {/* Citations / Sources */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                      <BookOpen size={12} /> Sources used
                    </p>
                    {msg.citations.map(cit => (
                      <div key={cit.citation_id} className="bg-white border border-gray-200 p-2 rounded text-xs text-gray-600 leading-snug">
                        <span className="font-semibold text-gray-800 mr-1">Excrept:</span> 
                        "{cit.excerpt}"
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="flex gap-3 max-w-[80%]">
              <div className="shrink-0 w-8 h-8 rounded-full bg-green-100 text-green-600 flex items-center justify-center">
                <Bot size={16} />
              </div>
              <div className="p-4 rounded-2xl bg-white border border-gray-200 text-gray-800 rounded-tl-none shadow-sm flex items-center gap-2">
                <Loader2 className="animate-spin text-blue-600" size={16} />
                <span className="text-sm text-gray-500">EduMate AI is thinking...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 bg-white border-t border-gray-200 shrink-0">
        <div className="relative flex items-center">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about this document..."
            className="w-full bg-gray-50 border border-gray-200 rounded-xl pr-12 pl-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white resize-none"
            rows={1}
            style={{ minHeight: '50px', maxHeight: '120px' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="absolute right-2 p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-center text-[10px] text-gray-400 mt-2">
          AI can make mistakes. Consider verifying important information.
        </p>
      </div>
    </div>
  );
}
