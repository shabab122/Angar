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
import { Staff } from "./pages/Staff";
import { Account } from "./pages/Account";
import { AccountAction } from "./pages/AccountAction";
import { Reservations } from "./pages/Reservations";
import { Payment } from "./pages/Payment";
import { Button, EmptyState } from "./components/UI";
import "./styles/site.css";
import "./styles/staff.css";
import "./styles/operations.css";
import "./styles/commerce.css";
import "./styles/management.css";

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
        <Route path="staff" element={<Staff />} />
      </Routes>
      <CartDrawer />
      <DishModal />
      <MenuMatcher />
    </AppProvider>
  );
}
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
