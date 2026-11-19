# Angar Kitchen React v2.3 — নিরাপদ upgrade ও feature guide

**Base:** `Angar_Kitchen_React_v2.2.zip`। এই release-এ পাঁচটি সংযোজন: email verification/password recovery, table-bill refunds, individual staff accounts, ingredient inventory এবং tax/VAT/invoice settings। পুরোনো React–Express–MongoDB stack, home/design/assets, guest QR order, kitchen/waiter flow, split bills, SSLCOMMERZ checkout, accounts, coupons, reservations, reviews ও events রাখা হয়েছে।

## ১. পুরোনো database রেখে upgrade

1. পুরোনো app terminal-এ `Ctrl+C` দিন। পুরোনো folder/database-এর backup রাখুন। MongoDB চালু রাখুন।
2. v2.3 ZIP আলাদা folder-এ extract করুন। পুরোনো `.env` নতুন `angar-kitchen-react` folder-এ copy করুন। আগের `MONGODB_URI`, `MONGODB_DB`, `COOKIE_SECRET`, `APP_ORIGIN` ও gateway values রাখুন।
3. আগের review photos রাখতে `data/reviews` copy করুন, অথবা আগের persistent `UPLOAD_DIR` ব্যবহার করুন। Local email outbox ব্যবহার করে থাকলে প্রয়োজনীয় private test mail নিজে সংরক্ষণ করুন; এগুলো public/uploaded review photos নয়।
4. Node.js **24+** দিয়ে নতুন project folder-এ ক্রমানুসারে চালান:

```bash
npm ci
npm run setup
npm run build
npm start
```

Website: http://localhost:3000 · Staff: http://localhost:3000/staff

`setup` missing email configuration fields যোগ করে; non-empty পুরোনো values রাখে। New collections/indexes app startup-এ তৈরি হয়। পুরোনো database-এ আবার demo seed/reset দরকার নেই। পুরোনো MongoDB চালু থাকলে নতুন folder থেকে দ্বিতীয় Docker Compose database চালাবেন না।

**Default আচরণ:** tax বন্ধ, আগের AK receipt format, recipe ছাড়া খাবারে inventory deduction নেই, পুরোনো staff accounts/passwords রাখা হয়। Existing unverified customer email নিজে থেকে verified হয় না। Already-queued পুরোনো orders-এ inventory retroactively কাটা হয় না; নতুন acceptance থেকে recipe snapshot হয়।

## ২. Email verification ও password recovery

### বাস্তব email delivery

নিজের SMTP provider-এর credentials server `.env`-এ দিন। উদাহরণটি placeholder:

```dotenv
MAIL_MODE=smtp
MAIL_FROM="Angar Kitchen <YOUR_SENDER@YOUR_DOMAIN>"
SMTP_HOST=YOUR_SMTP_HOST
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=YOUR_SMTP_USERNAME
SMTP_PASSWORD=YOUR_SMTP_PASSWORD
APP_ORIGIN=https://YOUR_RESTAURANT_DOMAIN
```

Port 587-এ STARTTLS বাধ্যতামূলক। Implicit TLS port 465 হলে `SMTP_PORT=465` এবং `SMTP_SECURE=true` দিন। Certificate verification বন্ধ করার shortcut নেই। Sender address/domain নিজের provider-এ অনুমোদিত হতে হবে। Credentials frontend/VITE/Git-এ দেবেন না।

**Local test:** SMTP account ছাড়া নিজের computer-এ `.env`-এ `MAIL_MODE=outbox` দিন, app restart করুন। Website-এ verification/reset request করার পরে অন্য terminal-এ:

```bash
npm run mail:outbox
```

এতে server-এর private local outbox-এর সর্বশেষ test emails ও link দেখা যায়। এগুলো internet-এ পাঠানো email নয়। Outbox public URL দিয়ে serve হয় না এবং production environment-এ এই mode নিষিদ্ধ। Token/link অন্যকে দেবেন না। Default `MAIL_MODE=off` হলে account/guest ordering কাজ করে; verification/recovery email চালু করার প্রয়োজন স্পষ্টভাবে দেখায়।

### Customer flow

