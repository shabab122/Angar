import { cleanText, selectedDishes } from "./chatbot-catalog.js";

export function assistantReply(catalog, plan, language) {
  const t = (en, bn) => (language === "bn" ? bn : en);
  const result = { text: "", dishes: [], links: [], language, filters: null };
  const link = (to, en, bn) => result.links.push({ to, label: t(en, bn) });
  const restaurant = catalog.restaurant;
  switch (plan.intent) {
    case "recommend": {
      result.dishes = selectedDishes(catalog, plan);
      result.filters = {
        budget: plan.budget,
        people: plan.people,
        spice: plan.spice,
        category: plan.category,
      };
      if (!result.dishes.length)
        result.text = t(
          "I couldn’t find an available dish matching all those preferences. Try a different budget, spice level or category.",
          "সব পছন্দের সঙ্গে মেলে এমন পাওয়া যাচ্ছে এমন খাবার পেলাম না। বাজেট, ঝাল বা খাবারের ধরন বদলে বলুন।",
        );
      else if (
        plan.sort === "rating" &&
        result.dishes.some((dish) => dish.rating)
      )
        result.text = t(
          "These are the highest-rated available matches in this branch, using approved public guest ratings. Review counts are shown with each rating.",
          "এই branch-এর পাওয়া যাচ্ছে এমন মিলগুলোর মধ্যে অতিথিদের প্রকাশিত ও অনুমোদিত রেটিং অনুযায়ী এগুলো সেরা। প্রতিটি রেটিংয়ের সঙ্গে রিভিউয়ের সংখ্যা দেখানো আছে।",
        );
      else if (
        plan.sort === "popular" &&
        result.dishes.some((dish) => dish.basis === "popular")
      )
        result.text = t(
          "These available picks are ordered by quantities in completed orders from this branch over the last 30 days.",
          "গত ৩০ দিনে এই branch-এর সম্পন্ন অর্ডারে খাবারের পরিমাণ অনুযায়ী পাওয়া যাচ্ছে এমন পছন্দগুলো সাজিয়েছি।",
        );
      else if (plan.sort === "value")
        result.text = t(
          "Here are the lowest-priced available matches for your group. Each card is a separate option, not a combined meal.",
          "আপনার দলের জন্য পাওয়া যাচ্ছে এমন কম দামের মিলগুলো এখানে। প্রতিটি card আলাদা পছন্দ, একসঙ্গে একটি meal নয়।",
        );
      else
        result.text = t(
          "There aren’t enough published guest ratings or completed-order records to make that ranking yet. Here are available menu options, with house signatures first. Sample reviews are not counted as guest ratings.",
          "এখনো ওই তালিকা করার মতো প্রকাশিত অতিথি-রেটিং বা সম্পন্ন অর্ডারের তথ্য নেই। পাওয়া যাচ্ছে এমন খাবারগুলোতে house signature আগে দেখাচ্ছি। নমুনা রিভিউ অতিথিদের রেটিং হিসেবে ধরা হয়নি।",
        );
      link("/menu", "Explore the full menu", "সম্পূর্ণ মেনু দেখুন");
      break;
    }
    case "details": {
      result.dishes = selectedDishes(catalog, plan);
      result.text = result.dishes.length
        ? t(
            "Here are the current menu details. Availability and the listed base price are shown on each card; view the dish to review sizes and add-ons.",
            "বর্তমান মেনুর তথ্য এখানে। প্রতিটি card-এ প্রাপ্যতা ও মূল দাম আছে; পরিমাণ ও add-on দেখতে খাবারের বিবরণ খুলুন।",
          )
        : t(
            "I couldn’t match that dish name in this branch. Please use its menu name or open the full menu.",
            "এই branch-এ ওই নামে খাবার মেলাতে পারিনি। মেনুর নাম দিয়ে বলুন বা সম্পূর্ণ মেনু দেখুন।",
          );
      link("/menu", "View menu", "মেনু দেখুন");
      break;
    }
    case "hours":
      result.text =
        t("The posted opening hours for ", "প্রকাশিত খোলার সময়: ") +
        cleanText(restaurant.branch || restaurant.name, 80) +
        ": " +
        cleanText(restaurant.hours, 180) +
        t(
          ". I can show the posted hours; staff can confirm holiday changes.",
          "। ছুটির দিনের পরিবর্তন স্টাফের কাছে নিশ্চিত করুন।",
        );
      link("/about", "About this restaurant", "রেস্টুরেন্ট সম্পর্কে");
      break;
    case "location":
      result.text =
        t(
          "This branch’s posted location is ",
          "এই branch-এর প্রকাশিত ঠিকানা: ",
        ) +
        cleanText(restaurant.location, 220) +
        t(
          ". Parking and accessibility details should be confirmed with staff.",
          "। পার্কিং ও প্রবেশের সুবিধা স্টাফের কাছে নিশ্চিত করুন।",
        );
      link("/about", "View restaurant information", "রেস্টুরেন্টের তথ্য দেখুন");
      break;
    case "ordering":
      result.text =
        restaurant.orderingEnabled === false
          ? t(
              "This branch has paused new ordering. You can still browse the menu; ask staff when ordering will resume.",
              "এই branch-এ নতুন অর্ডার আপাতত বন্ধ। মেনু দেখা যাবে; আবার অর্ডার নেওয়ার সময় স্টাফের কাছে জানুন।",
            )
          : t(
              "For table ordering, scan the table QR, choose dishes and options, then review your cart and place the order. Staff confirms it before cooking. My orders also has the table assistance and bill-request controls when a table visit is active.",
              "টেবিল থেকে অর্ডার দিতে QR স্ক্যান করে খাবার ও option বেছে cart review করে অর্ডার দিন। রান্নার আগে স্টাফ গ্রহণ করবেন। টেবিল visit সক্রিয় থাকলে আমার অর্ডার পেজে সাহায্য ও বিল চাওয়ার controls-ও পাবেন।",
            );
      link("/menu", "Choose dishes", "খাবার বেছে নিন");
      link("/orders", "My orders & table help", "আমার অর্ডার ও টেবিল সহায়তা");
      break;
    case "order_status":
      result.text = t(
        "Open My orders to see the latest status of orders owned by your signed-in account or this browser. I can guide you there; I haven’t changed or inspected any private order in this chat.",
        "আপনার account বা এই browser-এর অর্ডারের সর্বশেষ অবস্থা দেখতে আমার অর্ডার খুলুন। সেখানেই private order-এর তথ্য দেখবেন; এই chat-এ কোনো অর্ডার পরিবর্তন করা হয়নি।",
      );
      link("/orders", "Track my table order", "টেবিলের অর্ডার দেখুন");
      link("/takeaway", "Track pickup / delivery", "টেকঅ্যাওয়ে / ডেলিভারি দেখুন");
      break;
    case "reservations":
      result.text = t(
        "The reservations page lets you check a date, time and party size, and manage your own booking or waiting-list entry. A table is booked only after you complete that page and receive confirmation.",
        "বুকিং পেজে তারিখ, সময় ও সদস্যসংখ্যা দিয়ে খালি টেবিল এবং নিজের বুকিং বা waiting list দেখুন। ওই পেজে প্রক্রিয়া সম্পন্ন করে confirmation পাওয়ার পরই বুকিং হবে।",
      );
      link(
        "/reservations",
        "Check tables & waiting list",
        "টেবিল ও অপেক্ষার তালিকা দেখুন",
      );
      break;
    case "payment":
      result.text = t(
        "Your final bill or checkout shows the current total, discounts and configured charges. Table bills support split or partial counter payments; pickup/delivery requires full payment for collection or completed handover. Use the available payment options there. Staff reviews refund requests; this chat does not charge or refund money.",
        "চূড়ান্ত bill বা checkout-এ মোট দাম, ছাড় ও প্রযোজ্য charge দেখুন। টেবিলের বিলে ভাগ বা আংশিক counter payment আছে; pickup/delivery গ্রহণ বা সম্পূর্ণ হস্তান্তরের জন্য পুরো payment লাগে। সেখানে দেখানো option ব্যবহার করুন। Refund-এর জন্য স্টাফের review লাগে; chat থেকে টাকা কাটা বা ফেরত দেওয়া হয় না।",
      );
      link("/orders", "Open my bill", "আমার বিল খুলুন");
      link(
        "/takeaway",
        "Pickup / delivery checkout",
        "টেকঅ্যাওয়ে / ডেলিভারি checkout",
      );
      break;
    case "delivery":
      result.text =
        t("Pickup: ", "Pickup: ") +
        (catalog.fulfillment.pickupEnabled
          ? t("enabled", "চালু")
          : t("not enabled", "চালু নেই")) +
        t(". Delivery: ", "। Delivery: ") +
        (catalog.fulfillment.deliveryEnabled
          ? t("enabled", "চালু")
          : t("not enabled", "চালু নেই")) +
        t(
          ". The pickup/delivery page shows configured areas, fees and available times before you confirm. Staff must accept the request; estimates are not a guaranteed arrival time.",
          "। নিশ্চিত করার আগে টেকঅ্যাওয়ে / ডেলিভারি পেজে এলাকা, ফি ও সময় দেখুন। স্টাফকে request গ্রহণ করতে হবে; সময়ের estimate নিশ্চিত arrival time নয়।",
        );
      link(
        "/takeaway",
        "Review pickup & delivery",
        "টেকঅ্যাওয়ে ও ডেলিভারি দেখুন",
      );
      break;
    case "events":
      result.text = t(
        "For a larger group or private event, review spaces, capacity and packages on Private dining and submit an inquiry. Staff confirms availability, the quote and any deposit; nothing is reserved by this chat.",
        "বড় দল বা অনুষ্ঠানের জন্য Private dining-এ জায়গা, ধারণক্ষমতা ও package দেখে inquiry দিন। স্টাফ সময়, quote ও deposit নিশ্চিত করবেন; chat থেকে কোনো জায়গা reserve হয়নি।",
      );
      link("/events", "Plan a private event", "অনুষ্ঠান পরিকল্পনা করুন");
      break;
    case "loyalty":
      result.text = t(
        "Sign in to view your shared loyalty balance and branch-labelled order history. Current coupons and eligible points are reviewed on the bill or checkout; this chat does not promise a discount or change points.",
        "Sign in করে সব branch-এর shared points balance ও branch-সহ order history দেখুন। Bill বা checkout-এ বর্তমান coupon ও ব্যবহারযোগ্য points যাচাই হবে; chat কোনো ছাড় নিশ্চিত বা points পরিবর্তন করে না।",
      );
      link("/account", "My account & rewards", "আমার account ও rewards");
      break;
    case "allergy":
      result.text = t(
        "The menu does not contain verified allergen, dietary-certification or cross-contact data. I cannot confirm that a dish is safe for an allergy, vegan, vegetarian or halal requirement. Ask staff to confirm ingredients and preparation before ordering.",
        "মেনুতে যাচাইকৃত allergen, dietary certification বা cross-contact-এর তথ্য নেই। কোনো খাবার allergy, vegan, vegetarian বা halal চাহিদার জন্য নিরাপদ বলে নিশ্চিত করতে পারি না। অর্ডারের আগে ingredients ও প্রস্তুতি স্টাফের কাছে নিশ্চিত করুন।",
      );
      link("/menu", "Read dish descriptions", "খাবারের বিবরণ দেখুন");
      link("/orders", "Table assistance", "টেবিলে সহায়তা");
      break;
    default:
      result.text =
        plan.intent === "out_of_scope"
          ? t(
              "I can help with this restaurant’s menu and your visit. Ask about highly rated dishes, a food budget, spice preferences, opening hours, ordering or reservations.",
              "এই রেস্টুরেন্টের মেনু ও আপনার visit নিয়ে সাহায্য করতে পারি। সেরা রেটিংয়ের খাবার, বাজেট, ঝাল, খোলার সময়, অর্ডার বা বুকিং নিয়ে বলুন।",
            )
          : t(
              "Welcome! Ask me about highly rated dishes, popular picks, a budget for your group, spice preferences, dish details or planning your visit.",
              "স্বাগতম! সেরা রেটিংয়ের খাবার, জনপ্রিয় পদ, দলের বাজেট, ঝাল, খাবারের বিবরণ বা আপনার visit নিয়ে জিজ্ঞেস করুন।",
            );
      link("/menu", "Explore menu", "মেনু দেখুন");
      link("/reservations", "Reserve a table", "টেবিল বুকিং");
  }
  return result;
}
