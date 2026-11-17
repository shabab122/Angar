import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  ChefHat,
  Flame,
  MapPin,
  Sparkles,
  UtensilsCrossed,
  Wine,
  CakeSlice,
  Soup,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { Button, Eyebrow, ErrorMessage, Loading } from "../components/UI";
import { MenuCard } from "../components/MenuCard";

const categories = [
  ["mains", Soup, "From the dum pot", "হাঁড়ির খাবার", "Rice & rich flavours"],
  ["grill", Flame, "Off the charcoal", "কয়লার আঁচে", "Smoky & just-grilled"],
  [
    "drinks",
    Wine,
    "Something refreshing",
    "সতেজ পানীয়",
    "A little sip on the side",
  ],
  [
    "dessert",
    CakeSlice,
    "A sweet little ending",
    "মিষ্টিমুখে শেষ",
    "Save room for this",
  ],
];

export function Home() {
  const {
    t,
    name,
    menu,
    money,
    menuLoading,
    menuError,
    reloadMenu,
    restaurant,
    setDishId,
  } = useApp();
  const signature = menu.find((dish) => dish.signature);
  return (
    <>
      <section className="home-hero">
        <div className="hero-grain" aria-hidden="true" />
        <div className="container hero-inner">
          <div className="hero-copy">
            <Eyebrow light>{t("DHAKA ON A PLATE", "পাতে ঢাকার স্বাদ")}</Eyebrow>
            <h1>
              {t("A little Dhaka.", "একটুখানি ঢাকা।")}
              <br />
              <em>{t("A lot of heart.", "অনেকখানি আপন।")}</em>
            </h1>
            <p>
              {t(
                "Slow-cooked kacchi. The warmth of charcoal. A table made for the people you love. Welcome to Angar.",
                "দমে রান্না কাচ্চি, কয়লার আঁচ আর প্রিয়জনদের নিয়ে বসার টেবিল। আঙারে আপনাকে স্বাগতম।",
              )}
            </p>
            <div className="hero-actions">
              <Button to="/menu" gold arrow>
                {t("Explore our menu", "আমাদের মেনু দেখুন")}
              </Button>
              <Link to="/events" className="hero-text-link">
                {t("Plan a gathering", "একসঙ্গে খাওয়ার আয়োজন")}
                <ArrowUpRight size={17} />
              </Link>
            </div>
            <div className="hero-footnote">
              <span className="hero-footnote-icon">
                <UtensilsCrossed size={17} />
              </span>
              <span>
                {t(
                  "Your next good meal starts here.",
                  "আপনার পরের ভালো খাবারের শুরু এখানেই।",
                )}
                <small>
                  {t("Dine in · Dhanmondi, Dhaka", "ডাইন-ইন · ধানমন্ডি, ঢাকা")}
                </small>
              </span>
            </div>
          </div>
          <div className="hero-art">
            <span className="hero-orbit hero-orbit-one" aria-hidden="true" />
            <span className="hero-orbit hero-orbit-two" aria-hidden="true" />
            <Sparkles className="hero-sparkle one" size={30} strokeWidth={1} />
            <Sparkles className="hero-sparkle two" size={18} strokeWidth={1} />
            <div className="hero-roundel">
              <span>DUM-COOKED</span>
              <Flame size={21} />
              <span>DHAKA-LOVED</span>
            </div>
            <img
              className="hero-platter"
              src="/assets/hero-platter.webp"
              width="1000"
              height="1000"
              alt={t(
                "Our signature mutton kacchi on an antique brass platter",
                "পিতলের থালায় আমাদের বিশেষ মাটন কাচ্চি",
              )}
              fetchPriority="high"
            />
            <button
              type="button"
              className="hero-dish-tag"
              onClick={() => signature && setDishId(signature._id)}
            >
              <span className="hero-dish-tag-icon">
                <ChefHat size={21} />
              </span>
              <span>
                <small>{t("THE ONE TO START WITH", "শুরু হোক এই পদ দিয়ে")}</small>
                <strong>
                  {signature
                    ? name(signature)
                    : t("Dhakai Mutton Kacchi", "ঢাকাই মাটন কাচ্চি")}
                </strong>
              </span>
              <ArrowUpRight size={19} />
            </button>
            <div className="hero-price-note">
              <span>{t("House signature", "আমাদের বিশেষ পদ")}</span>
              {signature && <strong>{money(signature.price)}</strong>}
            </div>
          </div>
        </div>
        <div className="hero-bottom-line">
          <span>ANGAR KITCHEN</span>
          <span className="hero-dot" />
          <span>
            {t(
              "FAMILIAR FLAVOURS, BEAUTIFULLY SERVED",
              "চেনা স্বাদে সুন্দর পরিবেশন",
            )}
          </span>
          <span className="hero-dot" />
          <span>DHAKA, BANGLADESH</span>
        </div>
      </section>

      <section
        className="container category-section"
        aria-label={t("Explore food categories", "খাবারের ক্যাটাগরি")}
      >
        <div className="category-intro">
          <span>{t("WHAT ARE YOU", "আজ কী খেতে")}</span>
          <strong>{t("craving today?", "ইচ্ছে করছে?")}</strong>
        </div>
        {categories.map(([id, Icon, en, bn, sub]) => (
          <Link key={id} to={"/menu?category=" + id} className="home-category">
            <span className="category-illustration">
              <Icon size={27} strokeWidth={1.3} />
            </span>
            <span>
              <strong>{t(en, bn)}</strong>
              <small>{t(sub, bn)}</small>
            </span>
            <ArrowUpRight size={15} />
          </Link>
        ))}
      </section>

      <section className="container signature-section">
        <div className="section-heading">
          <div>
            <Eyebrow>{t("FROM OUR KITCHEN", "আমাদের রান্নাঘর থেকে")}</Eyebrow>
            <h2>
              {t("The dishes you’ll", "যে খাবারগুলো খেতে")}
              <br />
              <em>{t("come back for.", "আবার ফিরবেন।")}</em>
            </h2>
          </div>
          <div className="section-heading-side">
            <p>
              {t(
                "Old favourites, a little fire, and something for every appetite.",
                "চেনা পছন্দ, কয়লার আঁচ আর সবার জন্য কিছু না কিছু।",
              )}
            </p>
            <Button to="/menu" secondary arrow>
              {t("View the full menu", "পুরো মেনু দেখুন")}
            </Button>
          </div>
        </div>
        {menuLoading ? (
          <Loading label={t("Setting the table…", "মেনু আসছে…")} />
        ) : menuError ? (
          <ErrorMessage onRetry={reloadMenu}>{menuError}</ErrorMessage>
        ) : (
          <div className="menu-grid home-menu-grid">
            {menu.slice(0, 3).map((dish, index) => (
              <MenuCard key={dish._id} dish={dish} index={index} />
            ))}
          </div>
        )}
      </section>

      <section className="story-teaser">
        <div className="container story-teaser-inner">
          <div className="story-photo-composition">
            <img
              className="story-room"
              src="/assets/dining-room.webp"
              alt={t(
                "An inviting dining room with burgundy seating and warm brass lights",
                "বারগান্ডি আসন ও উষ্ণ আলোয় সাজানো ডাইনিং রুম",
              )}
              loading="lazy"
            />
            <img
              className="story-food"
              src="/assets/chicken-tikka.webp"
              alt={t("Charcoal chicken tikka", "চারকোল চিকেন টিক্কা")}
              loading="lazy"
            />
            <div className="photo-caption">
              <Flame size={17} />
              {t(
                "A place to pause. A plate to share.",
                "একটু বিরতি। একসঙ্গে খাওয়া।",
              )}
            </div>
          </div>
          <div className="story-teaser-copy">
            <Eyebrow>{t("MORE THAN A MEAL", "খাবারের সঙ্গে গল্পও থাকুক")}</Eyebrow>
            <h2>
              {t("Good food feels", "ভালো খাবার মানেই")}
              <br />
              <em>{t("like coming home.", "আপন একটা অনুভূতি।")}</em>
            </h2>
            <p>
              {t(
                "At Angar, the menu follows the food we know by heart. Kacchi takes its time in the sealed pot. Kebabs meet the charcoal. There’s always room for one more at the table.",
                "আঙারের মেনুতে আছে আমাদের চেনা খাবার। কাচ্চি দমে রান্না হয়, কাবাবে লাগে কয়লার আঁচ। টেবিলে আরেকজনের জন্য জায়গা সবসময়ই আছে।",
              )}
            </p>
            <div className="story-points">
              <span>
                <Soup size={20} />
                {t("Slow-cooked favourites", "দমে রান্না পছন্দের পদ")}
              </span>
              <span>
                <Flame size={20} />
                {t("Charcoal-kissed grills", "কয়লার আঁচের গ্রিল")}
              </span>
            </div>
            <Button to="/about" secondary arrow>
              {t("Get to know Angar", "আঙারের গল্প জানুন")}
            </Button>
          </div>
        </div>
      </section>

      <section className="container gathering-section">
        <div className="gathering-card">
          <div>
            <Eyebrow light>
              {t("YOUR PEOPLE, YOUR OCCASION", "আপনার আপনজন, আপনার আয়োজন")}
            </Eyebrow>
            <h2>
              {t("Make it a", "স্মরণীয় হোক")}
              <br />
              <em>{t("table to remember.", "আপনার আয়োজন।")}</em>
            </h2>
            <p>
              {t(
                "Birthdays, family get-togethers, or a well-earned team dinner. Tell us what you have in mind. We’ll help you plan the rest.",
                "জন্মদিন, পরিবারের সবাই বা টিমের ডিনার। আপনার আয়োজনের কথা জানান, বাকি পরিকল্পনায় আমরা পাশে থাকব।",
              )}
            </p>
            <Button to="/events" gold arrow>
              {t("Plan your gathering", "আপনার ইভেন্টের পরিকল্পনা")}
            </Button>
          </div>
          <div className="gathering-image">
            <img
              src="/assets/dining-room.webp"
              alt={t(
                "A setting for a private gathering",
                "প্রাইভেট অনুষ্ঠানের ডাইনিং রুম",
              )}
              loading="lazy"
            />
            <span>
              {t("A little more personal.", "আরও একটু আপন আয়োজন।")}
              <ArrowUpRight size={20} />
            </span>
          </div>
        </div>
      </section>

      <section className="container visit-strip">
        <span className="visit-icon">
          <MapPin size={27} />
        </span>
        <div>
          <Eyebrow>{t("SEE YOU AT ANGAR", "দেখা হবে আঙারে")}</Eyebrow>
          <h2>
            {t("There’s a place for you here.", "আপনার জন্য জায়গা আছে এখানে।")}
          </h2>
        </div>
        <div className="visit-details">
          <strong>{restaurant?.location || "Dhanmondi, Dhaka"}</strong>
          <span>{restaurant?.hours || "12:00 PM – 10:30 PM"}</span>
        </div>
        <Button to="/menu" secondary arrow>
          {t("Find your favourite", "পছন্দের খাবার বাছুন")}
        </Button>
      </section>
    </>
  );
}