- Account তৈরি হলে configured delivery দিয়ে verification email পাঠানোর চেষ্টা হয়। Existing member → **My account → Send verification email**। এক account-এ প্রতি মিনিটে একবার request। Verification link ২৪ ঘণ্টা valid।
- Email-এর link খুলে **Confirm email verification** দিন। Link কেবল খোলার ফলে verification হয় না।
- Sign-in form → **Forgot password?** → email দিন। Registered/unknown email উভয়ের জন্য একই generic response। Reset link ৩০ মিনিট valid।
- Link খুলে minimum ১২-character নতুন password ও confirmation দিন। সফল হলে সব customer sessions এবং পুরোনো recovery links বাতিল হয়; নতুন password দিয়ে sign in করতে হবে। Mailbox access প্রমাণিত হওয়ায় email-ও verified হয়।
- Database-এ token-এর hash থাকে, token single-use এবং purpose-bound। Browser URL fragment থেকে token নেওয়ার পরে history থেকে সরানো হয়। Page refresh করলে email-এর আসল link আবার খুলতে হবে।
- SMTP ব্যর্থ হলে registration হারায় না; verification resend করা যায়। Real SMTP delivery নিজের provider দিয়ে acceptance-test করুন। এই ZIP-এর verification/recovery tests controlled mail delivery ও private outbox দিয়ে চলে; আপনার mailbox delivery নিজে থেকে configure করা হয়নি।

## ৩. Refunds ও credit notes

`admin/cashier → Refunds & credit notes`। সর্বশেষ ৫০টি fully settled table bill থেকে বেছে নিন, বা exact receipt number দিয়ে পুরোনো bill খুঁজুন। Original payment বেছে তার unrefunded/unreserved amount-এর মধ্যে পুরো/আংশিক refund request করুন। Split/mixed payment হলে প্রতিটি original payment-এর জন্য পৃথক request দিন।

1. **Request refund:** amount ও reason দিন। একই request retry হলে দ্বিতীয় refund তৈরি হয় না। Pending requests-ও refundable balance reserve করে।
2. **Admin approval:** administrator reason দিয়ে approve/reject করেন। Rejection reservation ছাড়ে।
3. **Counter payment:** cash/bKash/Nagad/card money বাস্তবে ফেরত দেওয়ার পরে **Record money returned**, verified checkbox এবং non-cash হলে return reference দিন। এটি cash বা external wallet transfer নিজে করে না।
4. **SSLCOMMERZ:** approved request → **Submit to SSLCOMMERZ**। আগের merchant/mode credentials লাগে। Original bank transaction দিয়ে provider refund API call হয়; নতুন refund transaction ID request-এর সঙ্গে স্থায়ীভাবে যুক্ত।
5. **Recheck provider:** `processing` মানে ফেরত সম্পন্ন হয়নি। Provider query-তে original transaction/refund reference মিলে `refunded` হলে তবেই bill/loyalty ledger বদলায়। Browser message বা initiation success একা refund complete করে না।

Uncertain provider response হলে amount reserved থাকে। **Recover same refund attempt** একই refund ID ব্যবহার করে; নতুন request দিয়ে দ্বিতীয়বার টাকা ফেরত দেবেন না। Server restart/response হারালে processing attempt recovery-এর আগে অন্তত এক মিনিট অপেক্ষা করুন। Provider reference পাওয়া থাকলে পুনরায় initiate না করে status recheck হয়। Confirmed provider failure reservation ছাড়ে। Live refund API-এর জন্য SSLCOMMERZ merchant/IP permissions প্রয়োজন হতে পারে।

### Financial rules

- Refunds **fully paid table bills**-এর বিরুদ্ধে হয়। Unpaid partial receipt, event deposit বা separately flagged gateway overpayment এই table-bill refund ledger-এর আওতায় নয়; সেগুলো manager/provider-এ আলাদাভাবে reconcile করুন।
- Original invoice, paid amounts ও sales snapshots বদলানো হয় না; table আবার খোলে না। Confirmed refund-এর পৃথক numbered credit note, refunded total ও retained balance হয়। Original payment history-ও থাকে।
- Credit note food, service charge ও tax অংশ অবশিষ্ট original components-এর অনুপাতে paisa পর্যন্ত ভাগ করে। Total ফেরতের পরে সব component সম্পূর্ণ reverse হয়। Credit note original business/tax identity রাখে।
- Refund proportion অনুযায়ী earned loyalty points reverse এবং redeemed points restore হয়; full refund-এ coupon use মুক্ত হয়। Partial refund-এ coupon use থাকে। Expired coupon নতুন করে valid হয় না।
- Refunded purchase-এর earned points আগেই খরচ করা থাকলে wallet negative হতে পারে। Future earnings সেই balance শোধ করে; negative balance থেকে points redeem করা যায় না।
- Refund cooked food নিজে থেকে stock-এ যোগ করে না। বাস্তব stock corrections/waste inventory ledger-এ reason দিয়ে করুন।

