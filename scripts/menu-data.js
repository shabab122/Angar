export const menu = [
  {
    _id: "mutton-kacchi",
    name: "Dhakai Mutton Kacchi",
    nameBn: "ঢাকাই মাটন কাচ্চি",
    description:
      "Dum-cooked basmati, tender mutton, golden potato and crisp fried onions.",
    descriptionBn:
      "দমে রান্না করা বাসমতি চাল, নরম খাসির মাংস, সোনালি আলু ও বেরেস্তা।",
    category: "mains",
    price: 420,
    signature: true,
  },
  {
    _id: "chicken-tikka",
    name: "Charcoal Chicken Tikka",
    nameBn: "চারকোল চিকেন টিক্কা",
    description:
      "Yogurt-marinated chicken, charred over coals and served with lime.",
    descriptionBn: "দই ও মসলায় মাখানো কয়লায় পোড়া মুরগি, সঙ্গে লেবু।",
    category: "grill",
    price: 320,
  },
  {
    _id: "beef-seekh",
    name: "Beef Seekh Kebab",
    nameBn: "বিফ শিক কাবাব",
    description:
      "Hand-shaped beef skewers with toasted spices and green chutney.",
    descriptionBn: "হাতে গড়া গরুর মাংসের শিক কাবাব, সঙ্গে সবুজ চাটনি।",
    category: "grill",
    price: 290,
  },
  {
    _id: "beef-tehari",
    name: "Old Dhaka Beef Tehari",
    nameBn: "পুরান ঢাকার বিফ তেহারি",
    description:
      "Fragrant rice and slow-cooked beef with mustard oil and green chilli.",
    descriptionBn: "সরিষার তেল ও কাঁচা মরিচের ঘ্রাণে সুগন্ধি চাল আর গরুর মাংস।",
    category: "mains",
    price: 340,
  },
  {
    _id: "mint-borhani",
    name: "Mint Borhani",
    nameBn: "পুদিনা বোরহানি",
    description: "Chilled, spiced yogurt with fresh mint and a little tang.",
    descriptionBn: "পুদিনা আর হালকা মসলায় তৈরি ঠান্ডা টক দইয়ের পানীয়।",
    category: "drinks",
    price: 110,
  },
  {
    _id: "pistachio-phirni",
    name: "Pistachio Phirni",
    nameBn: "পেস্তা ফিরনি",
    description: "Slow-set rice pudding finished with cardamom and pistachios.",
    descriptionBn: "এলাচের ঘ্রাণে ঘন চালের ফিরনি, ওপরে পেস্তা কুচি।",
    category: "dessert",
    price: 150,
  },
].map((dish, position) => ({
  ...dish,
  position,
  available: true,
  serves: 1,
  spice: ["drinks", "dessert"].includes(dish.category)
    ? "mild"
    : dish._id === "beef-tehari"
      ? "hot"
      : "medium",
  variants:
    dish.category === "mains"
      ? [
          { id: "regular", name: "Regular", nameBn: "রেগুলার", price: 0 },
          {
            id: "hearty",
            name: "Hearty portion",
            nameBn: "বেশি পরিমাণ",
            price: 150,
          },
        ]
      : [],
  addons:
    dish.category === "mains"
      ? [
          {
            id: "extra-potato",
            name: "Extra potato",
            nameBn: "অতিরিক্ত আলু",
            price: 30,
          },
        ]
      : [],
  image: "/assets/" + dish._id + ".webp",
}));

export const sampleReviews = [
  [
    "mutton-kacchi",
    5,
    "The golden potato and fried onions were the best part.",
  ],
  ["mutton-kacchi", 5, "The rice was fragrant and the mutton was soft."],
  ["mutton-kacchi", 4, "Good portion. I would pair it with the borhani."],
  ["chicken-tikka", 5, "Smoky and juicy with a nice squeeze of lime."],
  ["chicken-tikka", 4, "The char on the edges was lovely."],
  ["beef-seekh", 5, "The green chutney went especially well with the kebab."],
  ["beef-tehari", 4, "A proper green chilli kick."],
  ["mint-borhani", 5, "Cold and tangy. A good match for kacchi."],
  ["pistachio-phirni", 4, "Creamy with just enough cardamom."],
];
