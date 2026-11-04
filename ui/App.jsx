import { useEffect, useState } from "react";
import { AppShell } from "@f-proj/ui-components";
import NoticeIcon from "@rsuite/icons/Notice";
import HistoryIcon from "@rsuite/icons/History";
import CreditCardIcon from "@rsuite/icons/CreditCardPlus";
import StorageIcon from "@rsuite/icons/Storage";
import AdminIcon from "@rsuite/icons/Admin";
import QrcodeIcon from "@rsuite/icons/Qrcode";
import LockIcon from "@rsuite/icons/Lock";
import GearIcon from "@rsuite/icons/Gear";
import { BRAND } from "./brand.js";
import { PAGE_TITLES, isPage, approvalsLabel } from "./lib/nav.js";
import { subscribe as subscribePrompt } from "./lib/promptBridge.js";
import { getPage, getStatus, subscribePage, subscribeStatus, reportPage } from "./lib/statusBridge.js";
import { ImageViewerProvider } from "./components/ImageViewer.jsx";
import ApprovalsPage from "./pages/ApprovalsPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import CardsPage from "./pages/CardsPage.jsx";
import SavedFieldsPage from "./pages/SavedFieldsPage.jsx";
import HeadlessPage from "./pages/HeadlessPage.jsx";
import PairPage from "./pages/PairPage.jsx";
import VaultPasswordPage from "./pages/VaultPasswordPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

const PAGES = {
  history: HistoryPage,
  cards: CardsPage,
  savedfields: SavedFieldsPage,
  headless: HeadlessPage,
  pair: PairPage,
  vaultpw: VaultPasswordPage,
  settings: SettingsPage,
};

// The connection line pinned under the nav — the tray's "🟢 Connected · host", in the window.
function Connection({ status, rail }) {
  const on = !!(status && status.connected);
  const label = on ? "Connected" : "Reconnecting…";
  return (
    <div className={"conn" + (rail ? " conn-rail" : "")} title={`${label}${status && status.host ? " · " + status.host : ""}`}>
      <span className={"conn-dot " + (on ? "on" : "off")} aria-hidden="true" />
      <span className={rail ? "app-nav-label" : "conn-text"}>
        {label}
        {!rail && status && status.host ? <span className="conn-host">{status.host}</span> : null}
        {!rail && status && status.version ? <span className="conn-host">v{status.version}</span> : null}
      </span>
    </div>
  );
}

// The ONE window (issue #28): the ui-components AppShell — the same dark sidebar shell as
// Getway Chat and the other f-proj apps — with every former window as a page of it.
export default function App() {
  const [page, setPage] = useState(() => (isPage(getPage()) ? getPage() : "approvals"));
  const [status, setStatus] = useState(getStatus());
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => subscribePage((p) => { if (isPage(p)) setPage(p); }), []);
  useEffect(() => subscribeStatus(setStatus), []);
  // A fill request jumps to Approvals: it is the only page that can answer one, and main
  // waits for it to be on screen before it shows the window (issue #3).
  useEffect(() => subscribePrompt((req) => { if (req) setPage("approvals"); }), []);

  const go = (key) => {
    if (!isPage(key)) return;
    setPage(key);
    reportPage(key);
  };

  const nav = [
    { key: "approvals", label: approvalsLabel(status), icon: <NoticeIcon /> },
    { key: "history", label: PAGE_TITLES.history, icon: <HistoryIcon /> },
    { key: "cards", label: PAGE_TITLES.cards, icon: <CreditCardIcon /> },
    { key: "savedfields", label: PAGE_TITLES.savedfields, icon: <StorageIcon /> },
    { key: "headless", label: PAGE_TITLES.headless, icon: <AdminIcon /> },
    { key: "pair", label: PAGE_TITLES.pair, icon: <QrcodeIcon /> },
    { key: "vaultpw", label: PAGE_TITLES.vaultpw, icon: <LockIcon /> },
    { key: "settings", label: PAGE_TITLES.settings, icon: <GearIcon /> },
  ];
  const Page = PAGES[page];

  return (
    <ImageViewerProvider>
      <AppShell
        brand={BRAND}
        nav={nav}
        activeKey={page}
        onSelect={go}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        footer={<Connection status={status} />}
        railFooter={<Connection status={status} rail />}
      >
        {/* Approvals stays mounted while the user looks at another page, so a value half
            typed into a fill request survives a trip to History and back. `contents` keeps
            its PageHeader a direct child of the shell for layout, as the library requires. */}
        <div className="page-slot" style={{ display: page === "approvals" ? "contents" : "none" }}>
          <ApprovalsPage active={page === "approvals"} status={status} go={go} />
        </div>
        {Page ? <Page key={page} go={go} /> : null}
      </AppShell>
    </ImageViewerProvider>
  );
}
