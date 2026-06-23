import { useState } from "react";

// A labeled form field: a caption above the control, optional hint below. Shared
// by the prompt and the Saved-cards form so both use the same structure/styling.
export function Field({ label, hint, children }) {
  return (
    <label className="fld">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

// A text input with an optional reveal (eye) toggle for secret values. Masking is
// self-managed; pass `secret` to enable it.
export function RevealInput({ secret, ...props }) {
  const [shown, setShown] = useState(false);
  if (!secret) return <input type="text" {...props} />;
  return (
    <span className="inrow">
      <input type={shown ? "text" : "password"} {...props} />
      <button type="button" className="reveal" title="Show / hide" onClick={() => setShown((s) => !s)} aria-label="Show or hide">
        👁
      </button>
    </span>
  );
}
