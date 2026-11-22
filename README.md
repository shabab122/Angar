# Angar Kitchen · React v2.6

বাংলাদেশের রেস্টুরেন্টের জন্য React ওয়েবসাইট, QR টেবিল অর্ডারিং এবং আলাদা স্টাফ workspace। আগের Angar Kitchen-এর order/security rules রেখে frontend নতুনভাবে তৈরি হয়েছে। **Angar Kitchen একটি নমুনা ব্র্যান্ড**; ছবি, জায়গা, মূল্য, সময়, event capacity ও package নিজের রেস্টুরেন্ট অনুযায়ী বদলাতে হবে। `Sample review` লেখা ফিডব্যাক বাস্তব অতিথির রিভিউ নয়।

**প্রযুক্তি:** React + JavaScript + Vite, custom responsive CSS, Node.js 24, Express 5 এবং MongoDB। Frontend ও API একই Express server ও origin-এ চলে। Browser-এ MongoDB credentials দেওয়া হয় না। আপনার সর্বশেষ নির্দেশনা অনুসারে ডকুমেন্টের PostgreSQL-এর বদলে MongoDB ব্যবহার করা হয়েছে।


## v2.6 — এই release-এর পাঁচটি নতুন ফিচার

**Base: Angar_Kitchen_React_v2.5.zip।** Existing stack, guest design/assets এবং working features রেখে এই release তৈরি। Full upgrade/setup guide: [UPGRADE_v2.6_BN.md](UPGRADE_v2.6_BN.md)।

| ফিচার | কোথায় / কী যোগ হয়েছে |
|---|---|
| Physical stocktake | Physical stock counts: ingredient/lot snapshot, physical counts, manager review, transactional adjustments ও stale-count recount। |
| Supplier returns / credit notes | Supplier returns & credits: original receipt reservation, approval, physical handover, payable credit, actual supplier refund receipt ও cash drawer integration। |
| Expenses / operating result | Expenses & operating result: supported opening valuation, weighted recipe costs, approved operating expenses, partial actual payments ও VAT-exclusive management result / CSV। Historical costs missing হলে estimate দেখায়। |
| Kitchen tickets / thermal printer | Automatic revisioned KOTs, superseded old pending tickets, 80 mm browser receipt, optional operator-configured ASCII ESC/POS TCP printer, explicit physical confirmation ও marked reprints। |
| Automated staff alerts | Operations alerts: usable low stock, approaching/expired lots, overdue supplier balances, personal acknowledgement ও optional daily staff email digest। |

Existing installation-এ পুরোনো `.env`, database, photos/backups এবং original backup/MFA keys রাখুন; আলাদা folder-এ `npm ci`, `npm run setup`, `npm run build`, `npm start`। আবার seed/reset লাগবে না। Direct printer ও staff email default off; নিজের printer/SMTP settings ও acceptance test প্রয়োজন। New KOT creation ও in-app staff alerts external service ছাড়াই চলে।

## v2.5-এর সংরক্ষিত ছয়টি ফিচার

**Base: Angar_Kitchen_React_v2.4.zip।** আগের design/assets, React–Express–MongoDB stack ও working features রেখে এই সংযোজনগুলো হয়েছে। Existing data রেখে upgrade এবং নতুন configuration-এর পূর্ণ নির্দেশনা: [UPGRADE_v2.5_BN.md](UPGRADE_v2.5_BN.md)।

| ফিচার | কোথায় / কী যোগ হয়েছে |
|---|---|
| Audit dashboard | Admin → Staff activity: date/action/actor/search filters, pagination ও protected CSV। |
| Staff 2FA | My access: authenticator setup, password + code login, single-use recovery codes, optional required-admin policy ও audited recovery। |
| Off-site backups | Backups & recovery: private S3-compatible bucket-এ existing encrypted bundle copy, downloaded checksum verification, retries ও recovery CLI। নিজের bucket/credentials দরকার; default off। |
| Cash drawer / shifts | Admin/cashier → Cash drawer & shifts: opening count, cash receipts/refunds/deposits/supplier expenses, closing difference, admin review ও CSV। |
| Ingredient batches / expiry | Admin/kitchen → Batches & expiry: explicit opening lots, earliest-expiry allocation, alerts/quarantine, tracked returns ও preparation safety check। Existing ingredients default untracked। |
| Suppliers / purchases | Admin/cashier → Suppliers & purchases: supplier contacts, purchase drafts/approval, counted partial deliveries, lot-aware stock, received-goods payables ও verified payments। |

