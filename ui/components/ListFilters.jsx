import { Input, InputGroup, SelectPicker } from "rsuite";
import SearchIcon from "@rsuite/icons/Search";

// The filter-row fields of a list page (issue #31), as <PageHeader filters> descriptors: the
// row sits under the title bar, stays on one line at every width and puts what does not fit
// behind More — ui-components' own answer for a list's search and filters.

/** The search box: client-side, over what the page already holds (ui/lib/search.js). */
export function searchFilter({ value, onChange, placeholder = "Search", width = 240 }) {
  return {
    key: "q",
    label: "Search",
    width,
    active: Boolean(value && value.trim()),
    render: (p) => (
      <InputGroup size="sm" inside>
        <InputGroup.Addon><SearchIcon /></InputGroup.Addon>
        <Input type="search" placeholder={placeholder} value={value} onChange={(v) => onChange(v)} {...p} />
      </InputGroup>
    ),
  };
}

/** A "narrow to one value" picker (a site, a session, a status); null = all. */
export function pickerFilter({ key, label, value, onChange, options, placeholder, width = 200, mono = false }) {
  return {
    key,
    label,
    width,
    active: value != null,
    render: (p) => (
      <SelectPicker
        size="sm"
        block
        placeholder={placeholder || `All ${label.toLowerCase()}s`}
        data={options.map((o) => (typeof o === "object" ? o : { value: o, label: o }))}
        value={value}
        onChange={(v) => onChange(v == null ? null : v)}
        searchable={options.length > 8}
        renderValue={mono ? (_v, item) => <span className="mono">{item && item.label}</span> : undefined}
        {...p}
      />
    ),
  };
}

/** "12 of 40" under a filtered list, or nothing when nothing is filtered. */
export function FilterCount({ shown, total, onClear }) {
  if (shown === total) return null;
  return (
    <div className="filter-count muted small">
      Showing {shown} of {total}
      {onClear ? <button type="button" className="link-button" onClick={onClear}>Clear filters</button> : null}
    </div>
  );
}
