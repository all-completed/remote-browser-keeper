import { createRoot } from "react-dom/client";
import HeadlessApp from "../apps/HeadlessApp.jsx";
import "../styles/history.css";

createRoot(document.getElementById("root")).render(<HeadlessApp />);
