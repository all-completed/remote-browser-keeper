import { useState } from "react";

// A labeled form field: a caption above the control, optional hint below. Shared
// by the prompt and the Saved-cards form so both use the same structure/styling.
export function Field({ label, hint, selector, children }) {
  return (
    <label className="fld">
      <span>{label}</span>
      {selector ? (
        <span
          className="selector"
          title="The exact element the service will fill"
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11.5,
            color: "var(--muted2)",
            wordBreak: "break-all",
            margin: "1px 0 3px",
          }}
        >
          {selector}
        </span>
      ) : null}
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
