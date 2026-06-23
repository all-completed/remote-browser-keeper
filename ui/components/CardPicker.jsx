// "Use a saved card or fill manually" + permission scope for the chosen card.
export default function CardPicker({ req, pickedCardId, onPick, scope, onScope }) {
  return (
    <div className="field cardPicker">
      <label className="flabel">Use a saved card</label>
      <select className="cardSelect" value={pickedCardId || ""} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">— Fill manually —</option>
        {req.cards.map((c) => (
          <option key={c.id} value={c.id}>{c.id + (c.isDefault ? " (default)" : "")}</option>
        ))}
      </select>
      {pickedCardId && (
        <div className="rememberRow">
          <span>Auto-fill next time:</span>
          <select className="cardSelect" style={{ flex: 1 }} value={scope} onChange={(e) => onScope(e.target.value)}>
            <option value="">Ask me each time</option>
            <option value="site">{req.host ? `Allow on ${req.host}` : "Allow on this site"}</option>
            <option value="all">Allow for all sites</option>
          </select>
        </div>
      )}
    </div>
  );
}
