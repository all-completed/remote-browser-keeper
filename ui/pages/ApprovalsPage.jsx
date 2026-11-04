import { Button, Message, Panel } from "rsuite";
import NoticeIcon from "@rsuite/icons/Notice";
import { PageBody, PageHeader } from "@f-proj/ui-components";
import { dismiss, showApproval } from "../lib/statusBridge.js";

// The warnings the tray shows, here as well — the Approvals page is where the user looks
// when something they answered did not go through.
function Warnings({ status, go }) {
  if (!status) return null;
  return (
    <>
      {status.promptFailure && (
        <Message type="error" showIcon closable onClose={() => dismiss("promptFailure")} header="An approval failed to show">
          A request could not be put on screen ({status.promptFailure.reason}), so the service was told the Keeper's
          approval UI failed. Ask the agent to try again.
        </Message>
      )}
      {status.undelivered && (
        <Message type="error" showIcon closable onClose={() => dismiss("undelivered")} header="An answer never reached the service">
          {status.undelivered.why}
        </Message>
      )}
      {status.outbox > 0 && (
        <Message type="info" showIcon>
          {status.outbox} answer{status.outbox === 1 ? " is" : "s are"} waiting for the connection and will be sent when it is back.
        </Message>
      )}
      {status.vaultNeedsRepair && (
        <Message type="warning" showIcon>Vault: this device can't decrypt the synced vault — re-pair it to update the password.</Message>
      )}
      {status.vaultLegacyKey && (
        <Message type="warning" showIcon>
          Vault: legacy v1 key — <Button appearance="link" size="sm" onClick={() => go("vaultpw")}>set a vault password</Button> to migrate.
        </Message>
      )}
    </>
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What is waiting, and the way back to it. Requests themselves are answered in the small
// approval window (issue #34), never here: a request does not bring this window up, so it
// cannot be the place where one has to be answered.
export default function ApprovalsPage({ status, go }) {
  const fills = (status && status.waiting) || 0;
  const unlocks = (status && status.unlocks) || 0;
  const waiting = fills + unlocks;
  const what = [
    fills ? plural(fills, "fill request", "fill requests") : null,
    unlocks ? plural(unlocks, "headless Keeper", "headless Keepers") : null,
  ].filter(Boolean).join(" and ");

  return (
    <>
      <PageHeader icon={<NoticeIcon />} title="Approvals" meta={waiting ? `${waiting} waiting` : "nothing waiting"} />
      <PageBody>
        {/* A narrow centred column: a notice, not a list (issue #31). */}
        <div className="page-wrap narrow">
          <Warnings status={status} go={go} />
          {waiting ? (
            <Panel bordered className="card">
              <p className="empty-title">{what} waiting for you</p>
              <p className="muted">
                Requests are answered in their own small approval window. If you closed it or it is behind
                something, bring it back here — or from the tray.
              </p>
              <div className="actions">
                <Button appearance="primary" onClick={showApproval}>Show approval window</Button>
              </div>
            </Panel>
          ) : (
            <Panel bordered className="card empty">
              <p className="empty-title">Nothing is waiting for you.</p>
              <p className="muted">
                When a remote browser session needs a password, a code or a card, a small approval window comes up on
                its own — this window stays where it is. The value goes straight to the service — never to the AI model.
              </p>
            </Panel>
          )}
        </div>
      </PageBody>
    </>
  );
}
