import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App.jsx";
import "./app/serviceWorker.js";
import { LanguageProvider } from "./shared/i18n/index.jsx";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary.jsx";
// After App: the field/driver stylesheets it pulls in precede the global cascade.
import "./styles/index.css";

createRoot(document.getElementById("root")).render(
  <ErrorBoundary name="root">
    <BrowserRouter>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </BrowserRouter>
  </ErrorBoundary>,
);
