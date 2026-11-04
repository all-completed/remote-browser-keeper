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
  approvals: ApprovalsPage,
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

// The main window (issue #28): the ui-components AppShell — the same dark sidebar shell as
// Getway Chat and the other f-proj apps — with every former window as a page of it, but
// for the approval prompt, which is a small window of its own (issue #34).
export default function App() {
  const [page, setPage] = useState(() => (isPage(getPage()) ? getPage() : "approvals"));
  const [status, setStatus] = useState(getStatus());
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => subscribePage((p) => { if (isPage(p)) setPage(p); }), []);
  useEffect(() => subscribeStatus(setStatus), []);

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
        {/* A request is never answered here: it has its own small window (issue #34,
            ui/ApprovalApp.jsx). */}
        {Page ? <Page key={page} go={go} status={status} /> : null}
      </AppShell>
    </ImageViewerProvider>
  );
}
