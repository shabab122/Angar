# Angar Kitchen v2.6 — Upgrade ও নতুন পাঁচটি ফিচার

**Base: `Angar_Kitchen_React_v2.5.zip`।** Existing React–Express–MongoDB stack, guest design/assets, QR orders, bills/refunds, staff 2FA, reservations, pickup/delivery, notifications, batch inventory ও backups রেখে এই release তৈরি হয়েছে। নতুন integrations-এর জন্য নিচের guide ব্যবহার করুন; আগের guides historical।

## Existing data রেখে upgrade

1. পুরোনো app `Ctrl+C` দিয়ে বন্ধ করুন; existing MongoDB চালু রাখুন। পুরোনো folder ও database backup রাখুন। নতুন ZIP আলাদা folder-এ extract করুন।
2. আগের `.env` নতুন `angar-kitchen-react` folder-এ copy করুন। একই `MONGODB_URI`, `MONGODB_DB`, `COOKIE_SECRET`, `APP_ORIGIN`, **মূল `BACKUP_ENCRYPTION_KEY` এবং `MFA_ENCRYPTION_KEY`**, mail/SMS/payment/cloud/VAPID settings রাখুন।
3. আগের `data/reviews` ও `data/backups` copy করুন, অথবা একই persistent `UPLOAD_DIR` ও `BACKUP_DIR` ব্যবহার করুন। Private keys-এর আলাদা নিরাপদ copy রাখুন।
4. Node.js **24 বা নতুন** দিয়ে নতুন project folder-এ একটির পর একটি চালান:

```bash
npm ci
```

Existing lockfile-এর dependencies install করে; এই release-এর জন্য নতুন runtime package যোগ হয়নি।

```bash
npm run setup
```

Non-empty settings/keys রাখে; missing printer/staff-alert options যোগ করে।

```bash
npm run build
```

Production frontend ও local fonts তৈরি করে। নতুন staff feature panels প্রয়োজন হলে আলাদা chunks হিসেবে load হয়।

```bash
npm start
```

App ও background workers চালু হয়। Website default `http://localhost:3000`; staff `/staff`।

**Existing database-এ seed/reset/volume deletion দরকার নেই।** Startup নতুন collections/indexes যোগ করে। নতুন folder থেকে আলাদা Compose database চালাবেন না। Existing settings, invoice numbering, old payments ও staff factors রাখুন। `.env`, actual data, backup bundles, real credentials, test screenshots বা `node_modules` ZIP-এ নেই। Fresh installation-এর instructions README-তে আছে।

## ১. Physical stocktake ও reconciliation

Admin/kitchen → **Physical stock counts**:

1. **Start stock count** থেকে up to 30 ingredients বাছুন, reason দিন। System বর্তমান **available/unallocated** quantity এবং lot/revision snapshot রাখে। Already reserved order stock এই balance-এর অংশ নয়।
2. **Open stock count → Count [ingredient]** থেকে physically counted quantity দিন। Tracked ingredient হলে প্রতিটি listed batch আলাদাভাবে গুনুন—zero, expired ও quarantined quantity-ও অন্তর্ভুক্ত করুন। Unknown নতুন lot পেলে আগে normal stock receipt-এ তার provenance/expiry record করুন।
3. সব ingredients count হলে **Submit count for review** দিন। এতে physical stock এখনই বদলায় না।
4. Admin differences ও reasons দেখে approve/reject করেন। Approval সব ingredient/lot adjustment একই transaction-এ করে এবং stock movement/audit রাখে।
5. Snapshot-এর পরে order reservation, delivery, waste, lot review বা valuation বদলালে approval stale হিসেবে reject হয়। **Refresh & recount** সেই ingredient-এর snapshot বদলে old count মুছে দেয়; আবার physically count করে submit করুন।

Approved record retry stock দ্বিতীয়বার বদলায় না। Rejected record adjustment করে না। Initial list latest 50 records; একটি count-এ ingredient প্রতি সর্বোচ্চ 200 recorded lots। Whole g/ml/pcs ব্যবহার করুন। Quantities add-up না করলে tracked balance approve হয় না।

Count shortage-এর supported weighted inventory value operating report-এ stock loss হয়। Extra found stock-এর acquisition cost unknown হলে valuation incomplete হয়; supported inventory valuation review করুন। Count কখনও cooked food বা reserved order stock silently ফেরত দেয় না।

## ২. Supplier returns, credit notes ও refund receipts

Admin/cashier → **Supplier returns & credits**। Existing **Suppliers & purchases** আগের মতো purchase creation, delivery ও actual supplier payment রেকর্ড করে।

