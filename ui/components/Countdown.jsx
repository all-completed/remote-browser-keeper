import { useEffect, useState } from "react";
import { formatRemaining, remainingMs } from "../lib/format.js";

// How long is left to answer this request, as a chip next to the session/url ones.
//
// `expiresAt` is an absolute moment (epoch ms) that main read off the fill_request frame,
// so the label stays right when the window has been open for a while, when the app was
// backgrounded or the device slept, and when the frame was replayed to a keeper that just
// reconnected — every tick recomputes from `Date.now()` rather than counting down from
// however long ago the request turned up (issue #12).
//
// Renders nothing when there is no deadline: a request whose remaining time is unknown must
// not be given an invented one.
export default function Countdown({ expiresAt, onExpire }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    // A wake or a re-focus can land between ticks; re-read the clock straight away so the
    // first frame the user actually looks at is not a second (or a nap) stale.
    const sync = () => setNow(Date.now());
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [expiresAt]);

  const left = remainingMs(expiresAt, now);
  const gone = left != null && left <= 0;

  useEffect(() => { if (gone && onExpire) onExpire(); }, [gone]);

  if (left == null) return null;
  return (
    <span
      className={"chip timeleft" + (gone ? " gone" : left <= 30000 ? " soon" : "")}
      title={gone ? "The request has expired" : `Expires at ${new Date(expiresAt).toLocaleTimeString()}`}
    >
      {gone ? "expired" : `${formatRemaining(left)} left`}
    </span>
  );
}
