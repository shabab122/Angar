# Angar Kitchen React v2.2 — Upgrade, payment setup ও feature guide

এই release-এর base `Angar_Kitchen_React_v2.1.zip`। নির্বাচিত পাঁচটি কাজ: split/partial bills, SSLCOMMERZ, customer accounts, coupons/loyalty এবং reservations/waiting list। পুরোনো home/brand assets, React–Node.js–Express–MongoDB stack, guest QR ordering, kitchen/waiter workflow, reviews ও private dining রাখা হয়েছে।

## ১. পুরোনো database রেখে upgrade

1. পুরোনো Node app-এ `Ctrl+C` দিন। পুরোনো folder ও database backup রাখুন। MongoDB চালু রাখুন।
2. নতুন ZIP আলাদা folder-এ extract করুন। পুরোনো `.env` নতুন `angar-kitchen-react` folder-এ copy করুন। একই `MONGODB_URI`, `MONGODB_DB`, `COOKIE_SECRET` ও `APP_ORIGIN` রাখুন।
3. Photo আগে upload করা থাকলে পুরোনো `data/reviews` copy করুন বা একই `UPLOAD_DIR` ব্যবহার করুন।
4. Node.js **24+** দিয়ে নতুন project folder-এ চালান:

```bash
npm ci
npm run setup
npm run build
npm start
```

পুরোনো database-এ demo seed দরকার নেই। নতুন folder থেকে আরেকটি Docker Compose instance চালাবেন না; একই port-এ দ্বিতীয় database/অন্য volume হতে পারে। New collections/indexes startup-এ তৈরি হয়। Data reset বা destructive migration নেই। Staff password reset হয় না।

Website: http://localhost:3000 · Staff: http://localhost:3000/staff। Fresh install-এর Docker/Podman/Atlas instructions `README.md`-এ আছে।

## ২. Split bills এবং partial receipts

`cashier` বা `admin` → **Counter & bills** → সব order Served হওয়ার পরে **Finalize table bill**। Guest-এর coupon/points selection থাকলে সেটি তখন পুনরায় যাচাই ও প্রয়োগ হয়।

**Payments & splits → Set / change splits** থেকে:

| Mode | নিয়ম |
|---|---|
| Equal shares | ২–১২ ভাগ; অতিরিক্ত paisa স্থির ক্রমে ভাগ হয়, মোট অপরিবর্তিত থাকে। |
| Ordering customer/device | Signed-in account বা guest ordering browser অনুযায়ী খাবার একত্র করে ভাগ হয়। এটি বাস্তব ব্যক্তির identity verification নয়। |
| Custom amounts | প্রতিটি ভাগের BDT amount লিখুন; সব ভাগের মোট final bill-এর সমান হতে হবে। |
| Item quantities | প্রতিটি whole portion একবার বরাদ্দ করুন। Discount/service charge খাবারের মূল্যের অনুপাতে paisa পর্যন্ত ভাগ হয়। |

প্রথম receipt বা pending online attempt-এর পরে split structure আর বদলানো যায় না। প্রতিটি counter receipt-এ share, amount, method ও verified reference/confirmation দিন। একই request retry হলে টাকা দুবার জমা হয় না; available balance-এর বেশি receipt নেওয়া যায় না।

Partial payment-এর পরে table visit খোলা থাকে, কিন্তু finalized bill-এ নতুন order ঢোকে না। Remaining balance শূন্য হলে table বন্ধ হয়। Receipt-এ payment ledger ও প্রতিটি share-এর balance দেখা যায়। Full-discount zero-total bill নিজে paid হয়; zero-value cash receipt লাগে না।

**পুরোনো bills:** Existing unpaid/paid bills সংরক্ষিত থাকে। পুরোনো unpaid bill-এ line/customer snapshot না থাকলে equal/amount split ব্যবহার করুন; item/customer split কেবল নতুন snapshot-সহ bills-এ কাজ করে।

## ৩. SSLCOMMERZ configure করুন

Implementation এবং provider-contract tests দেওয়া আছে। **নিজের merchant credentials/public callback ছাড়া real checkout চালু নয়। এই ZIP তৈরি করার সময় real merchant sandbox/live charge করা হয়নি।**

নিজের SSLCOMMERZ sandbox/merchant account-এর তথ্য server-এর `.env`-এ দিন:

```dotenv
SSLCOMMERZ_MODE=sandbox
SSLCOMMERZ_STORE_ID=YOUR_SANDBOX_STORE_ID
SSLCOMMERZ_STORE_PASSWORD=YOUR_SANDBOX_STORE_PASSWORD
SSLCOMMERZ_PUBLIC_ORIGIN=https://YOUR_PUBLIC_DOMAIN
APP_ORIGIN=https://YOUR_PUBLIC_DOMAIN
```

এগুলো placeholder; নিজের আসল values বসাতে হবে। Public browser test-এর জন্য domain-টি এই Express app-এ পৌঁছাতে হবে। শুধু `localhost` provider-এর IPN পৌঁছানোর জন্য যথেষ্ট নয়। HTTPS hosting বা নিজের trusted HTTPS tunnel ব্যবহার করলে একই public origin দিয়ে website খুলুন। Credentials কখনো `VITE_*`, frontend code বা Git-এ দেবেন না।