1. Admin **Request supplier return** থেকে original purchase ও exact delivery receipt বাছুন। Ingredient ও quantity, reason দিন। Pending/approved requests-ও original receipt quantity reserve করে, তাই একই delivered quantity দুইবার return হয় না।
2. Admin reason দিয়ে approve/reject/withdraw করেন। Approval নিজে physical stock বা supplier payable বদলায় না।
3. Goods supplier-কে বাস্তবে handed back হওয়ার পরে **Confirm goods handed back**-এ reference, reason ও verification দিন। তখন original lot-এর available stock, inventory value ও purchase credit একসঙ্গে adjust হয়; immutable `SCN-...` supplier credit note হয়।
4. Already reserved/used/discarded stock ফেরত দেখানো যায় না। Tracked ingredient-এর original receipt-এ exact lot provenance না থাকলে system lot অনুমান করে না—operator-এর সঙ্গে original delivery/provenance review করুন। Approved request withdraw করে correct return দিন।
5. Supplier unpaid থাকলে credit payable কমায়। আগে বেশি paid হয়ে থাকলে negative outstanding হলো **supplier credit receivable**; goods ফেরত দেওয়াই money received নয়।
6. Admin/cashier **Record supplier refund received** দিয়ে credit-এর মধ্যে actual bank/cash/wallet/card refund, reference ও verification রেকর্ড করেন। Cash refund open drawer-এ cash in হয়; drawer বন্ধ থাকলে separately unassigned থাকে। App নিজে supplier-কে message/transfer/refund request পাঠায় না।

Balance = gross received value − returned goods credit − actual supplier payments + actual supplier refunds received। Credit note original delivery value থেকে হিসাব হয়; partial return-এর rounding শেষে original amount-এর সঙ্গে মেলে। Received history/old payments overwrite হয় না। Existing payment forms revised payable-এর বেশি record করতে দেয় না। New returns, credit balances ও actual supplier refunds-এর lists latest 100 records।

## ৩. Expense management ও operating/profit report

Admin/cashier → **Expenses & operating result**। তিনটি views আছে।

### Ingredient valuation ও recipe cost

- **Ingredient valuation** বর্তমান available stock-এর recorded value দেখায়। Existing v2.5 stock ও old cooked orders-এ supported cost snapshot নেই; system সেগুলোকে free ingredient ধরে না।
- Admin invoice/other supported source দেখে **Record valuation**-এ BDT price এবং price কত base units-এর জন্য তা দিন। উদাহরণ ৳200 per 1,000 g। এটি available stock-এর opening value রেকর্ড করে; supplier payable/payment তৈরি করে না। Already reserved/consumed order cost বদলায় না।
- New purchase deliveries তাদের actual incremental received value weighted-average inventory value-এ যোগ করে। Manual stock received form-এ optional **Actual acquisition cost** দেওয়া যায়; unknown হলে খালি রাখুন। Supplier balance দরকার হলে purchase delivery workflow ব্যবহার করুন।
- Recipe reservation-এ ingredient value snapshot রাখা হয়। Cooking/preparing শুরু হলে immutable consumption record হয়। Pre-cooking cancellation/reduction original reserved value ফেরায়, পরে বেশি দামে কেনা stock-এর value দিয়ে পুরোনো reservation reprice করে না।
- Batch allocation এখনও FEFO; costing ingredient level-এ weighted average। Expired/quarantined batches new cooking-এ usable নয়, কিন্তু physical stock হিসেবে count/waste করা যায়।

### Expense requests, approval ও actual payments

1. **Request operating expense**: salary/rent/utilities/maintenance/transport/supplies/other, payee, total BDT, incurred date, optional due date/reference ও description দিন। এটি supplier purchase-এর বিকল্প নয়।
2. Admin reason দিয়ে approve/reject করেন। Approved full expense **incurred date**-এর management report-এ অন্তর্ভুক্ত হয়।
3. Actual payment হওয়ার পরে cashier/admin full/partial amount, channel, reference ও verification দেন। Recorded payment outstanding expense-এর বেশি হতে পারে না; duplicate retry দ্বিতীয় payment করে না।
4. Cash expense open drawer-এ cash out; open drawer-এ recorded funds কম হলে cash expense reject হয়। Bank/wallet/card drawer cash বদলায় না। Drawer বন্ধ থাকলে verified business cash separately retained হয়।
5. Admin requested/approved **পুরো unpaid** expense cancel করতে পারেন। Paid/part-paid expense silently cancel/erase হয় না; payment history/audit থাকে।

Expense list inclusive Dhaka date range অনুযায়ী latest 200 records দেখায়। Payment date এবং incurred date আলাদা। App payroll calculation বা external bank transfer করে না।

### Report-এর অর্থ

