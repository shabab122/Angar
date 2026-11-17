export const restaurantDefaults = {
  _id: "restaurant",
  name: "Angar Kitchen",
  branch: "Dhanmondi",
  location: "Dhanmondi, Dhaka",
  hours: "12:00 PM – 10:30 PM",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=Dhanmondi%2C+Dhaka",
  orderingEnabled: true,
  serviceChargeBps: 0,
  sample: true,
};

export async function restaurantSettings(store, session) {
  return {
    ...restaurantDefaults,
    ...(await store.settings.findOne({ _id: "restaurant" }, { session })),
  };
}

export function publicSettings(settings) {
  const {
    name,
    branch,
    location,
    hours,
    mapUrl,
    orderingEnabled,
    serviceChargeBps,
    sample,
  } = settings;
  return {
    name,
    branch,
    location,
    hours,
    mapUrl,
    orderingEnabled,
    serviceChargeBps,
    sample,
  };
}

export function normalizeDish(dish) {
  return { variants: [], addons: [], serves: 1, spice: "medium", ...dish };
}

export function publicReview(review) {
  const {
    _id,
    rating,
    comment,
    liked,
    improve,
    createdAt,
    source,
    reply,
    imageFile,
  } = review;
  return {
    id: _id.toString(),
    rating,
    comment,
    liked,
    improve,
    createdAt,
    sample: source === "sample",
    reply: reply || "",
    photo: imageFile ? "/api/review-media/" + imageFile : null,
  };
}
