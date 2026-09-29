import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, type Location } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { applyTheme, storage, type ThemePref } from "./hooks";
import { ToastProvider } from "./components/ui";
import { UpdateBanner } from "./components/UpdateBanner";
import { EdgeSwipeBack } from "./components/EdgeSwipeBack";
import { BrandStyle } from "./components/BrandStyle";
import ShowcasePage from "./pages/ShowcasePage";

// Everything except the showcase loads on demand (keeps the first paint small).
const loadItemPage = () => import("./pages/ItemPage");
const ItemPage = lazy(() => loadItemPage().then((m) => ({ default: m.ItemPage })));
const ItemModal = lazy(() => loadItemPage().then((m) => ({ default: m.ItemModal })));
const ItemFormPage = lazy(() => import("./pages/ItemFormPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const BulkAddPage = lazy(() => import("./pages/BulkAddPage"));

// Item details are the most common next step — fetch that chunk once the browser is idle.
const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
idle(() => void loadItemPage());

function PageFallback() {
  return <div className="min-h-dvh grid place-items-center text-sm text-muted">加载中…</div>;
}

applyTheme((storage.read("theme") as ThemePref) || "system");

// PWA: service workers only exist in secure contexts (the Tailscale HTTPS URL), never on plain LAN http
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
// A tab left open across a deploy may ask for a chunk that no longer exists → reload once to pick up the new build
window.addEventListener("vite:preloadError", () => {
  if (!sessionStorage.getItem("reloadedForChunk")) {
    sessionStorage.setItem("reloadedForChunk", "1");
    window.location.reload();
  }
});

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

function AppRoutes() {
  const location = useLocation();
  // desktop: item links carry the showcase location so the detail renders as a modal on top
  const background = (location.state as { background?: Location } | null)?.background;
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes location={background ?? location}>
        <Route path="/" element={<ShowcasePage />} />
        <Route path="/item/:id" element={<ItemPage />} />
        <Route path="/item/:id/edit" element={<ItemFormPage />} />
        <Route path="/add" element={<ItemFormPage />} />
        <Route path="/bulk" element={<BulkAddPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* hidden: no link anywhere in the UI */}
        <Route path="/logs" element={<LogsPage />} />
        <Route path="*" element={<ShowcasePage />} />
      </Routes>
      {background && (
        <Suspense fallback={null}>
          <Routes>
            <Route path="/item/:id" element={<ItemModal />} />
          </Routes>
        </Suspense>
      )}
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrandStyle />
        <BrowserRouter>
          <AppRoutes />
          <EdgeSwipeBack />
        </BrowserRouter>
        <UpdateBanner />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
