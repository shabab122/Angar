import { Heart, Plus, Star, ArrowUpRight, Flame } from "lucide-react";
import { useApp, categories } from "../lib/AppContext";

export function MenuCard({ dish, index = 0, compact = false }) {
  const {
    t,
    name,
    describe,
    money,
    favourites,
    toggleFavourite,
    setDishId,
    addItem,
  } = useApp();
  const category = categories.find((item) => item.id === dish.category);
  const liked = favourites.includes(dish._id);
  function add() {
    if (dish.variants?.length || dish.addons?.length) setDishId(dish._id);
    else addItem(dish);
  }
  return (
    <article
      className={"menu-card" + (compact ? " menu-card-compact" : "")}
      style={{ "--delay": (index % 3) * 65 + "ms" }}
    >
      <div className="menu-card-image">
        <button
          className="photo-button"
          type="button"
          onClick={() => setDishId(dish._id)}
          aria-label={t("View ", "বিবরণ দেখুন ") + name(dish)}
        >
          <img
            src={dish.image}
            alt={name(dish)}
            loading="lazy"
            width="512"
            height="512"
          />
        </button>
        {dish.signature && (
          <span className="dish-label">
            <Flame size={12} />
            {t("The signature", "বিশেষ পদ")}
          </span>
        )}
        {!dish.available && (
          <span className="dish-label sold-out">
            {t("Sold out", "শেষ হয়ে গেছে")}
          </span>
        )}
        <button
          type="button"
          className={"favourite-button" + (liked ? " is-liked" : "")}
          aria-label={t("Save ", "পছন্দে রাখুন ") + name(dish)}
          aria-pressed={liked}
          onClick={() => toggleFavourite(dish._id)}
        >
          <Heart size={17} fill={liked ? "currentColor" : "none"} />
        </button>
        <button
          className="image-open"
          type="button"
          aria-label={t("Dish details for ", "খাবারের বিবরণ ") + name(dish)}
          onClick={() => setDishId(dish._id)}
        >
          <ArrowUpRight size={20} />
        </button>
      </div>
      <div className="menu-card-body">
        <div className="dish-category-row">
          <span>{category && t(category.en, category.bn)}</span>
          <button
            type="button"
            className="rating"
            onClick={() => setDishId(dish._id)}
            aria-label={t("Reviews for ", "রিভিউ দেখুন ") + name(dish)}
          >
            <Star size={13} fill="currentColor" />
            {dish.rating ? (
              <>
                <strong>{dish.rating.average.toFixed(1)}</strong>
                <small>({dish.rating.count})</small>
              </>
            ) : (
              <small>{t("New", "নতুন")}</small>
            )}
          </button>
        </div>
        <h3>
          <button type="button" onClick={() => setDishId(dish._id)}>
            {name(dish)}
          </button>
        </h3>
        <p>{describe(dish)}</p>
        <div className="menu-card-bottom">
          <div className="dish-price">
            <strong>{money(dish.price)}</strong>
            <small>{t("per serving", "প্রতি পরিবেশন")}</small>
          </div>
          <button
            type="button"
            className="add-button"
            disabled={!dish.available}
            onClick={add}
            aria-label={t("Add ", "যোগ করুন ") + name(dish)}
          >
            <Plus size={16} />
            {t("Add", "যোগ করুন")}
          </button>
        </div>
      </div>
    </article>
  );
}
