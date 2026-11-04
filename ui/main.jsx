// The renderer of the ONE Keeper window (issue #28): rsuite's stylesheet first, then the
// shared @f-proj/ui-components shell's, then the Keeper's own few rules on top.
import "rsuite/dist/rsuite.min.css";
import "@f-proj/ui-components/styles.css";
import "./styles/app.css";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