Sandbox পরীক্ষা আলাদা test database-এ করুন, যেমন `MONGODB_DB=angar_sandbox`। Sandbox-এ verified simulated payment-ও test bill বন্ধ করে; তাই test ও live restaurant data মেশাবেন না।

Merchant panel-এর IPN URL:

```text
https://YOUR_PUBLIC_DOMAIN/api/payments/sslcommerz/ipn
```

App success/failure/cancel return URLs session তৈরির সময় পাঠায়। `SSLCOMMERZ_PUBLIC_ORIGIN`-এ trailing slash/path রাখবেন না। Live করতে নিজের live merchant credentials, `SSLCOMMERZ_MODE=live`, public HTTPS এবং production environment configuration দিন; আগে নিজের sandbox acceptance test সম্পন্ন করুন।

### Guest checkout

1. Table QR থেকে order দিন; restaurant serve/finalize করবে।
2. **My orders → Your table bill** থেকে share/amount দিন, receipt name/email/phone ও provider-এ তথ্য পাঠানোর consent দিন।
3. **Continue to secure checkout** provider-এর hosted checkout খুলবে। Card data app নিজে নেয় না।
4. Return page-এ status ও balance দেখুন। Server provider validation API দিয়ে transaction ID, amount, BDT currency ও bank reference মিলিয়েই bill credit করে। Browser-এর success text বা redirect একা paid করতে পারে না।

### Pending attempt, risk ও reconciliation

- Checkout creation-এর আগে amount reserve হয়। সেই reserved amount কাউন্টারে আবার নেওয়া যায় না।
- IPN/retry/reconciliation একই payment দ্বিতীয়বার যোগ করে না। Unverified browser cancel বা local timeout নিজে hold ছাড়ে না।
- `cashier/admin → Online payments → Recheck provider` দিয়ে authoritative status দেখুন। Confirmed failed/cancelled/expired attempt-এর hold ছাড়া হয়। Unknown/pending status-এ পুনরায় টাকা নেওয়ার আগে provider-এর তথ্য মেলাতে হবে।
- Provider risk flag থাকলে automatic credit বন্ধ থাকে। Admin merchant checks সম্পন্ন করে reason-সহ **Review verified risk** ব্যবহার করতে পারেন। Provider এখনও transaction verify করবে।
- বিরল late/extra verified funds balance-এর বেশি হলে `overpayment_review` record হয়; bill negative balance হয় না। Manager-কে provider-এ manual reconciliation/refund করতে হবে। Automatic refunds এই নির্বাচিত scope-এ নেই।
- Gateway mode/merchant বদলে পুরোনো attempt reconcile করতে গেলে আগের configuration restore করতে হবে। Pending attempts ছেড়ে নতুন merchant mode-এ চলে যাবেন না।

**Official API reference:** https://developer.sslcommerz.com/doc/v4/ । API transport tests controlled responses ব্যবহার করে; production app-এ কোনো fake payment-success endpoint নেই।

## ৪. Customer accounts এবং reorder

Header-এর account icon → **Create account**। Name, email, minimum ১২-character password এবং optional phone দিন। Login/profile/password change, device session revocation, order history ও points wallet আছে। Email বর্তমানে login identifier; email ownership verification, email delivery বা forgotten-password recovery এই release-এ যোগ হয়নি।

Guest ordering চালু থাকে। Sign-in-এর সময় একই signed browser cookie-এর unclaimed orders/reservations account-এর সঙ্গে যুক্ত হয়। Account orders logout-এর পরে guest হিসেবে দেখা যায় না; একই account অন্য device-এ login করলে history দেখা যায়। Cookie/credentials পরিষ্কার করার আগে প্রয়োজনীয় account access নিশ্চিত করুন।

**Order again** পুরোনো খাবারের বর্তমান price, variant, add-on ও availability পরীক্ষা করে। Unavailable selections/warnings দেখায়। Confirm করলে cart প্রস্তুত হয়; নিজে থেকে order place হয় না। Existing cart থাকলে replace করার আগে confirmation আছে। নতুন order দিতে active table QR এখনও প্রয়োজন।

## ৫. Coupons এবং loyalty rules

Admin → **Coupons & loyalty → Create coupon**। Fixed BDT বা percentage, start/end (Bangladesh time), minimum food spend, maximum discount, total uses, per-account uses, enabled এবং public/code-only বেছে নিন। Coupon code unique। Past bill snapshots বদলায় না। কোনো default coupon নিজে থেকে seed করা হয় না।

Guest account → offers দেখে **My orders → table bill** থেকে **bill finalize হওয়ার আগে** coupon/points দিন। Guest-কে ঐ table visit-এ account দিয়ে order করতে হবে। এক table bill-এ এক coupon; অন্য member-এর selected benefits বদলাতে cashier reason দিয়ে clear করতে পারেন। Finalize করার সময় expiry, limits ও balance আবার যাচাই হয়।