Existing installation-এ পুরোনো `.env`, MongoDB, photos/backups এবং encryption keys রাখুন; নতুন folder-এ `npm ci`, `npm run setup`, `npm run build`, `npm start`। আবার demo seed বা database reset লাগবে না। Setup missing MFA key যোগ করে; existing values রাখে। Real cloud delivery এবং payment/SMS/email provider acceptance নিজের credentials দিয়ে করতে হবে।

## v2.4-এর সংরক্ষিত চারটি ফিচার

**Base: Angar_Kitchen_React_v2.3.zip।** React–Express–MongoDB stack, পুরোনো design/assets এবং QR/table workflows রেখে নিচের সংযোজন করা হয়েছে।

| ফিচার | কোথায় / কীভাবে ব্যবহার করবেন |
|---|---|
| Automated backups / recovery | Admin → Backups & recovery। Encrypted database + referenced review photos, configurable schedule/retention, private download। প্রতিটি তৈরি backup আলাদা database/media folder-এ restore করে যাচাই হয়। Recovery CLI কখনও existing database overwrite করে না। |
| Event / excess-payment refunds | Admin/cashier → Refunds & credit notes → Event deposits & excess online payments। Original funds-এর পুরো/আংশিক request, admin approval, verified return / original-provider reconciliation ও credit note। Food sales/loyalty আলাদা থাকে। |
| Order / reservation alerts | `/notifications` → in-app, verified email, OTP-verified SMS ও permission-based Web Push। Order updates, এক ঘণ্টার মধ্যে booking reminder, waiting-list call। Admin → Notification delivery। SMTP/Twilio/Web Push নিজের credentials দিয়ে configure করতে হবে। |
| Takeaway / delivery | `/takeaway`; সব staff roles → Pickup & delivery। Admin hours/areas/fees চালু করেন; guest quote review, contact/address, requested time, acceptance, preparation, courier dispatch ও tracking। Existing invoices, stock, coupons/points, online/counter payment ও refunds যুক্ত আছে। |

**v2.3 থেকে upgrade:** আগের app বন্ধ করে নতুন ZIP আলাদা folder-এ extract করুন। আগের `.env` ও persistent review photos রাখুন; একই MongoDB ব্যবহার করুন। `npm ci` → `npm run setup` → `npm run build` → `npm start`। Existing database-এ seed/reset করবেন না। Setup নতুন backup/VAPID keys যোগ করে, আগের configured values রাখে। Backup key-এর আলাদা নিরাপদ copy রাখুন।

Pickup/delivery ও automatic backup schedule প্রথমে বন্ধ থাকে। Email/SMS/push-ও credentials ও opt-in ছাড়া বাস্তব বার্তা পাঠায় না। Pickup/delivery bills-এর নতুন policy হলো একবারে সম্পূর্ণ payment; dining-table splits/partial receipts আগের নিয়মেই থাকে। পূর্ণ setup, recovery ও acceptance guide: **`UPGRADE_v2.4_BN.md`**।

## v2.3-এর সংরক্ষিত ফিচার

**Base: Angar_Kitchen_React_v2.2.zip।** শুধু নির্বাচিত সংযোজন ও প্রয়োজনীয় integration hooks; পুরোনো guest pages/assets/design, tech stack ও workflows রাখা হয়েছে।

| ফিচার | ব্যবহার |
|---|---|
| Email verification / recovery | My account → verification email; Sign in → Forgot password। Expiring single-use links, secure reset ও session revocation। SMTP configure করতে হবে; local-only private outbox test mode আছে। |
| Full / partial refunds | Admin/cashier → Refunds & credit notes। Original settled receipt অনুযায়ী request, admin approval, confirmed return/provider reconciliation, credit notes, loyalty/coupon adjustments। |
| Staff accounts | Admin → Staff accounts। Individual users, role/active control, temporary password reset। All roles → My access। New temporary accounts নিজের password না দেওয়া পর্যন্ত workspace খুলতে পারে না। |
| Ingredient inventory | Admin/kitchen → Ingredients & recipes। Base units, receive/waste/corrections, low-stock alerts, base/size/add-on recipes ও immutable stock movements। Acceptance/approved edits/cancellation-এর সঙ্গে transaction-এ stock মেলে। |
| Tax/VAT / invoices | Admin → Tax & invoices। Inclusive/exclusive tax, configurable base/rate, invoice identity, prefix/sequence, immutable invoice snapshots ও tax credit notes। Tax default বন্ধ। |

