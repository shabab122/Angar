import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BellRing,
  Heart,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Sparkles,
  Table2,
} from "lucide-react";
import { useApp, categories } from "../lib/AppContext";
import { api } from "../lib/api";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Eyebrow,
  Loading,
} from "../components/UI";
import { MenuCard } from "../components/MenuCard";
import { GuestServiceControls } from "../components/Operations";

export function TableNotice({ compact = false }) {
  const { table, t, reloadContext, notify } = useApp();
  async function leave() {
    try {
      await api("/context/leave", { method: "POST", data: {} });
      await reloadContext();
    } catch (error) {
      notify(error.message);
    }
  }
  if (!table)
    return compact ? null : (
      <div className="browse-notice">
        <Table2 size={18} />
        <span>
          {t(
            "Dining with us? Scan the code on your table to place an order.",
            "আমাদের রেস্টুরেন্টে থাকলে অর্ডার দিতে টেবিলের QR স্ক্যান করুন।",
          )}
        </span>
      </div>
    );
  return (
    <div className={"table-notice" + (!table.active ? " table-inactive" : "")}>
      <span className="table-symbol">
        <Table2 size={23} />
      </span>
      <div>
        <strong>{t("Table ", "টেবিল ") + table.number.slice(1)}</strong>
        <p>
          {table.active
            ? table.billingState === "finalized"
              ? t("Your bill is at the counter.", "আপনার বিল কাউন্টারে প্রস্তুত।")
              : t(
                  "Settle in. Order whenever you’re ready.",
                  "আরাম করে বসুন। প্রস্তুত হলে অর্ডার দিন।",
                )
            : t(
                "Ask staff to open your table, then scan again.",
                "স্টাফকে টেবিলটি খুলতে বলুন, তারপর আবার স্ক্যান করুন।",
              )}
        </p>
      </div>
      {table.active && !compact && (
        <GuestServiceControls key={table.visitKey} />
      )}
      <button type="button" className="leave-table" onClick={leave}>
        {t("Leave table", "টেবিল ছাড়ুন")}
      </button>
    </div>
  );
}

