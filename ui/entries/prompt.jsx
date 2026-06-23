import { createRoot } from "react-dom/client";
import PromptApp from "../apps/PromptApp.jsx";
import "../styles/prompt.css";
import "../styles/fields.css";

createRoot(document.getElementById("root")).render(<PromptApp />);