Bangladesh calendar date range, maximum 366 days / 10,000 settled bills:

**Operating result / estimate = settled bill revenue excluding VAT − confirmed non-VAT food refunds − original recipe cost of those sales − recorded waste/stock shortages − approved incurred operating expenses + supplier-return valuation adjustment।**

- Dining, pickup ও delivery bills settled date দিয়ে revenue-তে আসে; VAT বাদ যায়। Event deposits, supplier refunds, opening cash ও cash top-ups food revenue নয়।
- Purchase stock asset value ও supplier cash settlement আবার operating expense হিসেবে deduct হয় না। Operating expense full approved amount একবার incurred date-এ ধরা হয়; partial actual payment দ্বিতীয় expense নয়।
- Supplier credit note original purchase value ব্যবহার করে, inventory reduction weighted value ব্যবহার করে। এই পার্থক্য separate **Supplier return valuation adjustment** হিসেবে দেখায়।
- Food refund original preparation cost বা physical cooked stock ফিরিয়ে দেয় না। Recipe stock value আলাদা ledger-এ থাকে।
- অন্য period-এর settled sales বা এখনও unsettled sources-এর current-period preparation costs আলাদা information হিসেবে দেখানো হয়।
- Historical recipe/valuation missing হলে report স্পষ্টভাবে **estimate / incomplete cost coverage** দেখায়; opening value দিলেই পুরোনো cooked orders retroactively costed হয় না।
- এটি entered records ও stated settlement/expense policy অনুযায়ী management operating report। Unentered expenses, full accounting adjustments বা tax filing এর মধ্যে ধরা হয় না। CSV-তে policy ও coverage status আছে।

## ৪. Kitchen tickets ও thermal printer integration

Admin/kitchen/cashier → **Kitchen & receipt printing**। Kitchen staff KOT দেখেন; cashier receipt jobs দেখেন; admin দুটোই দেখেন।

### Default browser printing

- Table order kitchen-এ পাঠালে এবং pickup/delivery accept করলে automatically **new KOT** তৈরি হয়। Approved queued order edit/cancellation নতুন revision ticket তৈরি করে। এখনও unsent old ticket **superseded** হয়; latest revision ব্যবহার করুন।
- New KOT creation-এর জন্য external printer লাগবে না। **Open thermal print preview** থেকে system-configured printer নির্বাচন করে print করুন। Unicode/Bengali kitchen notes browser print-এ থাকে।
- Counter / pickup-delivery receipt view-এ **80 mm thermal receipt** link আছে। Browser print dialog-এ নিজের printer, 80 mm paper ও 100% scale বাছুন। Paper length/margins নিজের driver অনুযায়ী যাচাই করুন। Existing normal printable receipt আছে।
- Browser dialog cancel বা printer failure system নিজে নিশ্চিত করতে পারে না। কাগজ সত্যিই ঠিক বের হওয়ার পরে **Confirm physical print** দিন।
- **Request marked reprint** আলাদা job তৈরি করে, `REPRINT / COPY` লেখা থাকে এবং reason/audit রাখে। Past jobs unlabelled দ্বিতীয়বার print করানো automatic retry নয়।

### Optional direct ESC/POS network printer

Operator server `.env`-এ নিজের compatible printer-এর IP/host ও raw TCP port দিন, তারপর app restart করুন:

```dotenv
KITCHEN_PRINTER_HOST=YOUR_PRINTER_IP_OR_HOST
KITCHEN_PRINTER_PORT=9100
KITCHEN_PRINTER_COLUMNS=42
KITCHEN_PRINTER_CUT=false
```

- Host খালি থাকলে direct sending disabled। Browser frontend arbitrary host/port/raw commands পাঠাতে পারে না। Operator-approved local/private printer ব্যবহার করুন। Raw TCP printer নিজে encrypted/authenticated channel নয়।
- Columns 32–48; actual supported width/font ও port নিজের model অনুযায়ী যাচাই করুন। `KITCHEN_PRINTER_CUT=true` শুধু compatible cutter থাকলে দিন; default off।
- Implemented raw profile: **English ASCII ESC/POS** initialization, wrapped text, feed এবং optional partial cut। Non-ASCII/Bengali note থাকলে **browser required** হয়; text বাদ দিয়ে incomplete kitchen ticket পাঠায় না। Browser printing দিয়ে full Unicode text রাখুন।
- Admin password দিয়ে **Automatic kitchen printer enabled → Save printer preference** দিলে পরের newly created KOT automatically queue হয়। আগের ready backlog নিজে থেকে print হয় না; প্রয়োজন হলে job বেছে send করুন।
- Disabling automatic printing pending automatic sends থামায়। Already sending bytes recall করা যায় না। Order acceptance/cooking printer availability-এর কারণে blocked হয় না; staff queue থেকে কাজ চালাতে পারেন।
- A successful socket write status **sent**; এটি actual paper confirmation নয়। Physical output দেখে confirm করুন। Connection failure **before transmission** সর্বোচ্চ 3 safe attempts করে। Bytes পৌঁছেছে কি না uncertain হলে automatic resend হয় না। Server restart-এর সময় sending job-ও uncertain হয়। Paper check করে প্রয়োজন হলে marked reprint তৈরি করুন।
- Network receipts manual jobs; original invoice number/status/totals, payments/refund summary থাকে। Original ledger নতুন copy-এর কারণে বদলায় না।

