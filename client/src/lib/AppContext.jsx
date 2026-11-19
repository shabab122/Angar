import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, money, readStorage, saveStorage } from "./api";

const AppContext = createContext(null);
export const categories = [
  { id: "all", en: "All dishes", bn: "সব খাবার" },
  { id: "mains", en: "Rice & mains", bn: "ভাত ও প্রধান খাবার" },
  { id: "grill", en: "From the grill", bn: "গ্রিলের খাবার" },
  { id: "drinks", en: "Drinks", bn: "পানীয়" },
  { id: "dessert", en: "Sweet endings", bn: "মিষ্টান্ন" },
];
export const lineKey = (id, variantId = "", addons = []) =>
  [id, variantId, [...addons].sort().join(",")].join("|");
function initialCart() {
  const saved = readStorage("angar.cart.v2", null);
  if (Array.isArray(saved))
    return saved
      .filter(
        (line) =>
          typeof line.dishId === "string" &&
          Number.isInteger(line.quantity) &&
          line.quantity > 0 &&
          line.quantity <= 10,
      )
      .slice(0, 12);
  const previous = readStorage("angar.cart.v1", {});
  return Object.entries(previous.cart || {})
    .filter(
      ([, quantity]) =>
        Number.isInteger(quantity) && quantity > 0 && quantity <= 10,
    )
    .slice(0, 12)
    .map(([dishId, quantity]) => ({
      key: lineKey(dishId),
      dishId,
      quantity,
      addonIds: [],
    }));
}

