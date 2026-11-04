import { Input, InputGroup, SelectPicker } from "rsuite";
import ReloadIcon from "@rsuite/icons/Reload";
import { describeField } from "../lib/format.js";
import { Field, RevealInput } from "./Field.jsx";

export default function FieldRow({ field, value, onChange, onSubmit, onCancel, onGenerate }) {
  const d = describeField(field);
  const label = field.label || "Enter value";

  const keyDown = (e) => {
    if (e.key === "Enter" && d.mode !== "multiline") { e.preventDefault(); onSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  // Generated value: shown in clear (it's a new password to review/save) with a
  // regenerate button. The value is created in the Keeper, never seen by the agent.
  if (field.generate) {
    return (
      <Field label={label} selector={field.selector} hint={d.hint || "Generated in the Keeper — review, then Send"}>
        <InputGroup inside>
          <Input
            type="text"
            className="mono"
            value={value || ""}
            maxLength={d.maxLen || undefined}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(v) => onChange(v)}
            onKeyDown={keyDown}
          />
          <InputGroup.Button title="Generate a new one" aria-label="Generate a new one" onClick={() => onGenerate && onGenerate(field)}>
            <ReloadIcon />
          </InputGroup.Button>
        </InputGroup>
      </Field>
    );
  }

  // Expiry month / year → dropdown.
  if (d.mode === "month" || d.mode === "year") {
    return (
      <Field label={label} selector={field.selector} hint={d.hint}>
        <SelectPicker
          block
          searchable={false}
          cleanable={false}
          placeholder={d.mode === "month" ? "Month (MM)" : "Year"}
          data={d.options.map((o) => ({ label: o, value: o }))}
          value={value || null}
          onChange={(v) => onChange(v || "")}
        />
      </Field>
    );
  }

  if (d.mode === "multiline") {
    return (
      <Field label={label} selector={field.selector} hint={d.hint}>
        <Input
          as="textarea"
          rows={3}
          value={value || ""}
          placeholder="Type here…"
          autoCapitalize="sentences"
          spellCheck={false}
          onChange={(v) => onChange(v)}
          onKeyDown={keyDown}
        />
      </Field>
    );
  }

  return (
    <Field label={label} selector={field.selector} hint={d.hint}>
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