- Food subtotal-এ আগে coupon discount হয়। এরপর points দিয়ে অবশিষ্ট food subtotal-এর সর্বোচ্চ **২০%** কমানো যায়।
- **১ point = ১ BDT**। Fractional points নেই।
- পুরো bill paid হলে member-এর নিজের food value, discount-এর পরে, প্রতি **১০০ BDT-তে ১ point** যোগ হয়; service charge-এ points হয় না।
- Member ownership bill finalize হওয়ার সময় snapshot হয়; তার আগে sign in করুন। পুরোনো already-finalized/paid guest bills-এর জন্য retroactive points যোগ হয় না।
- Coupon use/points redemption finalization-এ reserve/debit হয়; duplicate finalization/payment retry দ্বিতীয়বার points কাটে/দেয় না। Multiple member orders থাকলে food ownership অনুযায়ী earning ভাগ হয়।
- An unpaid finalized bill-এর selected coupon/points ইতিমধ্যেই bill-এ committed। Paid bill edit/automatic refund এখানে যোগ হয়নি।

## ৬. Reservations এবং waiting list

Website → **Reserve a table**। Party/name/contact/date/time দিন। Account optional; guest booking এই browser-এ থাকে। Availability preview দেখানো হলেও booking transaction আবার capacity ও overlap দেখে confirm করে। একই table/time-এর concurrent booking একসঙ্গে confirm হতে পারে না।

Defaults: Bangladesh time, **12:00–22:30**, half-hour start slots, **৯০ মিনিট** seating, কমপক্ষে **৩০ মিনিট** আগে এবং সর্বোচ্চ **৯০ দিন** আগে booking। Existing table capacity default চার। Admin → **Reservations & queue** থেকে বাস্তব capacity ও booking hours/duration/window দিন। Public restaurant hours এবং booking settings নিজের venue অনুযায়ী মিলিয়ে রাখুন। Existing reservations-এর times settings পরিবর্তনে বদলায় না।

Single-room planning-এ overlapping held/confirmed private gatherings normal table reservations block করে; reservation থাকলেও conflicting private event quote hold নেওয়া যায় না। Physical area/table mapping এই release-এ নেই, তাই private-event conflict conservative।

Staff workflow:

1. `admin/waiter → Reservations & queue` থেকে date বেছে booking দেখুন।
2. Start-এর ৩০ মিনিট আগে থেকে slot শেষ হওয়ার মধ্যে, reserved table free থাকলে **Seat party** দিন। Table visit খুলবে; guest-কে QR আবার scan করতে বলুন।
3. Existing counter workflow-এ bill paid/table বন্ধ হলে reservation completed হয়। Occupied table-এ দ্বিতীয় visit ঢোকে না।
4. Guest start-এর আগে reason দিয়ে cancel করতে পারেন। Staff cancellation-এ reason লাগে। Start-এর ১৫ মিনিট পরে **No-show** করা যায়।

**Waiting list:** Opening hours-এ name/contact/party দিয়ে join। এক active party entry রাখা হয়; position দেখা যায়। Staff guest-কে বাস্তবে contact করার পরে **Mark party called** চাপবেন—এটি SMS/email পাঠায় না। Free/capacity-matching table বেছে **Seat waiting party** দিন। Future reservation/private-event conflict থাকলে seating আটকাবে। Table QR scan-এর পরে ordering আগের মতোই চলবে।

## ৭. Reports এবং receipts

Existing sales reports **fully settled table bills**-কে `paidAt` date অনুযায়ী গণনা করে। Unpaid partial receipts bill ledger-এ দেখা যায়; পুরো bill paid না হওয়া পর্যন্ত sales report-এ আসে না। এটি daily cash-flow/profit report নয়। Mixed payment breakdown receipt amounts থেকে আসে; food sales discount-এর পরে, popular dish values discount/service charge-এর আগে। Historical paid bills-ও রিপোর্টে থাকে।

## ৮. Acceptance checklist

```bash
npm test
```

Test MongoDB replica set চালু থাকতে হবে। Tests random isolated database তৈরি করে শেষে শুধু সেগুলো মুছে দেয়। Production connection দিয়ে test চালাবেন না।

- Guest QR → order → admin/kitchen/waiter → served আগের মতো পরীক্ষা করুন।
- Member account, cross-browser login/history, logout privacy এবং reorder preview দেখুন।
- Coupon/points apply করে finalize করুন; retry-তে দ্বিতীয়বার debit না হওয়া দেখুন।
- Odd-paisa equal split, amount/item split, partial counter receipt ও final zero balance দেখুন।
- নিজের merchant sandbox-এ hosted checkout, provider validation/IPN, duplicate notifications, failed/pending এবং reconciliation পরীক্ষা করুন।
- Two simultaneous table bookings, cancellation, seating, waiting-list call/seat এবং private-event conflicts দেখুন।
- Desktop ও mobile BN/EN layout, receipt print এবং CSV download পরীক্ষা করুন।

Suggested commit:

```text
feat: add Angar Kitchen v2.2 billing, memberships and reservations
```
