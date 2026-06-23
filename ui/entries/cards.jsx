import { createRoot } from "react-dom/client";
import CardsApp from "../apps/CardsApp.jsx";
import "../styles/cards.css";
import "../styles/fields.css";

createRoot(document.getElementById("root")).render(<CardsApp />);