**v2.2 থেকে upgrade:** পুরোনো app বন্ধ করে নতুন ZIP আলাদা folder-এ extract করুন। আগের `.env`, database connection ও uploaded photos রাখুন। MongoDB চালু রেখে নতুন folder-এ `npm ci`, `npm run setup`, `npm run build`, `npm start`। Existing data-তে seed/reset লাগবে না; নতুন optional fields/collections/indexes নিজে তৈরি হয়।

পুরোনো staff accounts/passwords, QR codes, unpaid/paid bills ও accounts রাখা হয়। Tax default ০/disabled, কোনো অনুমান করা recipe seed হয় না, পুরোনো queued order-এ stock retroactively কাটা হয় না। Full Bengali setup, SMTP/outbox, refunds, stock timing, tax rules ও acceptance guide: **`UPGRADE_v2.3_BN.md`**।

Real SMTP এবং real merchant sandbox/live payment/refund আপনার credentials দিয়ে configure ও acceptance-test করতে হবে। এই deliverable-এ controlled email/provider tests রয়েছে; কোনো বাস্তব অর্থ transfer বা mailbox delivery দাবি করা হয়নি।

## v2.2-এর সংরক্ষিত ফিচার

**Base: Angar_Kitchen_React_v2.1.zip।** আগের brand/design, React–Express–MongoDB stack, QR ordering, kitchen/floor flow, reviews ও events রেখে যোগ হয়েছে:

| ফিচার | কোথায় ব্যবহার করবেন |
|---|---|
| Split bills / partial payments | Cashier/Admin → Counter & bills → Finalize → Payments & splits। Equal, ordering customer/device, exact amount বা whole-item quantity দিয়ে ভাগ। প্রতিটি receipt একই bill balance কমায়; পুরোটা পরিশোধের পরই table বন্ধ হয়। |
| SSLCOMMERZ integration | Guest → My orders → final table bill → online checkout। Provider verification/IPN, duplicate protection, held amounts ও staff reconciliation। নিজের merchant credentials ও public HTTPS callback configure করতে হবে। |
| Customer accounts | Header-এর account icon → registration/login, profile, password change, points ও paginated order history। Order again বর্তমান দাম/options/availability যাচাই করে review করার জন্য cart প্রস্তুত করে। Guest QR ordering আগের মতোই আছে। |
| Coupons / loyalty | Admin → Coupons & loyalty। Guest account → offers; My orders → table bill → coupon/points নির্বাচন, bill finalize হওয়ার আগে। Expiry, minimum spend, global/account usage limits ও points ledger আছে। |
| Reservations / waiting list | Website → Reserve a table; Staff → Reservations & queue। সময়/party size অনুযায়ী booking, cancellation, no-show, reserved seating, waiting-list call/seat ও table capacity/settings। |

### v2.1 থেকে data রেখে upgrade

1. পুরোনো app-এ `Ctrl+C` দিন। Database চালু রাখুন; পুরোনো folder ও database backup রাখুন।
2. নতুন ZIP আলাদা folder-এ extract করুন। পুরোনো `.env` copy করুন; একই MongoDB URI/database, cookie secret ও origin রাখুন। পুরোনো photo থাকলে `data/reviews` copy করুন বা একই persistent `UPLOAD_DIR` দিন।
3. নতুন `angar-kitchen-react` folder-এ:

```bash
npm ci
npm run setup
npm run build
npm start
```

`setup` missing optional gateway fields যোগ করে; existing values বদলায় না। Existing database-এ demo seed লাগবে না। নতুন folder থেকে দ্বিতীয় Compose database চালাবেন না। New collections/indexes startup-এ তৈরি হয়; reset/destructive migration লাগবে না।

Website: http://localhost:3000 · Staff: http://localhost:3000/staff। **পুরো setup, payment terms, booking rules ও test checklist: `UPGRADE_v2.2_BN.md`।**

### গুরুত্বপূর্ণ payment setup

SSLCOMMERZ-এর implementation আছে; merchant account/credentials ছাড়া online টাকা কাটা যায় না। Default `sandbox`। `.env`-এ নিজের `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD` ও public `SSLCOMMERZ_PUBLIC_ORIGIN` দিন। Public browser testing-এ `APP_ORIGIN`-ও একই HTTPS origin রাখুন। `/api/payments/sslcommerz/ipn` merchant dashboard-এ IPN URL হবে। Live enable করার আগে merchant sandbox দিয়ে নিজে পূর্ণ acceptance test করুন। এই deliverable-এর gateway tests controlled provider responses দিয়ে যাচাই হয়েছে; real merchant sandbox/live charge করা হয়নি। Counter payment আগের মতোই কাজ করে।

## v2.1-এর সংরক্ষিত ফিচার

