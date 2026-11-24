import { initializeBranch } from "./lib/branch";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppProvider } from "./lib/AppContext";
import { Layout } from "./components/Layout";
import { CartDrawer, DishModal, MenuMatcher } from "./components/Shopping";
import { Home } from "./pages/Home";
import { Menu } from "./pages/Menu";
import { Orders } from "./pages/Orders";
import { About } from "./pages/About";
import { Events } from "./pages/Events";
import { Receipt } from "./pages/Receipt";
const Staff = lazy(() =>
  import("./pages/Staff").then((module) => ({ default: module.Staff })),
);
import { Account } from "./pages/Account";
import { AccountAction } from "./pages/AccountAction";
import { Notifications } from "./pages/Notifications";
import { Takeaway } from "./pages/Takeaway";
import { Reservations } from "./pages/Reservations";
import { Payment } from "./pages/Payment";
import { Button, EmptyState } from "./components/UI";
import "./styles/site.css";
import "./styles/staff.css";
import "./styles/operations.css";
import "./styles/commerce.css";
import "./styles/management.css";
import "./styles/v24.css";
import "./styles/v25.css";
import "./styles/v26.css";
import "./styles/v27.css";
import "./styles/v28.css";
import "./styles/v29.css";
const Driver = lazy(() => import("./pages/Driver"));
const PrintJobPreview = lazy(() =>
  import("./pages/PrintingPanel").then((module) => ({
    default: module.PrintJobPreview,
  })),
);
const ThermalReceipt = lazy(() =>
  import("./pages/PrintingPanel").then((module) => ({
    default: module.ThermalReceipt,
  })),
);

function App() {
  return (
    <AppProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="menu" element={<Menu />} />
          <Route path="orders" element={<Orders />} />
          <Route path="about" element={<About />} />
          <Route path="events" element={<Events />} />
          <Route path="account" element={<Account />} />
          <Route path="account/action" element={<AccountAction />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="takeaway" element={<Takeaway />} />
          <Route path="reservations" element={<Reservations />} />
          <Route path="payment" element={<Payment />} />
          <Route path="receipt/:id" element={<Receipt />} />
          <Route
            path="*"
            element={
              <div className="container not-found">
                <EmptyState
                  title="This table isn’t here."
                  text="Let’s find your way back to something good."
                >
                  <Button to="/">Back to Angar</Button>
                </EmptyState>
              </div>
            }
          />
        </Route>
        <Route
          path="driver"
          element={
            <Suspense fallback={<p>Opening delivery link…</p>}>
              <Driver />
            </Suspense>
          }
        />
        <Route
          path="staff"
          element={
            <Suspense fallback={<p>Opening staff workspace…</p>}>
              <Staff />
            </Suspense>
          }
        />
        <Route
          path="staff/print/:id"
          element={
            <Suspense fallback={<p>Opening print preview…</p>}>
              <PrintJobPreview />
            </Suspense>
          }
        />
        <Route
          path="staff/receipt/:id/thermal"
          element={
            <Suspense fallback={<p>Opening thermal receipt…</p>}>
              <ThermalReceipt />
            </Suspense>
          }
        />
      </Routes>
      <CartDrawer />
      <DishModal />
      <MenuMatcher />
    </AppProvider>
  );
}
await initializeBranch();
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
