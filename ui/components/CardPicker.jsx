import { Field } from "./Field.jsx";

// "Use a saved card or fill manually" + permission scope for the chosen card.
export default function CardPicker({ req, pickedCardId, onPick, scope, onScope }) {
  return (
    <div className="cardPicker">
      <Field label="Use a saved card">
        <select value={pickedCardId || ""} onChange={(e) => onPick(e.target.value || null)}>
          <option value="">— Fill manually —</option>
          {req.cards.map((c) => (
            <option key={c.id} value={c.id}>{c.id + (c.isDefault ? " (default)" : "")}</option>
          ))}
        </select>
      </Field>
      {pickedCardId && (
        <Field label="Auto-fill next time:">
          <select value={scope} onChange={(e) => onScope(e.target.value)}>
            <option value="">Ask me each time</option>
            <option value="site">{req.host ? `Allow on ${req.host}` : "Allow on this site"}</option>
            <option value="all">Allow for all sites</option>
          </select>
        </Field>
      )}
    </div>
  );
}