আগের React v2-এর design, menu, cart, billing, reviews, events ও technology stack রাখা হয়েছে। v2.1 release-এ যোগ হওয়া ফিচারগুলো v2.2-তেও রাখা হয়েছে:

| ফিচার | ব্যবহার |
|---|---|
| Waiter / bill requests | সক্রিয় টেবিলের menu থেকে request; একই type-এর pending request দুই ফোন থেকে করলেও একটিই থাকে। Guest `Waiting → Acknowledged → Completed` দেখেন। Admin/waiter-এর Floor requests-এ acknowledge/resolve ও সব tab থেকে pending badge/optional sound পাওয়া যায়। |
| Food availability | Admin/kitchen → **Food availability** থেকে এক ক্লিকে sold out/available। Kitchen price বা অন্য menu details বদলাতে পারে না। Guest menu প্রতি ৫ সেকেন্ডে refresh হয়; checkout transaction availability/price আবার যাচাই করে। Accepted order নিজে থেকে বাতিল হয় না। |
| Sales reports | Admin/cashier → **Sales reports**: date range, daily/monthly grouping, collected amount, food sales, service charge, average paid bill, paid-bill count, popular dishes ও payment breakdown। Summary/periods/items/payments-এর আলাদা CSV। |
| Kitchen timers / alerts | Order desk-এ total ও বর্তমান stage-এর timer। Awaiting staff ৫, queued ১০, cooking ২০, ready ৫ মিনিট পার হলে delayed। Admin/kitchen/waiter-কে নিজ station-এর নতুন ticket/change update এবং admin/waiter-কে নতুন floor request দেখায়। **Enable alerts** ক্লিক করলে sound চালু হয়। |
| Order changes / cancellation | Guest **My orders → Request changes / Request cancellation**। `placed`/`queued` অবস্থাতেই করা যায়। Quantity (০ দিলে line বাদ) ও kitchen note পরিবর্তন করা যায়; কারণ প্রয়োজন। Admin Order desk-এ reason দিয়ে approve/reject করবেন। Pending থাকলে cooking/dispatch বন্ধ থাকে; অনুমোদনের আগে মূল order/total বদলায় না। |

### বর্তমান v2 থেকে upgrade — আগে এটি পড়ুন

১. পুরোনো app terminal-এ `Ctrl+C` দিয়ে app বন্ধ করুন। MongoDB চালু রাখুন। নতুন ZIP আলাদা folder-এ extract করুন।

২. পুরোনো `.env` নতুন `angar-kitchen-react` folder-এ copy করুন। একই `MONGODB_URI`, `MONGODB_DB`, `COOKIE_SECRET` ও `APP_ORIGIN` রাখুন। আগের photo রাখতে পুরোনো `data/reviews` folder-ও copy করুন, অথবা একই persistent `UPLOAD_DIR` ব্যবহার করুন।

৩. নতুন folder-এ terminal খুলে একটির পর একটি চালান:

```bash
npm ci
npm run setup
npm run build
npm start
```

বিদ্যমান database-এর জন্য আবার demo seed লাগবে না। পুরোনো MongoDB চলতে থাকলে নতুন folder থেকে আরেকটি Compose instance চালাবেন না—অন্য volume/port conflict হতে পারে। App/index startup নতুন optional fields সমর্থন করে; database reset/migration command লাগবে না।

৪. Website: http://localhost:3000 · Staff: http://localhost:3000/staff। একই browser/domain ও cookie secret থাকলে guest history এবং আগের QR/session ব্যবহার করা যাবে।

**বিল/পরিবর্তনের নিয়ম:** Order edit-এ অর্ডারের মূল unit price/size/add-on snapshot থাকে; নতুন খাবার যোগ করার জন্য আলাদা order দিন। বাড়তি quantity approve করার সময় availability আবার যাচাই হয়। Pending request-এর আগে/পরে যা ছিল ও staff decision audit-এ থাকে। Cooking শুরু হয়ে গেলে এই release-এ guest change ও admin cancellation—দুটিই বন্ধ। Approved cancellation billing/sales-এ যোগ হয় না; paid bill পরিবর্তনের ব্যবস্থা এই update-এর অংশ নয়।

**Report-এর অর্থ:** Bangladesh time (Asia/Dhaka, UTC+6) অনুযায়ী `paidAt` দিয়ে inclusive date range, সর্বোচ্চ ৩৬৬ দিন। Collected = food + service charge। এটি profit report নয়; unpaid/finalized bills, cancelled orders ও event deposits বাদ। Popular dishes-এ saved dish name অনুযায়ী variants একত্র হয়; rename করা dish পুরোনো নামেও আলাদা row হতে পারে। CSV সব matched dish দেয়, screen-এ top ২০। পুরোনো paid bill-ও report-এ আসে।

