import { describeField } from "../lib/format.js";
import { Field, RevealInput } from "./Field.jsx";

export default function FieldRow({ field, value, onChange, onSubmit, onCancel }) {
  const d = describeField(field);
  const label = field.label || "Enter value";

  const keyDown = (e) => {
    if (e.key === "Enter" && d.mode !== "multiline") { e.preventDefault(); onSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  // Expiry month / year → dropdown.
  if (d.mode === "month" || d.mode === "year") {
    return (
      <Field label={label} hint={d.hint}>
        <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">{d.mode === "month" ? "Month (MM)" : "Year"}</option>
          {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
    );
  }

  if (d.mode === "multiline") {
    return (
      <Field label={label} hint={d.hint}>
        <textarea
          rows={3}
          value={value || ""}
          placeholder="Type here…"
          autoCapitalize="sentences"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keyDown}
        />
      </Field>
    );
  }

  return (
    <Field label={label} hint={d.hint}>
      <RevealInput
        secret={d.secret}
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
    </Field>
  );
}