Real merchant sandbox/live payment বা refund এই release তৈরির সময় করা হয়নি। Controlled provider-contract tests দেওয়া আছে। নিজের merchant sandbox-এ approval → initiation → processing → confirmed refund এবং duplicate/recovery acceptance-test করুন।

## ৪. Individual staff accounts

Admin → **Staff accounts** → **Create staff account**। Unique username, full name, existing চার role-এর একটি এবং minimum ১২-character temporary password দিন। Create/access/password reset করার সময় নিজের admin password পুনরায় দিতে হয়। Temporary password ব্যক্তিগতভাবে দিন; public screenshot/email/code-এ রাখবেন না।

- নতুন account এবং admin-reset password দিয়ে প্রথম login-এ **Set your own staff password** আসবে। নিজের নতুন password না দেওয়া পর্যন্ত অন্য staff API/workspace ব্যবহার করা যায় না।
- সব role → **My access** থেকে নিজের password বদলাতে পারে। এতে সব device sign out হয়; আবার login লাগে।
- Admin → **Edit access** দিয়ে role/active status বদলাতে পারেন; reason লাগে। Role change/deactivation/temporary-password reset পুরোনো সব sessions বাতিল করে।
- শেষ active administrator-কে deactivate/demote করা যায় না। নিজের role/deactivation অন্য administrator দিয়ে করতে হবে। Account delete করে audit history মুছে ফেলার ব্যবস্থা নেই।
- v2.2-এর admin/kitchen/waiter/cashier station accounts রাখা হয়েছে। Existing DB account-এর password `.env` বদলে বা seed দিয়ে reset হয় না; নতুন UI ব্যবহার করুন।

## ৫. Ingredient inventory

Admin/kitchen → **Ingredients & recipes**। Admin ingredients, low-stock thresholds, stock receipt/correction এবং dish recipes manage করেন। Kitchen quantities/ledger দেখতে ও reason-সহ waste record করতে পারে। Waiter/cashier-এর inventory access নেই।

### Units ও opening stock

Base units: `g`, `ml`, `pcs`—শুধু whole integers। ১ kg লিখতে **১০০০ g**, ১ litre লিখতে **১০০০ ml** দিন। Unit তৈরি হওয়ার পরে স্থির থাকে। Opening/receive/waste/correction-এর ledger থাকে; stock negative হয় না। Signed correction-এ positive/negative quantity দেওয়া যায়; receive/waste-এ positive quantity দিন। Supplier/reference optional। Same request retry stock দ্বিতীয়বার বদলায় না।

### Dish recipes

**Dish recipes → Edit recipe → Enable stock tracking**। প্রতিটি portion-এর base ingredients দিন। Size/variant এবং add-on-এর recipe শুধু **extra quantity** যোগ করে। উদাহরণ: base rice ২৫০ g + large-size extra ১০০ g = large portion-এ ৩৫০ g। Extra meat/add-on পৃথক ingredient দিতে পারেন। Default menu-তে কোনো অনুমান করা ingredient/recipe seed হয় না—নিজের বাস্তব recipe লিখুন।

### Deduction timing

- Guest order place করলে stock এখনও কাটা হয় না। Admin **Send to kitchen** করলে transaction-এ সব ingredient যাচাই ও deduct হয়। Insufficient stock হলে order `placed` থাকে; kitchen-এ যায় না। Staff stock/availability ঠিক করবেন বা guest-এর সঙ্গে কথা বলে decline করবেন।
- Queued order-এর approved quantity change snapshot recipe দিয়ে পার্থক্য deduct/restore করে। New recipe edit already-queued order-এর coefficients বদলায় না।
- Cooking-এর আগে queued cancellation/rejection হলে committed quantities restore হয়। Cooking শুরু হলে consumed হিসেবে চিহ্নিত হয়; আগের cancellation restriction বহাল থাকে।
- Stock alert threshold ছুঁলেই **Low stock** badge। Recipe ছাড়া menu item আগের মতো কাজ করে। Stock alert নিজে থেকে existing menu availability switch বদলায় না।
- **Stock movements**-এ সর্বশেষ ১০০টি movement, source order, actor, reason, change ও balance দেখা যায়। Orders/stock changes একসঙ্গে হলেও একই ingredient overspend করা যায় না।

