const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    const s = x.host + (x.pathname === "/" ? "" : x.pathname);
    return s.length > 48 ? s.slice(0, 47) + "…" : s;
  } catch {
    return u.length > 48 ? u.slice(0, 47) + "…" : u;
  }
}

function chip(text, cls, title) {
  const el = document.createElement("span");
  el.className = "chip" + (cls ? " " + cls : "");
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

function render(items) {
  listEl.replaceChildren();
  if (!items || !items.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  for (const it of items) {
    const card = document.createElement("div");
    card.className = "entry";

    const top = document.createElement("div");
    top.className = "top";
    const outcome = it.outcome || "unknown";
    const badge = document.createElement("span");
    badge.className = "badge " + (outcome === "submitted" ? "ok" : "no");
    badge.textContent = outcome;
    top.appendChild(badge);
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmtTime(it.resolved_at || it.requested_at);
    time.title = `requested: ${fmtTime(it.requested_at)}\nresolved: ${fmtTime(it.resolved_at)}`;
    top.appendChild(time);
    card.appendChild(top);

    const meta = document.createElement("div");
    meta.className = "meta";
    if (it.session_id) meta.appendChild(chip("session: " + it.session_id));
    if (it.url) meta.appendChild(chip(shortUrl(it.url), "url", it.url));
    if (meta.children.length) card.appendChild(meta);

    const fields = Array.isArray(it.fields) ? it.fields : [];
    if (fields.length) {
      const fl = document.createElement("div");
      fl.className = "fields";
      const names = fields.map((f) => f.label || f.field || f.selector || "field");
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = fields.length === 1 ? "field: " : `${fields.length} fields: `;
      fl.appendChild(k);
      fl.appendChild(document.createTextNode(names.join(", ")));
      card.appendChild(fl);
    }

    if (it.screenshot) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "shot-btn";
      btn.textContent = "View screenshot";
      const holder = document.createElement("figure");
      holder.className = "shot";
      holder.hidden = true;
      const img = document.createElement("img");
      img.title = "Click to enlarge";
      img.addEventListener("click", () => {
        if (img.src && /^data:image\//.test(img.src)) window.keeperHistory.viewImage(img.src);
      });
      holder.appendChild(img);
      let loaded = false;
      btn.addEventListener("click", async () => {
        if (!holder.hidden) { holder.hidden = true; btn.textContent = "View screenshot"; return; }
        if (!loaded) {
          const data = await window.keeperHistory.screenshot(it.request_id);
          if (!data) { btn.textContent = "Screenshot unavailable"; btn.disabled = true; return; }
          img.src = data; loaded = true;
        }
        holder.hidden = false; btn.textContent = "Hide screenshot";
      });
      card.appendChild(btn);
      card.appendChild(holder);
    }

    listEl.appendChild(card);
  }
}

window.keeperHistory.onData(render);
document.getElementById("refresh").addEventListener("click", () => window.keeperHistory.refresh());
