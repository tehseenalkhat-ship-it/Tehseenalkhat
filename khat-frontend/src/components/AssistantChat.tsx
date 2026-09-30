import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowRight, BookOpen, Check, GraduationCap, HelpCircle, LoaderCircle, MessageCircle, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { apiFetch, ApiError, type SessionUser } from '@/api';
import './AssistantChat.css';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

function renderMessageText(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\n)/g).map((part, index) => {
    if (part === '\n') return <br key={index} />;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

const WELCOME: ChatMessage = {
  role: 'assistant',
  content: 'Hello! I can help you find your way around the Calligraphy Studio, understand your learning path, or answer questions about reviews and events. What can I help with?',
};

export function AssistantChat({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isStudent = user.role === 'student';
  const displayName = user.name.split(' ')[0] || 'there';

  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      window.setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [open, messages, sending]);

  const reset = () => {
    setMessages([WELCOME]);
    setDraft('');
    setError(null);
  };

  const sendMessage = async (event?: FormEvent, suggestedText?: string) => {
    event?.preventDefault();
    const content = (suggestedText ?? draft).trim();
    if (!content || sending) return;
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(nextMessages);
    setDraft('');
    setError(null);
    setSending(true);
    try {
      const result = await apiFetch<{ answer: string }>('/assistant/chat', {
        method: 'POST',
        body: { messages: nextMessages.slice(-12) },
      });
      setMessages(current => [...current, { role: 'assistant', content: result.answer }]);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'The assistant could not respond right now. Please try again.';
      setError(message);
      setMessages(current => current.slice(0, -1));
      setDraft(content);
    } finally {
      setSending(false);
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const suggestions = isStudent
    ? [
      { label: 'Help me choose a course', icon: GraduationCap },
      { label: 'Where do I find my next lesson?', icon: BookOpen },
      { label: 'How do checkpoints work?', icon: HelpCircle },
    ]
    : [
      { label: 'How do I review a student submission?', icon: Check },
      { label: 'How do I host a live event?', icon: MessageCircle },
      { label: 'Where can I see my assignments?', icon: BookOpen },
    ];

  return (
    <div className="assistant-chat-root">
      {open && (
        <section className="assistant-chat-panel" role="dialog" aria-modal="false" aria-labelledby="assistant-chat-title">
          <header className="assistant-chat-header">
            <span className="assistant-chat-avatar"><Sparkles size={17} /></span>
            <div className="assistant-chat-title-copy">
              <strong id="assistant-chat-title">Guild Guide</strong>
              <span>Here to help, {displayName}</span>
            </div>
            <button type="button" className="assistant-chat-icon-button" onClick={reset} aria-label="Start a new conversation" title="New conversation"><RotateCcw size={16} /></button>
            <button type="button" className="assistant-chat-icon-button" onClick={() => setOpen(false)} aria-label="Close assistant"><X size={19} /></button>
          </header>

          <div className="assistant-chat-messages" aria-live="polite" aria-label="Chat messages">
            {messages.map((message, index) => (
              <article className={`assistant-chat-message ${message.role}`} key={`${index}-${message.role}`}>
                {message.role === 'assistant' && <span className="assistant-message-mark"><Sparkles size={13} /></span>}
                <p>{renderMessageText(message.content)}</p>
              </article>
            ))}
            {messages.length === 1 && !sending && (
              <div className="assistant-chat-suggestions">
                <span>Try asking</span>
                {suggestions.map(({ label, icon: Icon }) => (
                  <button type="button" key={label} onClick={() => void sendMessage(undefined, label)}><Icon size={14} />{label}<ArrowRight size={13} /></button>
                ))}
              </div>
            )}
            {sending && <div className="assistant-chat-thinking"><LoaderCircle size={15} className="assistant-spin" /> Thinking…</div>}
            <div ref={endRef} />
          </div>

          {error && <p className="assistant-chat-error" role="alert">{error}</p>}
          <form className="assistant-chat-composer" onSubmit={event => void sendMessage(event)}>
            <textarea
              ref={inputRef}
              value={draft}
              onChange={event => setDraft(event.currentTarget.value)}
              onKeyDown={onInputKeyDown}
              placeholder={isStudent ? 'Ask about courses, lessons, checkpoints…' : 'Ask about your teaching workspace…'}
              rows={1}
              maxLength={2000}
              aria-label="Message Guild Guide"
              disabled={sending}
            />
            <button type="submit" disabled={sending || !draft.trim()} aria-label="Send message"><Send size={17} /></button>
            <small>Enter to send · Shift+Enter for a new line</small>
          </form>
        </section>
      )}
      <button
        type="button"
        className={`assistant-chat-launcher${open ? ' is-open' : ''}`}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={open ? 'Close Guild Guide' : 'Open Guild Guide assistant'}
      >
        {open ? <ArrowDown size={19} /> : <><MessageCircle size={19} /><span>Ask Guild Guide</span></>}
      </button>
    </div>
  );
}