## ৬. Tax/VAT ও invoice settings

Admin → **Tax & invoices**। Default tax disabled/০%। Restaurant-এর প্রযোজ্য rate/registration নিজে নির্ধারণ করুন; কোনো আইনগত VAT rate ধরে নেওয়া হয়নি।

- Tax label, rate (দুই decimal percentage পর্যন্ত), **Add tax** / **Included in listed prices**, এবং food after discounts / food + service charge tax base বেছে নিন।
- Coupons/loyalty discounts আগে প্রয়োগ হয়; service charge এবং tax পরে হিসাব হয়। Existing service charge setting **Restaurant settings**-এ থাকে।
- Exclusive: `tax = round(taxable amount × rate / 100)`; tax final total-এ যোগ হয়। Inclusive: `included tax = round(taxable amount × rate / (100 + rate))`; total-এ দ্বিতীয়বার যোগ হয় না। Integer paisa-তে rounding/allocation হয়।
- Business/legal name, address, phone/email, tax registration/BIN, footer, prefix ও random/sequential numbering configure করুন। Blank name/address হলে restaurant settings-এর নাম/location ব্যবহার হয়।
- Sequential numbering prefix + Bangladesh year অনুযায়ী, যেমন `AK-2026-000001`। Duplicate finalize একই invoice ফেরত দেয়; concurrent bills আলাদা number পায়। পুরোনো invoice renumber হয় না।
- Bill finalize হওয়ার সময় settings snapshot হয়। পরিবর্তন শুধু পরের finalized bills-এ লাগে। Guest preview finalization-এর আগে estimate; final bill-ই authoritative।
- Receipts, split payments, provider amount এবং credit notes একই final total ব্যবহার করে। Inclusive tax accounting food/service value থেকে আলাদা হয়। Loyalty earning tax ও service charge বাদে net food value-তে হয়।

## ৭. Sales reports

আগের **fully paid bills by paidAt** reporting রাখা হয়েছে। Original collected sales নিজ date-এ থাকে; confirmed refunds money-return date-এ আলাদা গণনা হয়। Food/service sales tax বাদে; tax collected, refunds given ও collected-minus-refunds আলাদা দেখা যায়। অন্য দিনের sale আজ refund হলে net figure negative হতে পারে। CSV summary-তেও tax/refund columns আছে। Unpaid partial receipts ও event deposits আগের মতো বাদ। এটি tax filing, stock-cost/profit বা পুরো cash-flow accounting system নয়।

## ৮. Verification

```bash
npm test
```

Test MongoDB replica set চালু থাকতে হবে। Tests নিজেদের random isolated database তৈরি করে শেষে শুধু test database মুছে দেয়; production connection দিয়ে tests চালাবেন না। Existing ৩৫টি test-এর সঙ্গে verification/reset, refund/loyalty, staff access, inventory concurrency এবং tax/invoice tests আছে।

নিজের deployment-এ acceptance sequence:

1. Existing guest QR order → kitchen → waiter → split/counter/online payment পরীক্ষা করুন।
2. বাস্তব mailbox-এ verification/reset links, expiry, resend, new-password login ও old-device logout দেখুন।
3. নতুন staff account, required personal password, permissions, role change/deactivation দেখুন।
4. বাস্তব ingredient recipe দিয়ে acceptance, quantity change, before-cooking cancellation এবং low-stock alert মিলিয়ে দেখুন।
5. নিজের applicable tax দিয়ে inclusive/exclusive invoice, numbering, print ও CSV যাচাই করুন।
6. Cash refund এবং নিজের gateway sandbox refund approve/verify/reconcile করে credit note, remaining refund capacity ও loyalty মিলিয়ে দেখুন।

Official integration references: [Nodemailer SMTP](https://nodemailer.com/smtp), [SSLCOMMERZ refund API](https://developer.sslcommerz.com/doc/v4/#refund-api)।

Suggested commit:

```text
feat: add v2.3 account security, refunds, staff access, inventory and invoices
```
