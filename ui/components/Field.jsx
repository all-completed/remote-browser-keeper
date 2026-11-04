import { useState } from "react";
import { Input, InputGroup } from "rsuite";
import VisibleIcon from "@rsuite/icons/Visible";
import UnvisibleIcon from "@rsuite/icons/Unvisible";

// A labeled form field: a caption above the control, optional hint below. Shared by the
// fill prompt and the Cards form so both use the same structure. The controls inside are
// rsuite's; this is only the label/selector/hint around them.
export function Field({ label, hint, selector, children }) {
  return (
    <div className="fld">
      <span className="fld-label">{label}</span>
      {selector ? (
        <span className="fld-selector" title="The exact element the service will fill">{selector}</span>
      ) : null}
      {children}
      {hint ? <span className="fld-hint">{hint}</span> : null}
    </div>
  );
}

// A text input with an optional reveal (eye) toggle for secret values. Masking is
// self-managed; pass `secret` to enable it. `onChange` gets the event, like a native
// input's, so callers read `e.target.value`.
export function RevealInput({ secret, onChange, ...props }) {
  const [shown, setShown] = useState(false);
  const change = (_v, e) => onChange && onChange(e);
  if (!secret) return <Input type="text" {...props} onChange={change} />;
  return (
    <InputGroup inside>
      <Input type={shown ? "text" : "password"} {...props} onChange={change} />
      <InputGroup.Button title="Show / hide" aria-label="Show or hide" onClick={() => setShown((s) => !s)}>
        {shown ? <UnvisibleIcon /> : <VisibleIcon />}
      </InputGroup.Button>
    </InputGroup>
  );
}