**Alerts:** Dashboard খোলা ও connection সচল থাকলে polling-এর মাধ্যমে updates আসে; এটি SMS/push নয়। Sound-এর জন্য প্রতিটি station/browser session-এ **Enable alerts** চাপুন। Browser background/tab suspension হলে polling/audio থামতে পারে। Timer-এর threshold operational attention marker, promised cooking time নয়।

**যাচাই:** `npm test`-এ existing workflow ও v2.1 integration tests আছে। রান করার আগে test MongoDB replica set চালু রাখুন। এগুলো random test database তৈরি করে শেষে শুধু সেই test database মুছে দেয়। Browser acceptance checklist `UPGRADE_v2.1_BN.md`-এ দেওয়া হয়েছে।

## Windows CMD থেকে চালু করুন

প্রয়োজন: **Node.js 24**, **Docker Desktop with Compose** এবং প্রথমবার dependency/image নামানোর জন্য ইন্টারনেট। Docker Desktop চালু রাখুন। ZIP extract করে `angar-kitchen-react` ফোল্ডার খুলুন; যেখানে `package.json` আছে সেই ফোল্ডারের address bar-এ `cmd` লিখে Enter চাপুন। নিচের কমান্ডগুলো ক্রমানুসারে চালান। Linux/macOS terminal-এও একই কমান্ড কাজ করে।

```cmd
npm ci
npm run setup
docker compose up -d --wait
npm run seed -- --demo
npm run build
npm start
```

| কমান্ড | কাজ / প্রত্যাশিত ফল |
|---|---|
| `npm ci` | Lockfile অনুযায়ী React, Express ও dependencies install করে |
| `npm run setup` | `.env` এবং আলাদা staff password তৈরি করে; পুরোনো non-empty configuration রাখে |
| `docker compose up -d --wait` | Local MongoDB replica set চালু করে, primary হওয়ার জন্য অপেক্ষা করে |
| `npm run seed -- --demo` | ছয়টি খাবার, ছয়টি টেবিল, চার role ও চিহ্নিত sample review যোগ করে |
| `npm run build` | React production build ও local fonts প্রস্তুত করে |
| `npm start` | Express server চালু করে; terminal খোলা রাখুন |