Official command references: [Epson ESC @](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/esc_atsign.html), [Epson GS V](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_cv.html), [Node.js TCP sockets](https://nodejs.org/download/release/v24.22.2/docs/api/net.html)। Physical printer/driver acceptance নিজের hardware-এ প্রয়োজন। এই release-এর byte/transport tests controlled local TCP receiver ব্যবহার করে; real paper output দাবি করা হয়নি।

## ৫. Automated stock, expiry ও supplier alerts

Admin/kitchen/cashier → **Operations alerts**। Server চলাকালে প্রায় প্রতি minute conditions scan হয়; workspace personal unacknowledged badge দেখায়।

- **Low stock:** tracked ingredient-এর released/unexpired usable stock বনাম reorder level; untracked ingredient-এর current stock।
- **Expiry approaching / expired:** remaining lot quantity, actual expiry date ও quarantine status। Admin 1–30 day upcoming window বাছতে পারেন; default 7 days। Date last usable Bangladesh calendar day।
- **Overdue supplier payment:** due date পেরোনো purchase-এর positive actual payable balance। Returned credit/refund/payment সমন্বয় হয়।
- Kitchen শুধু stock/expiry, cashier শুধু supplier overdue, admin সব দেখেন। **Acknowledge** personal record; অন্য staff-এর alert বা underlying condition resolve করে না।
- Restock, reviewed lot condition, physical waste/return বা verified supplier payment-এর পরে next scan condition resolve করে। পুনরায় দেখা দিলে alert নতুন acknowledgement cycle পায়; expiry-soon থেকে expired হলেও নতুন attention cycle হয়।

### Optional staff email digest

Existing SMTP বা private development outbox settings ব্যবহার করুন। Operator `.env`-এ অনুমোদিত staff recipient addresses দিন এবং app restart করুন:

```dotenv
STAFF_ALERT_EMAIL_TO=operations@your-restaurant.example,manager@your-restaurant.example
```

Admin → **Operations alerts → Enable daily staff email digest**, password দিয়ে save করুন। Default email off; in-app alerts email ছাড়াই কাজ করে। Active conditions থাকলে দিনে একটি consolidated digest configured recipients-এ queue হয়। Recipient list private server setting; customer email preference থেকে staff finance alerts পাঠানো হয় না। Recipient configuration বদলালে পুরোনো queued job অন্য recipients-এ silently reroute হয় না।

Email transport acceptance inbox delivery guarantee নয়। Uncertain send automatic duplicate হয় না; mailbox check করে **Review uncertain staff digest** থেকে আজকের digest explicit retry করা যায়। Audit reason ও duplicate-risk acknowledgement লাগে। Local outbox email মানুষের inbox-এ যায় না। Real SMTP credentials/provider acceptance নিজের setup-এ করতে হবে।

## Recovery ও verification

New business collections—stocktakes, inventory valuations/consumption, expenses/payments, supplier returns/credit/refunds—existing encrypted backup-এ থাকে। Recovery copy-তে pending **print jobs** ও **staff email deliveries** cleared, automatic printer sending ও staff email disabled থাকে। Existing staff/customer session cleanup, MFA key requirement ও backup/cloud safety rules বজায় আছে। Recovered database/media যাচাই করে physical stock/cash এবং backup-এর পরে হওয়া supplier/customer payments reconcile করুন; queued prints/emails অন্ধভাবে replay করবেন না।

`npm test` MongoDB replica set-এর random isolated test databases ব্যবহার করে; শেষে test databases সরায়। Test file concurrency 2, যাতে backup/restore drills development machine-এ একসঙ্গে অতিরিক্ত load না দেয়। **101 automated tests pass:** আগের 87টি test এবং নতুন 14টি stocktake, finance, supplier return, print/TCP, staff alert ও recovery safety tests। Existing v2.5 test files অপরিবর্তিত। Browser checks নতুন পাঁচটি staff workflow, thermal print layouts ও mobile layouts cover করে; prior release regressions-ও যাচাই হয়।
