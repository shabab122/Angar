import { PwaControls } from "./PwaControls";
import AssistantChat from "./AssistantChat";
import { BranchSelector } from "./BranchSelector";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  ArrowUpRight,
  MapPin,
  Clock3,
  ShoppingBag,
  ReceiptText,
  Menu,
  X,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { Logo } from "./UI";

export function Layout() {
  const { t, language, setLanguage, count, setCartOpen, restaurant } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);
  const navigation = [
    ["/", "Home", "হোম"],
    ["/menu", "Our menu", "আমাদের মেনু"],
    ["/about", "Our story", "আমাদের গল্প"],
    ["/events", "Private dining", "প্রাইভেট ডাইনিং"],
    ["/reservations", "Reserve a table", "টেবিল বুকিং"],
  ];
  return (
    <div className="site">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="utility-bar">
        <div className="container">
          <span>
            <MapPin size={12} />
            {restaurant?.location || "Dhanmondi, Dhaka"}
          </span>
          <span>
            <Clock3 size={12} />
            {restaurant?.hours || "12:00 PM – 10:30 PM"}
            <span className="utility-divider" />{" "}
            {t("Made for gathering", "একসঙ্গে খাওয়ার আয়োজন")}
          </span>
        </div>
      </div>
      <BranchSelector />
      <PwaControls />
      <header className="site-header">
        <div className="container header-inner">
          <Logo />
          <nav
            aria-label="Main navigation"
            className={"site-nav" + (mobileOpen ? " mobile-open" : "")}
          >
            {navigation.map(([to, en, bn]) => (
              <NavLink key={to} to={to} end={to === "/"}>
                {t(en, bn)}
              </NavLink>
            ))}
            <NavLink to="/account" className="mobile-account-link">
              {t("My account", "আমার অ্যাকাউন্ট")}
            </NavLink>
            <NavLink to="/takeaway" className="mobile-account-link">
              {t("Takeaway & delivery", "টেকঅ্যাওয়ে ও ডেলিভারি")}
            </NavLink>
            <NavLink to="/notifications" className="mobile-account-link">
              {t("Order alerts", "অর্ডারের খবর")}
            </NavLink>
          </nav>
          <div className="header-actions">
            <NavLink
              to="/account"
              className="orders-link header-account"
              aria-label={t("Customer account", "গ্রাহক অ্যাকাউন্ট")}
            >
              <UserRound size={19} />
            </NavLink>
            <button
              type="button"
              className="language-switch"
              onClick={() => setLanguage(language === "en" ? "bn" : "en")}
              aria-label={
                language === "en" ? "বাংলায় দেখুন" : "Switch to English"
              }
            >
              {language === "en" ? "বাংলা" : "EN"}
            </button>
            <NavLink
              to="/orders"
              className="orders-link"
              aria-label={t("My orders", "আমার অর্ডার")}
            >
              <ReceiptText size={20} />
            </NavLink>
            <button
              type="button"
              className="header-cart"
              onClick={() => setCartOpen(true)}
              aria-label={t("Open cart", "কার্ট খুলুন")}
            >
              <ShoppingBag size={17} />
              <span>{t("Cart", "কার্ট")}</span>
              <b>{count}</b>
            </button>
            <button
              type="button"
              className="mobile-menu-button icon-button"
              aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              {mobileOpen ? <X /> : <Menu />}
            </button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container footer-top">
          <div className="footer-brand">
            <Logo light />
            <p>
              {t(
                "Familiar flavours. A place at the table for you.",
                "চেনা স্বাদে আপনার জন্য একটুখানি জায়গা।",
              )}
            </p>
            <span className="footer-sample">
              {t(
                "Sample restaurant • Built for your next chapter",
                "নমুনা রেস্টুরেন্ট • আপনার ব্র্যান্ডের জন্য তৈরি",
              )}
            </span>
          </div>
          <div>
            <h3>{t("Come on in", "চলে আসুন")}</h3>
            <p>{restaurant?.location || "Dhanmondi, Dhaka"}</p>
            <p>{restaurant?.hours || "12:00 PM – 10:30 PM"}</p>
            <a
              href={
                restaurant?.mapUrl ||
                "https://www.google.com/maps/search/?api=1&query=Dhanmondi%2C+Dhaka"
              }
              target="_blank"
              rel="noreferrer"
            >
              {t("Explore the neighbourhood", "এলাকার ম্যাপ দেখুন")}{" "}
              <ArrowUpRight size={14} />
            </a>
          </div>
          <div>
            <h3>{t("At Angar", "আঙারে")}</h3>
            <Link to="/menu">{t("Explore our menu", "মেনু দেখুন")}</Link>
            <Link to="/takeaway">
              {t("Takeaway & delivery", "টেকঅ্যাওয়ে ও ডেলিভারি")}
            </Link>
            <Link to="/notifications">
              {t("Order & reservation alerts", "অর্ডার ও বুকিংয়ের খবর")}
            </Link>
            <Link to="/events">{t("Plan a gathering", "ইভেন্টের আয়োজন")}</Link>
            <Link to="/orders">
              {t("Your orders & events", "আপনার অর্ডার ও ইভেন্ট")}
            </Link>
            <Link to="/staff">{t("Staff workspace", "স্টাফ প্যানেল")}</Link>
          </div>
          <div className="footer-invitation">
            <Sparkles size={24} />
            <h3>{t("A table for your people.", "আপনার আপনজনের টেবিল।")}</h3>
            <Link to="/events">
              {t("Let’s plan something", "পরিকল্পনা করুন")}{" "}
              <ArrowUpRight size={17} />
            </Link>
          </div>
        </div>
        <div className="container footer-bottom">
          <span>© {new Date().getFullYear()} Angar Kitchen.</span>
          <span>
            {t("Dhanmondi, Dhaka · Bangladesh", "ধানমন্ডি, ঢাকা · বাংলাদেশ")}
          </span>
          <span>
            {t(
              "Good company is always on the menu.",
              "মেনুতে থাকুক একসঙ্গে থাকার আনন্দ।",
            )}
          </span>
        </div>
      </footer>
      <AssistantChat />
    </div>
  );
}
