import { SelectPicker } from "rsuite";
import { Field } from "./Field.jsx";

const MANUAL = "__manual__"; // SelectPicker has no "empty" option of its own
const ASK = "__ask__";

// "Use a saved card or fill manually" + permission scope for the chosen card.
export default function CardPicker({ req, pickedCardId, onPick, scope, onScope }) {
  return (
    <div className="cardPicker">
      <Field label="Use a saved card">
        <SelectPicker
          block
          searchable={false}
          cleanable={false}
          data={[
            { label: "— Fill manually —", value: MANUAL },
            ...req.cards.map((c) => ({ label: c.id + (c.isDefault ? " (default)" : ""), value: c.id })),
          ]}
          value={pickedCardId || MANUAL}
          onChange={(v) => onPick(v && v !== MANUAL ? v : null)}
        />
      </Field>
      {pickedCardId && (
        <Field label="Auto-fill next time:">
          <SelectPicker
            block
            searchable={false}
            cleanable={false}
            data={[
              { label: "Ask me each time", value: ASK },
              { label: req.host ? `Allow on ${req.host}` : "Allow on this site", value: "site" },
              { label: "Allow for all sites", value: "all" },
            ]}
            value={scope || ASK}
            onChange={(v) => onScope(v && v !== ASK ? v : "")}
          />
        </Field>
      )}
    </div>
  );
}
