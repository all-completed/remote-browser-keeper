import { describeField } from "../lib/format.js";

export default function FieldRow({ field, value, revealed, onToggleReveal, onChange, onSubmit, onCancel }) {
  const d = describeField(field);
  const label = <label className="flabel">{field.label || "Enter value"}</label>;

  // Expiry month / year → dropdown.
  if (d.mode === "month" || d.mode === "year") {
    return (
      <div className="field">
        {label}
        <div className="inputRow">
          <select className="cardSelect" value={value || ""} onChange={(e) => onChange(e.target.value)}>
            <option value="">{d.mode === "month" ? "Month (MM)" : "Year"}</option>
            {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        {d.hint && <div className="hint">{d.hint}</div>}
      </div>
    );
  }

  const keyDown = (e) => {
    if (e.key === "Enter" && d.mode !== "multiline") { e.preventDefault(); onSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  const masked = d.secret && !revealed;

  return (
    <div className="field">
      {label}
      <div className="inputRow">
        {d.mode === "multiline" ? (
          <textarea
            rows={3}
            value={value || ""}
            placeholder="Type here…"
            autoCapitalize="sentences"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={keyDown}
          />
        ) : (
          <input
            type={masked ? "password" : "text"}
            value={value || ""}
            inputMode={d.inputMode}
            maxLength={d.maxLen || undefined}
            pattern={d.pattern}
            placeholder={d.placeholder || "Type here…"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            autoCapitalize={String(field.field || "").toLowerCase() === "card-holder-name" ? "words" : "off"}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={keyDown}
          />
        )}
        {d.secret && d.mode !== "multiline" && (
          <button type="button" className="reveal" title="Show / hide" onClick={onToggleReveal}>👁</button>
        )}
      </div>
      {d.hint && <div className="hint">{d.hint}</div>}
    </div>
  );
}