export function Menu() {
  const {
    t,
    menu,
    menuLoading,
    menuError,
    reloadMenu,
    favourites,
    setMatcherOpen,
    restaurant,
  } = useApp();
  const [params, setParams] = useSearchParams();
  const activeCategory = categories.some(
    (item) => item.id === params.get("category"),
  )
    ? params.get("category")
    : "all";
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("house");
  const [savedOnly, setSavedOnly] = useState(false);
  const dishes = useMemo(() => {
    const search = query.trim().toLowerCase();
    const next = menu.filter(
      (dish) =>
        (activeCategory === "all" || dish.category === activeCategory) &&
        (!savedOnly || favourites.includes(dish._id)) &&
        (!search ||
          [dish.name, dish.nameBn, dish.description, dish.descriptionBn].some(
            (text) => text?.toLowerCase().includes(search),
          )),
    );
    if (sort === "rating")
      next.sort(
        (a, b) =>
          (b.rating?.average || 0) - (a.rating?.average || 0) ||
          (b.rating?.count || 0) - (a.rating?.count || 0),
      );
    if (sort === "price") next.sort((a, b) => a.price - b.price);
    return next;
  }, [query, menu, activeCategory, sort, savedOnly, favourites]);
  function category(id) {
    setParams(id === "all" ? {} : { category: id }, {
      preventScrollReset: true,
    });
  }
  return (
    <div className="menu-page">
      <section className="menu-page-heading">
        <div className="container">
          <div>
            <Eyebrow>
              {t(
                "A LITTLE SOMETHING FOR EVERY CRAVING",
                "আপনার পছন্দের সব স্বাদ",
              )}
            </Eyebrow>
            <h1>
              {t("Meet your next", "পছন্দের খাবারের")}{" "}
              <em>{t("favourite.", "খোঁজে।")}</em>
            </h1>
            <p>
              {t(
                "From our dum pots to your table. Take your time, and make it yours.",
                "দমের হাঁড়ি থেকে আপনার টেবিলে। সময় নিয়ে পছন্দের খাবার বেছে নিন।",
              )}
            </p>
          </div>
          <button
            type="button"
            className="menu-match-prompt"
            onClick={() => setMatcherOpen(true)}
          >
            <span>
              <Sparkles size={21} />
            </span>
            <div>
              <strong>{t("Can’t decide?", "কী খাবেন ভাবছেন?")}</strong>
              <small>
                {t("Let’s find your menu match", "আপনার পছন্দ মিলিয়ে খুঁজুন")}
              </small>
            </div>
          </button>
        </div>
      </section>
      <div className="container menu-main">
        <TableNotice />
        {restaurant && !restaurant.orderingEnabled && (
          <div className="browse-notice paused">
            <BellRing size={17} />
            {t(
              "The kitchen is taking a short pause. Your server can help.",
              "কিচেন কিছুক্ষণের বিরতিতে আছে। স্টাফের সহায়তা নিন।",
            )}
          </div>
        )}
        <div className="menu-controls">
          <div className="category-tabs" aria-label="Food categories">
            {categories.map(({ id, en, bn }) => (
              <button
                type="button"
                key={id}
                aria-pressed={activeCategory === id}
                onClick={() => category(id)}
              >
                {t(en, bn)}
              </button>
            ))}
          </div>
          <div className="menu-search-row">
            <label className="search-field">
              <Search size={18} />
              <input
                type="search"
                placeholder={t("What sounds good?", "কোন খাবার খুঁজছেন?")}
                aria-label={t("Search dishes", "খাবার খুঁজুন")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={"saved-filter" + (savedOnly ? " is-active" : "")}
              aria-pressed={savedOnly}
              onClick={() => setSavedOnly(!savedOnly)}
            >
              <Heart size={17} fill={savedOnly ? "currentColor" : "none"} />
              <span>{t("Saved", "পছন্দের")}</span>
            </button>
            <label className="sort-field">
              <SlidersHorizontal size={16} />
              <span className="sr-only">Sort dishes</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="house">{t("House picks", "আমাদের পছন্দ")}</option>
                <option value="rating">
                  {t("Highest rated", "সেরা রেটিং")}
                </option>
                <option value="price">
                  {t("Price low to high", "কম দাম আগে")}
                </option>
              </select>
            </label>
          </div>
        </div>
        <div className="menu-results-bar">
          <span>{t("Made for your table", "আপনার টেবিলের জন্য")}</span>
          <small>
            {dishes.length} {t("dishes to discover", "টি খাবার")}
          </small>
        </div>
        {menuLoading ? (
          <Loading label={t("Bringing you the menu…", "মেনু আসছে…")} />
        ) : menuError ? (
          <ErrorMessage onRetry={reloadMenu}>{menuError}</ErrorMessage>
        ) : dishes.length ? (
          <div className="menu-grid">
            {dishes.map((dish, index) => (
              <MenuCard key={dish._id} dish={dish} index={index} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Search}
            title={t("A different craving?", "অন্য কিছু খুঁজছেন?")}
            text={t(
              "Try a different search or explore another category.",
              "অন্য নাম দিয়ে খুঁজুন বা ক্যাটাগরি বদলে দেখুন।",
            )}
          >
            <Button
              secondary
              onClick={() => {
                setQuery("");
                category("all");
                setSavedOnly(false);
              }}
            >
              {t("Show all dishes", "সব খাবার দেখান")}
            </Button>
          </EmptyState>
        )}
        <p className="menu-bottom-note">
          {t(
            "Food preferences or ingredient questions? Your server is happy to help.",
            "খাবারের উপকরণ বা পছন্দ নিয়ে প্রশ্ন থাকলে স্টাফকে জানান।",
          )}
        </p>
      </div>
    </div>
  );
}
