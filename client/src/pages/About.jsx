import { Flame, Heart, Soup } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { Button, Eyebrow } from "../components/UI";

export function About() {
  const { t } = useApp();
  return (
    <div className="about-page">
      <section className="container about-hero">
        <div>
          <Eyebrow>
            {t("A KITCHEN CALLED ANGAR", "আঙার নামের এক রান্নাঘর")}
          </Eyebrow>
          <h1>
            {t("Food that brings", "যে খাবার আপন করে")}
            <br />
            <em>{t("us closer.", "কাছে টানে।")}</em>
          </h1>
          <p>
            {t(
              "There is something about a meal shared around a table. The rice, the warmth, the conversation that goes on a little longer. That feeling is what Angar is made for.",
              "এক টেবিলে ভাগ করে খাওয়ার মাঝে অন্যরকম আনন্দ। খাবারের ঘ্রাণ, উষ্ণতা আর একটু বেশি সময় ধরে চলা গল্প। সেই অনুভূতিই আঙারের আয়োজন।",
            )}
          </p>
          <Button to="/menu" arrow>
            {t("A taste of Angar", "আঙারের স্বাদ নিন")}
          </Button>
        </div>
        <div className="about-hero-photo">
          <img
            src="/assets/dining-room.webp"
            alt={t("Angar’s sample dining room", "আঙারের নমুনা ডাইনিং রুম")}
            fetchPriority="high"
          />
          <span>
            <Heart size={17} />
            {t(
              "Made for the people around your table.",
              "আপনার টেবিলের মানুষগুলোর জন্য।",
            )}
          </span>
        </div>
      </section>
      <section className="container about-values">
        {[
          [
            Soup,
            "Time in the pot",
            "দমে রান্নার সময়",
            "Our kacchi is inspired by the fragrant dum pots of Dhaka.",
            "ঢাকার সুগন্ধি দমের হাঁড়ির স্বাদে অনুপ্রাণিত আমাদের কাচ্চি।",
          ],
          [
            Flame,
            "A little fire",
            "কয়লার আঁচ",
            "The grills bring a smoky, just-cooked warmth to the table.",
            "গ্রিলের ধোঁয়াটে স্বাদ আর গরম খাবারের উষ্ণতা থাকে টেবিলে।",
          ],
          [
            Heart,
            "Room to gather",
            "একসঙ্গে হওয়ার জায়গা",
            "A quick meal or a special occasion. There is a reason to sit down together.",
            "ঝটপট খাবার বা বিশেষ অনুষ্ঠান, একসঙ্গে বসার একটা উপলক্ষ থাকুক।",
          ],
        ].map(([Icon, en, bn, description, bnDescription]) => (
          <article key={en}>
            <span>
              <Icon size={29} strokeWidth={1.3} />
            </span>
            <h2>{t(en, bn)}</h2>
            <p>{t(description, bnDescription)}</p>
          </article>
        ))}
      </section>
      <section className="container about-table">
        <img
          src="/assets/hero-kacchi.webp"
          alt={t("A platter of mutton kacchi", "মাটন কাচ্চির থালা")}
          loading="lazy"
        />
        <div>
          <Eyebrow>
            {t("FAMILIAR, WITH A LITTLE ANGAR", "চেনা খাবারে আঙারের ছোঁয়া")}
          </Eyebrow>
          <h2>
            {t("Come for the food.", "খাবারের টানে আসুন।")}
            <br />
            <em>{t("Stay for the table.", "গল্পের টেবিলে থাকুন।")}</em>
          </h2>
          <p>
            {t(
              "Start with kacchi. Add something from the grill. Finish with a glass of borhani and a little phirni. Your table, your way.",
              "কাচ্চি দিয়ে শুরু করুন। সঙ্গে গ্রিলের কিছু যোগ করুন। শেষে বোরহানি আর একটু ফিরনি। আপনার টেবিল আপনার পছন্দে।",
            )}
          </p>
          <Button to="/events" secondary arrow>
            {t("Bring your people", "আপনজনদের নিয়ে আসুন")}
          </Button>
        </div>
      </section>
    </div>
  );
}
