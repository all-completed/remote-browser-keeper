// The renderer of the small APPROVAL window (issue #34) — the request waiting for the user,
// apart from the main window. The same stylesheets, in the same order, as ui/main.jsx, so
// both windows wear one look.
import "rsuite/dist/rsuite.min.css";
import "@f-proj/ui-components/styles.css";
import "./styles/app.css";
import { createRoot } from "react-dom/client";
import ApprovalApp from "./ApprovalApp.jsx";

createRoot(document.getElementById("root")).render(<ApprovalApp />);
