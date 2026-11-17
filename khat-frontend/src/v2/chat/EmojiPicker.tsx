import { useState } from 'react';

const GROUPS: { key: string; icon: string; label: string; list: string[] }[] = [
  { key: 'recent', icon: '🕘', label: 'Often used', list: ['👍', '🙏', '🤲', '✍️', '👏', '🌟', '✅', '❤️', '😊', '💯', '📜', '🖋️'] },
  { key: 'smile', icon: '😊', label: 'Smileys', list: ['😊', '😀', '😃', '😄', '😁', '🙂', '😉', '😍', '🥰', '😇', '🤩', '😌', '🤔', '😮', '😅', '😂', '🙃', '😐', '😔', '😢', '😟', '😴', '🤗', '🫡'] },
  { key: 'hands', icon: '👍', label: 'Hands', list: ['👍', '👎', '👌', '✌️', '🤞', '👏', '🙌', '🙏', '🤲', '✋', '👋', '🤝', '✍️', '💪', '☝️', '👆', '👇', '👉', '👈', '🫶'] },
  { key: 'study', icon: '🖋️', label: 'Study', list: ['✍️', '🖋️', '🖊️', '✒️', '📜', '📖', '📚', '📝', '📏', '📐', '🎨', '🖌️', '📷', '📎', '📌', '🗓️', '⏰', '🏫', '🎓', '🏆', '🥇', '🎖️', '🏅', '🔖'] },
  { key: 'symbols', icon: '❤️', label: 'Symbols', list: ['❤️', '💚', '💙', '🤍', '✨', '🌟', '⭐', '💫', '🌙', '🌸', '🌹', '🌿', '✅', '☑️', '✔️', '❗', '❓', '💯', '🔁', '➡️', '⬅️', '⬆️', '⬇️', '🔔'] },
];

/** A small WhatsApp-like emoji panel (no library): category tabs + grid. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [group, setGroup] = useState(GROUPS[0].key);
  const current = GROUPS.find(g => g.key === group) ?? GROUPS[0];
  return (
    <div className="v3ch-emoji" role="dialog" aria-label="Emoji">
      <div className="v3ch-emoji-tabs" role="tablist">
        {GROUPS.map(g => (
          <button key={g.key} type="button" role="tab" aria-selected={g.key === group} aria-label={g.label} className={g.key === group ? 'is-active' : ''} onClick={() => setGroup(g.key)}>{g.icon}</button>
        ))}
      </div>
      <p className="v3ch-emoji-title">{current.label}</p>
      <div className="v3ch-emoji-grid">
        {current.list.map((e, i) => <button key={`${e}-${i}`} type="button" onClick={() => onPick(e)} aria-label={`Insert ${e}`}>{e}</button>)}
      </div>
    </div>
  );
}