export function AppProvider({ children }) {
  const [language, setLanguage] = useState(() =>
    readStorage("angar.language", "en") === "bn" ? "bn" : "en",
  );
  const [menu, setMenu] = useState([]);
  const [menuError, setMenuError] = useState(null);
  const [menuLoading, setMenuLoading] = useState(true);
  const [restaurant, setRestaurant] = useState(null);
  const [table, setTable] = useState(null);
  const [contextReady, setContextReady] = useState(false);
  const [cart, setCart] = useState(initialCart);
  const [note, setNote] = useState(() =>
    readStorage("angar.note.v2", readStorage("angar.cart.v1", {}).note || ""),
  );
  const [favourites, setFavourites] = useState(() =>
    readStorage("angar.favourites", []),
  );
  const [cartOpen, setCartOpen] = useState(false);
  const [dishId, setDishId] = useState(null);
  const [matcherOpen, setMatcherOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [customer, setCustomer] = useState(null);
  const [customerReady, setCustomerReady] = useState(false);
  const [customerError, setCustomerError] = useState("");

  const reloadMenu = useCallback(async () => {
    try {
      const result = await api("/menu");
      setMenu(result.dishes);
      setMenuError(null);
    } catch (failure) {
      setMenuError(failure.message);
    } finally {
      setMenuLoading(false);
    }
  }, []);
  const reloadContext = useCallback(async () => {
    try {
      setTable((await api("/context")).table);
    } finally {
      setContextReady(true);
    }
  }, []);
  const reloadRestaurant = useCallback(async () => {
    const result = await api("/restaurant");
    setRestaurant(result.restaurant);
  }, []);

  const reloadCustomer = useCallback(async () => {
    try {
      const result = await api("/account");
      setCustomer(result.customer);
      setCustomerError("");
      return result.customer;
    } catch (error) {
      setCustomerError(error.message);
      throw error;
    } finally {
      setCustomerReady(true);
    }
  }, []);
  useEffect(() => {
    void reloadCustomer().catch(() => {});
    const refresh = () => {
      if (!document.hidden) void reloadCustomer().catch(() => {});
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [reloadCustomer]);
  useEffect(() => {
    void reloadMenu();
    void reloadContext().catch(() => {});
    void reloadRestaurant().catch(() => {});
    const refresh = () => {
      if (!document.hidden) {
        void reloadContext().catch(() => {});
        void reloadMenu();
      }
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [reloadMenu, reloadContext, reloadRestaurant]);
  useEffect(() => {
    saveStorage("angar.cart.v2", cart);
  }, [cart]);
  useEffect(() => {
    saveStorage("angar.note.v2", note);
  }, [note]);
  useEffect(() => {
    saveStorage("angar.favourites", favourites);
  }, [favourites]);
  useEffect(() => {
    saveStorage("angar.language", language);
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3600);
    return () => clearTimeout(timer);
  }, [toast]);

  const t = useCallback(
    (en, bn) => (language === "bn" ? bn || en : en),
    [language],
  );
  const name = useCallback(
    (dish) => (language === "bn" ? dish.nameBn || dish.name : dish.name),
    [language],
  );
  const describe = useCallback(
    (dish) =>
      language === "bn"
        ? dish.descriptionBn || dish.description
        : dish.description,
    [language],
  );
  const pricedLines = useMemo(
    () =>
      cart.map((line) => {
        const dish = menu.find((item) => item._id === line.dishId);
        const variant = line.variantId
          ? dish?.variants?.find((item) => item.id === line.variantId)
          : null;
        const addons = (line.addonIds || []).map((id) =>
          dish?.addons?.find((item) => item.id === id),
        );
        const valid = Boolean(
          dish?.available &&
          (!line.variantId || variant) &&
          addons.every(Boolean),
        );
        const unitPrice =
          (dish?.price || 0) +
          (variant?.price || 0) +
          addons.reduce((sum, addon) => sum + (addon?.price || 0), 0);
        return {
          ...line,
          dish,
          variant,
          addons: addons.filter(Boolean),
          valid,
          unitPrice,
          subtotal: unitPrice * line.quantity,
        };
      }),
    [cart, menu],
  );
  const total = pricedLines.reduce((sum, line) => sum + line.subtotal, 0);
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);

  function addItem(dish, { quantity = 1, variantId, addonIds = [] } = {}) {
    const key = lineKey(dish._id, variantId, addonIds);
    const existing = cart.find((line) => line.key === key);
    if (
      (!existing && cart.length >= 12) ||
      (existing?.quantity || 0) + quantity > 10
    ) {
      setToast(
        t(
          "Up to 12 selections and 10 portions of each.",
          "সর্বোচ্চ ১২টি নির্বাচন ও প্রতিটির ১০ পরিমাণ নেওয়া যাবে।",
        ),
      );
      return false;
    }
    setCart((previous) =>
      existing
        ? previous.map((line) =>
            line.key === key
              ? { ...line, quantity: line.quantity + quantity }
              : line,
          )
        : [
            ...previous,
            {
              key,
              dishId: dish._id,
              quantity,
              variantId,
              addonIds: [...addonIds].sort(),
            },
          ],
    );
    setToast(
      t(
        "Added to your table’s next order.",
        "আপনার পরের অর্ডারের কার্টে যোগ হয়েছে।",
      ),
    );
    return true;
  }
  function updateQuantity(key, quantity) {
    setCart((previous) =>
      quantity <= 0
        ? previous.filter((line) => line.key !== key)
        : previous.map((line) =>
            line.key === key
              ? { ...line, quantity: Math.min(10, quantity) }
              : line,
          ),
    );
  }
  function clearCart() {
    setCart([]);
    setNote("");
    saveStorage("angar.cart.v1", null);
  }
  function toggleFavourite(id) {
    setFavourites((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  }
  return (
    <AppContext.Provider
      value={{
        language,
        setLanguage,
        customer,
        customerReady,
        customerError,
        reloadCustomer,
        replaceCart: (items, nextNote = "") => {
          setCart(
            items.map((line) => ({
              key: lineKey(line.dishId, line.variantId, line.addonIds),
              dishId: line.dishId,
              quantity: line.quantity,
              ...(line.variantId ? { variantId: line.variantId } : {}),
              addonIds: line.addonIds || [],
            })),
          );
          setNote(nextNote);
        },
        t,
        name,
        describe,
        money: (value) => money(value, language),
        menu,
        menuLoading,
        menuError,
        reloadMenu,
        restaurant,
        reloadRestaurant,
        table,
        contextReady,
        reloadContext,
        cart,
        pricedLines,
        total,
        count,
        note,
        setNote,
        addItem,
        updateQuantity,
        clearCart,
        cartOpen,
        setCartOpen,
        dishId,
        setDishId,
        favourites,
        toggleFavourite,
        matcherOpen,
        setMatcherOpen,
        notify: setToast,
      }}
    >
      {children}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </AppContext.Provider>
  );
}
export function useApp() {
  return useContext(AppContext);
}
