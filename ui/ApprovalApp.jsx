import { useEffect, useState } from "react";
import { AppShell, PageBody, PageHeader } from "@f-proj/ui-components";
import { BRAND } from "./brand.js";
import { getLatest, subscribe } from "./lib/promptBridge.js";
import { getStatus, subscribeStatus } from "./lib/statusBridge.js";
import { ImageViewerProvider } from "./components/ImageViewer.jsx";
import FillRequest from "./components/FillRequest.jsx";
import { UnlockRequest, useUnlock } from "./components/UnlockRequest.jsx";

// The small approval window (issue #34): the request waiting for the user, in a window of
// its own so the main window never has to come up for it. One request on screen at a time,
// as main's queue hands them over, plus any headless Keeper asking to be unlocked.
//
// The same ui-components AppShell as the main window — so the same dark theme and the
// Keeper's emerald brand palette on every rsuite control — but with no navigation: a
// prompt, not a second app. Its (empty) drawer and burger are hidden in app.css
// (.approval-shell); the brand is the title bar's icon.
export default function ApprovalApp() {
  const [req, setReq] = useState(getLatest());
  const [status, setStatus] = useState(getStatus());
  useEffect(() => subscribe(setReq), []);
  useEffect(() => subscribeStatus(setStatus), []);
  const unlock = useUnlock();
  const moreFills = Math.max(0, ((status && status.waiting) || 0) - (req ? 1 : 0));

  return (
    <ImageViewerProvider>
      <AppShell brand={BRAND} nav={[]} sidebar="drawer" className="approval-shell">
        <PageHeader
          icon={<img src={BRAND.icon} alt="" className="approval-icon" />}
          title={unlock.req && !req ? "Approve a headless Keeper" : "Approve a request"}
        />
        <PageBody>
          <div className="approval-wrap">
            {unlock.req && <UnlockRequest {...unlock} req={unlock.req} onAnswer={unlock.answer} />}
            {req && <FillRequest key={req.request_id} req={req} />}
            {req && moreFills > 0 && (
              <p className="muted small">{moreFills} more request{moreFills === 1 ? "" : "s"} waiting after this one.</p>
            )}
            {/* Only for the moment between an answer and main moving on (the next request,
                or closing this window when nothing waits). */}
            {!req && !unlock.req && <p className="muted center">Nothing is waiting for you.</p>}
          </div>
        </PageBody>
      </AppShell>
    </ImageViewerProvider>
  );
}