- Website: [http://localhost:3000](http://localhost:3000)
- Staff: [http://localhost:3000/staff](http://localhost:3000/staff)
- বন্ধ করতে server terminal-এ `Ctrl+C`। পরে `npm start`; প্রতিবার seed লাগবে না।
- Database বন্ধ করে ডেটা রাখতে `docker compose stop`। পরে `docker compose up -d --wait`।

MongoDB Atlas বা নিজের **replica set** থাকলে Docker ধাপ বাদ দিন; `.env`-এ নিজের `MONGODB_URI` ও `MONGODB_DB` দিন। সাধারণ standalone MongoDB transactions চালাতে পারে না; শুধু Compass install করলেই replica set তৈরি হয় না। Atlas connection string server-এর `.env`-এ থাকবে।

## প্রথম অর্ডার পরীক্ষা

নতুন terminal-এ একই project folder খুলে চালান:

```cmd
npm run tables -- T01
```

1. Terminal-এর T01 link browser-এ খুলুন। প্রথম demo seed-এ T01/T02 open থাকে। পরে **Staff → Tables → Open table** লাগতে পারে। QR URL থেকে menu-তে এসে table number দেখাবে। সাধারণ `/menu` থেকে browse করা যায়; order করতে active table প্রয়োজন।
2. খাবারের details খুলুন, size/add-on বেছে cart-এ দিন। নোট দিয়ে **Place order** করুন। **My orders**-এ number ও progress দেখুন।
3. `/staff`-এ `admin` username এবং `.env`-এর `STAFF_ADMIN_PASSWORD` দিয়ে login: **Order desk → Send to kitchen**।
4. Logout করে `kitchen` ও `STAFF_KITCHEN_PASSWORD` দিয়ে login: **Start cooking → Mark ready**।
5. `waiter` ও `STAFF_WAITER_PASSWORD` দিয়ে login: **Mark served**। তখন guest প্রতিটি খাবারের verified feedback দিতে পারবেন।
6. `cashier` ও `STAFF_CASHIER_PASSWORD` দিয়ে login: **Billing → Finalize bill**। একই table visit-এর বিভিন্ন ফোনের served order এক বিলে আসবে। অসম্পূর্ণ order আগে শেষ/বাতিল করতে হবে। Finalize-এর পরে নতুন order বন্ধ থাকে।
7. কাউন্টারে টাকা সত্যিই পাওয়ার পরে method/reference এবং confirmation checkbox দিয়ে **Record payment** করুন। Receipt পাওয়া যাবে, table visit বন্ধ হবে।
8. Guest public/private feedback ও optional photo দিতে পারেন। Admin **Reviews** থেকে reason দিয়ে hide/publish ও reply দিতে পারেন। Private feedback public menu-তে প্রকাশ হয় না। শুধু কম star দেওয়ার কারণে review hide করা উচিত নয়।

একই browser profile-এর staff tab একই login ব্যবহার করে। বিভিন্ন station একসঙ্গে চালাতে আলাদা browser profile ব্যবহার করুন। Guest account লাগে না; guest order ownership signed browser cookie দিয়ে নির্ধারিত। Customer account-এ login করলে account history অন্য device-এও পাওয়া যায়। Sign-in-এর সময় এই browser-এর unclaimed guest orders/account bookings account-এর সঙ্গে যুক্ত হয়। একই টেবিলের দ্বিতীয় ফোন নিজের QR scan করে নিজস্ব order দিতে পারবে। Staff UI ইংরেজিতে, guest UI বাংলা/ইংরেজিতে।

## কী তৈরি হয়েছে

| ডকুমেন্টের অংশ | এই সংস্করণের কাজ |
|---|---|
| Brand website | Burgundy/gold design, animated hero, local food images, story, private dining, responsive layout, BN/EN |
| Menu | Categories, search, price/rating sort, favourites, details, availability, variants ও add-ons |
| QR ও session | Physical table QR, staff open/close visit, context, QR rotate ও print command |
| Order | Cart, note, server-side price/option validation, retry deduplication, history/progress |
| Kitchen ও floor | Admin accept/decline, pre-cooking guest change approvals, kitchen stage timers, waiter serving, manual order, acknowledged service/bill requests, optional sound alert |
| Billing | একই visit-এর bill, coupon/points, equal/customer/item/amount splits, partial counter receipts, held online attempts, exact remaining balance ও printable receipt |
| Feedback | Served-item ownership, one feedback per dish/order, stars, liked/improve fields, public/private consent, photo, moderation/reply |
| Events | Inquiry, spaces/packages/capacity, quote versions, expiring holds, shared-space ও cleanup overlap check, guest acceptance, verified deposit record, status |
| Admin | Live overview, paid sales reports/CSV, menu create/edit, kitchen availability controls, ordering pause, restaurant settings, role-based queues |
| Menu guide | Budget, group size ও spice অনুযায়ী বর্তমান মেনু থেকে deterministic matching; external AI service লাগে না |

**পরবর্তী integration/কাজ:** external courier dispatch/GPS, multi-branch/multi-tenant support ও event configuration editor। Menu guide deterministic matching ব্যবহার করে। Counter-এর bKash/Nagad/card selection বাস্তবে পাওয়া টাকা **রেকর্ড** করে; online টাকা কাটার জন্য পৃথক SSLCOMMERZ checkout আছে। Event deposit-ও staff-এর verified record; v2.4-এ এর approval/return workflow আছে।

প্রথম বিক্রির আগে restaurant-specific menu/fees, staff workflow, event terms, legal/tax rules ও বাস্তব devices দিয়ে acceptance test প্রয়োজন। এটি চালানো যায় এমন প্রথম product version; production hosting, merchant onboarding ও operational approval আলাদা কাজ।

## Event flow

Guest **Private dining → Plan a gathering** থেকে ভবিষ্যতের date/time, guests, space ও package দিয়ে request করবেন। এটি booking confirmation নয়। একই browser-এর **My orders → Your gatherings**-এ request থাকে। Admin **Gatherings** থেকে quote পাঠাবেন; total, menu, terms, deposit ও expiry guest দেখে accept করতে পারবেন। Deposit লাগলে staff কাউন্টারে reference verify করে record করার পরে confirmed হবে। পুরো dining room বুক করলে family corner-এর overlapping slot-ও ধরা হয়; ৩০ মিনিট cleanup buffer যোগ হয়।

Capacity/package definitions `server/events.js`-এ আছে; নিজের venue অনুযায়ী বদলে restart করুন। উদ্ধৃত মূল্য ও terms-ই চূড়ান্ত; package card-এর starting price automatic booking নয়। সময় Bangladesh UTC+6 হিসেবে সংরক্ষণ/দেখানো হয়।

## আগের version থেকে upgrade

আগের folder ও database backup রেখে নতুন ZIP **আলাদা folder-এ** extract করুন। পুরোনো `.env` নতুন folder-এ copy করুন, তারপর `npm ci` ও `npm run setup`। Setup নতুন cashier secret-এর মতো missing fields যোগ করে, non-empty values বদলায় না। পুরোনো `MONGODB_URI`, `MONGODB_DB` ও `COOKIE_SECRET` রাখলে একই database ব্যবহার হবে।

`npm run seed` বিদ্যমান dish price, availability, staff password, order বা review reset করে না; missing metadata/new staff যোগ করে। এরপর `npm run build` ও `npm start`। নতুন installation-এ sample reviews চাইলে `npm run seed -- --demo`। পুরোনো cart migrate করার চেষ্টা হয়; checkout-এ বর্তমান price/options আবার যাচাই হয়।

আগের Docker Compose project/volume reuse করতে পুরোনো MongoDB চালু রেখেই নতুন app-এর `.env` একই MongoDB-তে point করুন। আলাদা folder থেকে নতুন Compose চালালে অন্য volume হতে পারে এবং একই 27017 port conflict করবে। পুরোনো database মুছবেন না।

## QR ও ফোন থেকে পরীক্ষা

```cmd
npm run tables -- --print
```

`qr-cards` folder-এ print-ready table SVG তৈরি হবে। শুধু একটি: `npm run tables -- --print T01`। QR print করে টেবিলে রাখুন। Staff **Tables → Replace QR** পুরোনো printed code বাতিল করবে; নতুন card লাগবে।

PC ও ফোন একই trusted Wi-Fi-তে থাকলে `.env`-এ `HOST=0.0.0.0`, `APP_ORIGIN=http://PC_LAN_IP:3000` দিন; `PC_LAN_IP` নিজের PC-এর IPv4 address দিয়ে বদলান। Restart ও QR আবার generate করুন। ফোনের `localhost` PC-কে নির্দেশ করে না। স্থায়ী QR-এর জন্য নিজের HTTPS domain ব্যবহার করুন। MongoDB port internet-এ প্রকাশ করবেন না।

## Development ও code map

```cmd
npm run dev
```

একই Express server-এ Vite development middleware ও Node watch চলে; UI edit live refresh হয়। Production যাচাই: `npm run build` তারপর `npm start`। Dev mode শুধু স্থানীয় development-এর জন্য।

| ফাইল/ফোল্ডার | দায়িত্ব |
|---|---|
| `client/src/main.jsx` | React router ও app root |
| `client/src/pages/` | Home, menu, orders/reviews, events, story, receipt, staff |
| `client/src/components/` | Navigation, cards, option modal, cart, menu matcher, shared UI |
| `client/src/lib/` | API client, guest/cart/language state, polling |
| `client/src/styles/` | Responsive guest/staff CSS; reduced-motion support |
| `server/app.js`, `features.js` | Express routes, role gates, guest/staff features |
| `server/orders.js`, `order-changes.js`, `billing.js` | Validation/status, approved changes, table/dish locks, exact totals/payment |
| `server/service-requests.js`, `reports.js` | Table request acknowledgements and settled sales/CSV |
| `server/customer.js`, `rewards.js` | Customer sessions/history, coupons and points ledger |
| `server/payments.js`, `bill-view.js`, `money.js` | Payment ledger, splits, exact paisa allocation and views |
| `server/gateway.js`, `commerce.js` | SSLCOMMERZ checkout/verification, IPN, bill ownership |
| `server/reservations.js` | Table booking, availability, waiting list and seating |
| `server/account-mail.js`, `staff-accounts.js` | Verification/recovery mail, one-use tokens, individual staff and session revocation |
| `server/refunds.js`, `invoices.js` | Approved receipt refunds, provider reconciliation, credit notes, tax/invoice snapshots |
| `server/inventory.js` | Ingredient stocks, recipes, kitchen commitment, changes/releases and movement ledger |
| `server/events.js` | Requests, quotes, expiring slot holds ও deposit records |
| `server/security.js` | Password hashing, signed cookies, staff sessions |
| `server/db.js`, `restaurant.js` | Collections/indexes ও settings/defaults |
| `scripts/` | Setup, non-reset seed, fonts, QR generation |
| `public/assets/` | Local fonts, illustrative food/interior images |
| `dist/` | Included production frontend build; source edit করলে rebuild |
| `test/workflow.test.js`, `operations.test.js` | Existing and v2.1 MongoDB integration tests |

MongoDB-তে menu, table/session, order snapshots, reviews, staff/sessions, bills, events, service requests, settings ও sensitive-action audit records থাকে। Order/close/finalize/pay একসঙ্গে হলে transaction table document lock দিয়ে সংঘর্ষ সামলায়। Event holds একই venue lock ব্যবহার করে। Staff queue ৩ সেকেন্ড ও guest orders/table bill ৪ সেকেন্ড পরপর refresh হয়; WebSocket নয়। Sales reports fully settled table bills-কে settlement date অনুযায়ী গণনা করে; mixed payment methods-এর actual receipt amounts আলাদা হয়। Unpaid partial receipts bill ledger-এ থাকে, report-এ settlement-এর আগে আসে না।

## Validation ও বাস্তব ব্যবহারের প্রস্তুতি

```cmd
npm test
```

Local test replica set চালু থাকলে পরীক্ষা চলবে। Test নিজের random database তৈরি ও শেষে মুছে দেয়; production connection দিয়ে tests চালাবেন না। Covered: old workflow, access control, stale prices, concurrent retry, roles, two phones/one bill, service charge, concurrent payment, receipt ownership, private/photo reviews, manual entry, ordering pause, QR replacement, event overlap ও deposit verification।

```cmd
curl.exe http://localhost:3000/healthz
```

Ready server `{"status":"ok"}` দেখাবে। Linux/macOS-এ `curl` ব্যবহার করুন।

বাস্তব deployment-এ HTTPS, authenticated MongoDB, persistent `data/reviews` storage, database/media backup, secure environment ও পৃথক staff access লাগবে। `NODE_ENV=production` হলে HTTPS origin বাধ্যতামূলক। Proxy থাকলে `TRUST_PROXY` ঠিকভাবে দিন। Local Compose authentication ছাড়া শুধু localhost-এ bind করে; public database hosting configuration নয়।

Photo সর্বোচ্চ 4 MB / 16 megapixels; server decode করে 1200px-এর মধ্যে WebP হিসেবে metadata ছাড়া আবার তৈরি করে। শুধু approved public photo public endpoint দেয়। Photo processing ব্যর্থ হলেও saved text feedback থাকে।

QR link share করা সম্ভব; active session চলাকালে staff টেবিল মিলিয়ে order accept করবেন। Browser data clear করলে guest history/review access হারাতে পারেন। Tax/VAT ও service charge configurable, default ০/disabled; নিজের প্রযোজ্য tax rate/BIN configure করুন। পুরোনো `UPGRADE_v2.1_BN.md`, `UPGRADE_v2.2_BN.md` ও `UPGRADE_v2.3_BN.md` historical guides; বর্তমান সংযোজনের জন্য v2.4 guide পড়ুন।

## সাধারণ সমস্যা

| সমস্যা | সমাধান |
|---|---|
| Missing configuration | `npm run setup`; `.env`-এর URI/origin দেখুন |
| MongoDB connection refused | Docker Desktop চালু রাখুন; Compose health/27017 conflict দেখুন |
| Transaction error | Standalone-এর বদলে replica set বা Atlas |
| Frontend build missing | `npm run build` তারপর `npm start` |
| Port 3000 busy | `.env`: `PORT=3001`, `APP_ORIGIN=http://localhost:3001`; restart, QR regenerate |
| Table closed/QR invalid | Staff table open করুন; rotated QR-এর নতুন link/card |
| Price/options changed | Menu refresh করে cart item আবার সঠিক option দিয়ে যোগ করুন |
| Bill finalize হচ্ছে না | একই visit-এর unfinished ticket serve/cancel করুন |
| `.env` password বদলিয়েও login হয় না | Existing password DB-তে hash করা; seed existing account reset করে না |

### Podman-এ পুরোনো replica-set initialization সমস্যা হলে

MongoDB container চলছে কিন্তু unhealthy এবং `no replset config has been received` এলে আগে status দেখুন:

```bash
docker compose exec -T mongo mongosh --quiet --host 127.0.0.1 --eval 'rs.status()'
```

শুধু configuration নেই নিশ্চিত হলে প্রথমবার initialize করুন:

```bash
docker compose exec -T mongo mongosh --quiet --host 127.0.0.1 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
```

`ok: 1` এলে `docker compose ps` দিয়ে healthy হওয়া দেখুন। আগে থেকেই initialized database-এ এই initialization আবার লাগবে না। কোনো volume/delete/reset command চালাবেন না।

Official references: [React](https://react.dev/), [Vite](https://vite.dev/guide/), [Express](https://expressjs.com/), [MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/), [Node.js](https://nodejs.org/en/download), [Docker Desktop](https://docs.docker.com/desktop/)। Local font licenses `public/assets/fonts`-এ আছে।
