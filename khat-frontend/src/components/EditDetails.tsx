import { useEffect, useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { apiFetch, ApiError } from '@/api';
import { Button, Modal } from '@/components/ui';

// Pencil-to-edit rows for the Settings page, the phone field with a country picker,
// and the admin's "edit this person's details" form.

export type UserDetails = {
  id: string; role: string; name: string; email: string; phone: string | null; itsNumber: string | null;
  trNumber: string | null; branchId: string; isCoordinator: boolean; photoStorageKey: string | null;
};

// [country, dial code]. Add a line here to offer another country.
const COUNTRIES: [string, string][] = [
  ['Australia', '61'], ['Bahrain', '973'], ['Bangladesh', '880'], ['Canada', '1'], ['Egypt', '20'], ['Ethiopia', '251'],
  ['France', '33'], ['Germany', '49'], ['India', '91'], ['Indonesia', '62'], ['Iraq', '964'], ['Jordan', '962'],
  ['Kenya', '254'], ['Kuwait', '965'], ['Madagascar', '261'], ['Malaysia', '60'], ['Mauritius', '230'], ['Mozambique', '258'],
  ['Netherlands', '31'], ['New Zealand', '64'], ['Oman', '968'], ['Pakistan', '92'], ['Qatar', '974'], ['Rwanda', '250'],
  ['Saudi Arabia', '966'], ['Singapore', '65'], ['South Africa', '27'], ['Sri Lanka', '94'], ['Syria', '963'], ['Tanzania', '255'],
  ['Thailand', '66'], ['Uganda', '256'], ['United Arab Emirates', '971'], ['United Kingdom', '44'], ['United States', '1'], ['Yemen', '967'],
];

/** Kenya for Nairobi, Pakistan for Karachi, India for the other branches. */
export function countryForBranch(branchName?: string): string {
  if (/nairobi/i.test(branchName ?? '')) return 'Kenya';
  if (/karachi/i.test(branchName ?? '')) return 'Pakistan';
  return 'India';
}

function splitPhone(phone: string | null, fallbackCountry: string): { country: string; number: string } {
  const match = /^\+(\d+) (\d+)$/.exec(phone ?? '');
  if (!match) return { country: fallbackCountry, number: '' };
  const country = COUNTRIES.find(([name, code]) => code === match[1] && name === fallbackCountry)?.[0]
    ?? COUNTRIES.find(([, code]) => code === match[1])?.[0] ?? fallbackCountry;
  return { country, number: match[2] };
}

/** Country first (which sets the code), then the number. Calls onChange with "+254 712345678", or '' when empty. */
export function PhoneField({ value, defaultCountry, onChange }: { value: string | null; defaultCountry: string; onChange: (phone: string) => void }) {
  const [{ country, number }, setParts] = useState(() => splitPhone(value, defaultCountry));
  const update = (nextCountry: string, nextNumber: string) => {
    // Drop spaces/dashes and a leading 0 (people often type 0712… with the country code already chosen).
    const digits = nextNumber.replace(/\D/g, '').replace(/^0/, '');
    setParts({ country: nextCountry, number: digits });
    const code = COUNTRIES.find(([name]) => name === nextCountry)?.[1];
    onChange(digits && code ? `+${code} ${digits}` : '');
  };
  return (
    <span className="phone-field">
      <select className="field" value={country} onChange={e => update(e.target.value, number)} aria-label="Country">
        {COUNTRIES.map(([name, code]) => <option key={name} value={name}>{name} (+{code})</option>)}
      </select>
      <input className="field" inputMode="tel" value={number} onChange={e => update(country, e.target.value)} placeholder="Phone number" aria-label="Phone number" />
    </span>
  );
}

/** One Settings row: shows the value with a pencil; the pencil opens the editor with Save / Cancel. */
export function EditableRow({ label, value, note, editing, saving, onEdit, onCancel, onSave, children }: {
  label: string; value: ReactNode; note?: string; editing: boolean; saving: boolean;
  onEdit?: () => void; onCancel: () => void; onSave: () => void; children?: ReactNode;
}) {
  return (
    <div className={`settings-row editable-row${editing ? ' editing' : ''}`}>
      <div>
        <strong>{label}</strong>
        {editing ? (
          <form className="editable-row-form" onSubmit={e => { e.preventDefault(); onSave(); }}>
            {children}
            <span className="editable-row-actions">
              <Button disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
              <Button outline type="button" onClick={onCancel} disabled={saving}>Cancel</Button>
            </span>
          </form>
        ) : (
          <small>{value || <em>Not added yet</em>}</small>
        )}
        {note && !editing && <small className="editable-row-note">{note}</small>}
      </div>
      {!editing && onEdit && <button type="button" className="edit-pencil" onClick={onEdit} aria-label={`Edit ${label.toLowerCase()}`}><Pencil size={15} /></button>}
    </div>
  );
}

/** Admin: edit anyone's name, email, phone, ITS — and TR for students. No password needed. */
export function AdminDetailsModal({ userId, branchName, onClose, onSaved }: { userId: string; branchName?: string; onClose: () => void; onSaved: () => void }) {
  const [details, setDetails] = useState<UserDetails | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', itsNumber: '', trNumber: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<UserDetails>(`/admin/users/${userId}/details`)
      .then(d => {
        setDetails(d);
        setForm({ name: d.name, email: d.email, phone: d.phone ?? '', itsNumber: d.itsNumber ?? '', trNumber: d.trNumber ?? '' });
      })
      .catch(err => setError(err instanceof ApiError ? err.message : 'Could not load this account.'));
  }, [userId]);

  const save = async () => {
    if (!details) return;
    setSaving(true);
    setError(null);
    try {
      // Only send what changed, so an old email like name@demo.org can stay until someone edits it.
      const changes: Record<string, string> = {};
      if (form.name !== details.name) changes.name = form.name;
      if (form.email.trim().toLowerCase() !== details.email.toLowerCase()) changes.email = form.email;
      if (form.phone !== (details.phone ?? '')) changes.phone = form.phone;
      if (form.itsNumber !== (details.itsNumber ?? '')) changes.itsNumber = form.itsNumber;
      if (details.role === 'student' && form.trNumber.toUpperCase() !== (details.trNumber ?? '')) changes.trNumber = form.trNumber;
      if (Object.keys(changes).length) await apiFetch(`/admin/users/${userId}/details`, { method: 'PATCH', body: changes });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save these details.');
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value })) });

  return (
    <Modal onClose={onClose}>
      <p className="eyebrow"><Pencil size={13} /> Edit details</p>
      <h2>{details?.name ?? 'Loading…'}</h2>
      {details && (
        <form className="admin-details-form" onSubmit={e => { e.preventDefault(); void save(); }}>
          <label className="field-label">Name<input className="field" {...field('name')} required /></label>
          <label className="field-label">Email (their sign-in name)<input className="field" type="email" {...field('email')} required /></label>
          <label className="field-label">Phone<PhoneField value={details.phone} defaultCountry={countryForBranch(branchName)} onChange={phone => setForm(f => ({ ...f, phone }))} /></label>
          <label className="field-label">ITS number<input className="field" inputMode="numeric" maxLength={8} {...field('itsNumber')} placeholder="8 digits" /></label>
          {details.role === 'student' && <label className="field-label">TR number<input className="field" {...field('trNumber')} required /></label>}
          {error && <p className="error-text">{error}</p>}
          <div className="modal-actions">
            <Button disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button outline type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
      {!details && error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
