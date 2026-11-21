# Angar Kitchen v2.5 — Upgrade ও নতুন ছয়টি ফিচার

**Base: `Angar_Kitchen_React_v2.4.zip`।** React–Express–MongoDB stack, guest design/assets এবং আগের QR ordering, table billing, refunds, reservations, notifications ও pickup/delivery workflow রেখে এই release তৈরি হয়েছে। পুরোনো guides historical; v2.5-এর নতুন কাজের জন্য এই guide ব্যবহার করুন।

## ১. Existing data রেখে upgrade

1. পুরোনো app `Ctrl+C` দিয়ে বন্ধ করুন; বিদ্যমান MongoDB চালু রাখুন। আগের project folder, database backup এবং review photos রাখুন।
2. নতুন ZIP **আলাদা folder**-এ extract করুন। আগের `.env` নতুন `angar-kitchen-react` folder-এ copy করুন। একই `MONGODB_URI`, `MONGODB_DB`, `COOKIE_SECRET`, `APP_ORIGIN`, payment/mail/SMS/VAPID settings রাখুন।
3. আগের `data/reviews` ও `data/backups` copy করুন, অথবা আগের persistent `UPLOAD_DIR` ও `BACKUP_DIR` ব্যবহার করুন। **মূল `BACKUP_ENCRYPTION_KEY` রাখুন।** v2.5 চালু হওয়ার পরে `MFA_ENCRYPTION_KEY`-এরও আলাদা private copy রাখবেন।
4. Node.js **24 বা নতুন** দিয়ে project folder-এ নিচের commands একটির পর একটি চালান।

```bash
npm ci
```

Lockfile অনুযায়ী dependencies install করে। নতুন dependencies: OTPAuth ও AWS S3 SDK।

```bash
npm run setup
```

পুরোনো non-empty configuration রাখে; missing MFA encryption key ও নতুন optional settings যোগ করে। Key generate হওয়া মানে staff-এর 2FA চালু হওয়া নয়।

```bash
npm run build
```

Production frontend ও local fonts তৈরি করে।

```bash
npm start
```

App ও background workers চালু হয়। Default website `http://localhost:3000`; staff workspace `/staff`।

**Existing database-এ আবার seed, reset বা Docker volume deletion দরকার নেই।** নতুন collections/indexes startup-এ যোগ হয়; existing ingredient defaults untracked, পুরোনো cash transactions কোনো নতুন shift-এ বসানো হয় না। নতুন folder থেকে আলাদা Compose database চালাবেন না। Fresh installation-এর instructions README-তে আছে। ZIP-এ `.env`, credentials, live data বা private keys নেই।

## ২. Audit-log dashboard

Admin → **Staff activity**:

- From/through date, exact action, exact staff username অথবা action/username/reason-এর literal search ব্যবহার করুন। Dates Bangladesh time; maximum range 366 দিন।
- প্রতি page-এ 50 records; Previous/Next দিয়ে এগোন। **Export filtered CSV** সর্বোচ্চ 10,000 matched records দেয়; বেশি হলে filter ছোট করুন। CSV time column UTC হিসেবে চিহ্নিত।
- Existing audit records-ও দেখা যায়। View read-only; export action-ও audit-এ থাকে। Allowed fields ছাড়া nested data, authentication seeds, passwords বা token payload প্রকাশ হয় না। Spreadsheet formula হিসেবে interpret হতে পারে এমন text export-এ neutralize হয়।
- Search input-এ password, recovery code বা private key লিখবেন না। Staff-লেখা reason field-এও এগুলো রাখবেন না।

## ৩. Staff two-factor authentication

### নিজের authenticator যোগ করা

Staff → **My access → Staff two-factor authentication**:

1. নিজের current password দিয়ে **Set up authenticator** দিন।
2. Authenticator app-এ QR scan করুন, অথবা manual setup key ব্যবহার করুন। Setup 10 মিনিট থাকে; QR/key private রাখুন।
3. App-এর six-digit code দিয়ে **Confirm & enable authenticator** দিন।
4. একবার দেখানো 10টি recovery code নিরাপদ জায়গায় রাখুন; acknowledgement দিয়ে finish করুন। প্রতিটি code একবার ব্যবহার করা যায়। Browser-এর বাইরে private copy রাখুন।
5. পরের login-এ আগে password, তারপর fresh authenticator code বা একটি unused recovery code দিন। একই authenticator code দ্বিতীয়বার গ্রহণ হয় না; setup-এর code ব্যবহারের পরে পরের 30-second code আসা পর্যন্ত অপেক্ষা করুন। Server/device clock সঠিক রাখুন।

Seeds database-এ AES-256-GCM encrypted; recovery codes hashed। Enabling, disabling বা recovery codes বদলালে অন্য sessions revoked হয়। নিজের factor disable বা recovery set regenerate করতে current password ও fresh factor দুটোই লাগে। নতুন recovery set পুরোনো codes বাতিল করে।

Login challenge 5 মিনিট / সর্বোচ্চ 5 guesses। Account-এর login ও factor-change attempts মিলিয়ে 15 মিনিটে 10টি invalid factor হলে 15 মিনিটের temporary lock হয়; password দিয়ে নতুন challenge খুললেও lock উঠে যায় না। Successful verification failure count reset করে। IP rate limits-ও আছে।

### Administrator policy

Default-এ optional, যাতে existing staff access আগের মতো চলে। Operator চাইলে `.env`-এ দিন এবং app restart করুন:

```dotenv
STAFF_REQUIRE_2FA_ADMIN=true
```

তখন প্রতিটি administrator personal password সেট করার পরে authenticator enrollment শেষ না করা পর্যন্ত business workspace খুলতে পারবেন না। Kitchen/waiter/cashier নিজেরাও 2FA enable করতে পারেন।

### হারানো device ও recovery

প্রথম পছন্দ unused recovery code। Admin → **Staff accounts → Recover authenticator** দিয়ে অন্য account-এর recovery করা যায়: exact username, reason, administrator password এবং admin-এর 2FA enabled থাকলে তার fresh factor লাগে। Target-এর factor বন্ধ, সব sessions revoked এবং next login-এ password change required হয়; নতুন device-এ আবার enroll করতে হবে।

যদি কোনো administrator-ই ঢুকতে না পারেন, trusted local server operator-এর CLI আছে। **এটি নির্বাচিত account-এর 2FA বন্ধ করে, সব sessions বাতিল করে এবং password change বাধ্যতামূলক করে।** পরিচয় যাচাইয়ের পরে শুধু সেই account-এর exact username বসান:

```bash
npm run mfa:recover -- --username admin --confirm-reset admin --reason "Operator verified the account owner after device loss"
```

এটি password জানার বিকল্প নয়। Existing staff password reset workflow প্রয়োজনমতো ব্যবহার করুন। Recovery action audit-এ থাকে। `MFA_ENCRYPTION_KEY` বদলে গেলে original key restore করুন; saved recovery codes seed decryption ছাড়াও কাজ করে। Original key হারিয়ে গেলে নতুন key দিয়ে পুরোনো TOTP seeds পড়া যাবে না।

## ৪. Off-site encrypted backups

Admin → **Backups & recovery → Off-site backup copies**। আগের local backup/isolated restore verification একইভাবে কাজ করে। নতুন feature existing encrypted `.akbackup` bundle private S3-compatible bucket-এ copy করে; encrypted bytes আবার download করে SHA-256 মিললেই **verified** হয়। Browser-এ cloud credentials দেওয়া হয় না।

### Operator configuration

নিজের private bucket তৈরি করুন; public access বন্ধ রাখুন। Server `.env`-এ নিজের values দিন। উদাহরণের placeholders দিয়ে generated encryption keys replace করবেন না।

```dotenv
BACKUP_S3_BUCKET=YOUR_PRIVATE_BUCKET
BACKUP_S3_REGION=YOUR_BUCKET_REGION
BACKUP_S3_PREFIX=angar-backups/
BACKUP_S3_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
BACKUP_S3_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY
BACKUP_S3_ENDPOINT=
BACKUP_S3_FORCE_PATH_STYLE=false
BACKUP_S3_USE_DEFAULT_CREDENTIALS=false
```

- AWS S3 হলে endpoint খালি রাখুন। অন্য provider হলে তার HTTPS S3 API endpoint এবং প্রয়োজন হলে `BACKUP_S3_FORCE_PATH_STYLE=true` ব্যবহার করুন। Provider-এ conditional object creation (`If-None-Match: *`), SHA-256 upload checksum, object metadata, GetObject ও ListObjectsV2 সমর্থন থাকতে হবে।
- Temporary credentials হলে `BACKUP_S3_SESSION_TOKEN` দিন। Operator-managed IAM role/credential chain ব্যবহার করলে access-key pair বাদ দিয়ে স্পষ্টভাবে `BACKUP_S3_USE_DEFAULT_CREDENTIALS=true` দিন। Default-এ host credentials নিজে থেকে বাছা হয় না।
- Credentials শুধু configured bucket/prefix-এর `s3:PutObject`, `s3:GetObject` এবং recovery list-এর জন্য prefix-scoped `s3:ListBucket` access দিন। Application remote object delete করে না। Bucket lifecycle, versioning, object lock ও remote retention আপনার provider-এ configure করবেন।
- `BACKUP_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY` ও recovery settings cloud bundle-এর বাইরে আলাদাভাবে private রাখুন। Cloud bucket key হারানোর সমাধান নয়।

App restart করে admin password দিয়ে **Automatically copy completed encrypted backups → Save cloud-copy preference** দিন। এতে existing completed local backups-ও queue হয়। অথবা নির্দিষ্ট backup বেছে **Queue cloud copy** দিন। Local backup schedule ও cloud-copy preference আলাদা; দুটোই default off।

Workers app চলাকালে কাজ করে। Temporary network/provider failure-এ bounded backoff সহ সর্বোচ্চ 5 attempts হয়; failed copy reason দিয়ে retry করা যায়। Retry original destination-এর সঙ্গে বাঁধা। Automatic copies বন্ধ করলেও আগের queued/in-flight copy শেষ হতে পারে। Existing remote object ভিন্ন হলে overwrite হয় না। Remote copy verified না হওয়া পর্যন্ত enabled off-site policy-এর local source retention মুছবে না; outage-এ local disk usage configured keep-এর বেশি হতে পারে, তাই failed jobs/disk দেখুন।

### Cloud থেকে disaster recovery

Original `.env` keys/credentials নিয়ে নতুন host-এ dependencies ও configuration প্রস্তুত করুন। Remote listing/download-এর জন্য live MongoDB connection লাগে না।

```bash
npm run backup:remote-list
```

100 করে result আসে; `nextCursor` থাকলে `npm run backup:remote-list -- --cursor YOUR_CURSOR` দিন। Exact backup ID ব্যবহার করুন।

```bash
npm run backup:fetch -- --id YOUR_BACKUP_ID
```

Configured private `BACKUP_DIR`-এ file আনে, checksum এবং original backup key দিয়ে authentication করে। ভিন্ন existing local file overwrite করে না। এরপর MongoDB replica set চালু রেখে isolated verify করুন:

```bash
npm run backup:verify -- --id YOUR_BACKUP_ID
```

Existing database/media overwrite এড়াতে শুধু নতুন target-এ restore করুন:

```bash
npm run backup:restore -- --id YOUR_BACKUP_ID --target-db angar_recovered_v25 --confirm-new-database angar_recovered_v25
```

Output-এর verified database/media path আগে review করুন। Restore copy-তে active sessions, MFA enrollment/login challenges, pending message/cloud jobs cleared এবং local schedule/off-site automatic copying disabled থাকে। Staff-এর saved encrypted MFA factor থাকে, তাই original MFA key লাগবে। Business records, cash shifts, lot allocations, purchases ও financial references থাকে।

App নতুন target-এ switch করার আগে backup-এর পরে হওয়া payments/refunds/provider transactions এবং physical stock/cash-এর পার্থক্য reconcile করুন। পুরোনো open cash shift দেখে বাস্তব count না মিলিয়ে নতুন money movement দেবেন না। Recovery copy review শেষে operator `.env`-এ নতুন database/media paths দিয়ে app restart করবেন। পুরোনো database/media deletion এই flow করে না।

**Validation limit:** এই release-এ S3 command contract, encrypted transfer, downloaded checksum, corruption/refusal/retry ও recovery controlled S3 transport দিয়ে tested। আপনার bucket/provider-এ real upload, fetch এবং isolated restore acceptance test প্রয়োজন; real credentials/cloud delivery এই ZIP-এর সঙ্গে যুক্ত নেই। Provider storage/request/transfer charges আপনার account-এ প্রযোজ্য। Original local backup limit 96 MiB / 250,000 documents অপরিবর্তিত।

## ৫. Cash drawer ও shift reconciliation

Admin/cashier → **Cash drawer & shifts**। Restaurant-এর একটি shared drawer; একসঙ্গে একটি open shift। এটি physical cash হিসাব, total sales/profit report নয়।

1. Drawer-এর cash গুনে reason ও confirmation দিয়ে **Open cash shift** দিন। Opening float sale হিসেবে report হয় না।
2. Open shift চলাকালে verified cash bill payments—partial/table/pickup/delivery সবই—cash in হয়। Completed cash bill/event refunds cash out হয়। bKash/Nagad/card/bank receipts drawer cash বাড়ায় না।
3. Private-event deposit recording-এ actual payment channel বাছুন। **Cash** হলে shift-এ যোগ হয়; default **Unclassified / legacy** পুরোনো recording semantics রাখে এবং drawer-এ ধরে নেয় না।
4. **Record cash in / out** দিয়ে actual top-up/withdrawal reason ও physical verification সহ লিখুন। Supplier-এর verified cash payment automatically cash out হয়। Open drawer-এ manual withdrawal/supplier cash expense recorded balance-এর বেশি হতে পারে না। Confirmed guest refund history আটকে না দিয়ে negative expected cash হলে alert দেয়; records/actual cash review করুন।
5. **Count & close shift**-এ actual count দিন। Expected = opening + cash in − cash out; difference = counted − expected। Counting চলাকালে নতুন cash transaction এলে close reject হয়; **Refresh balance & recount** দিয়ে আবার গুনুন।
6. Closed shift-এর original numbers immutable। Admin reason দিয়ে **Review closing difference** দেন; review balance বদলায় না। Statement ও CSV পাওয়া যায়।

No shift open থাকলে verified business cash movement **Cash activity without an open shift**-এ থাকে; পরে অন্য shift-এ silently বসানো হয় না। Shift list recent 30, unassigned list recent 30; statement first 500 movements, CSV up to 10,000। পুরোনো v2.4 cash receipts নতুন drawer ledger-এ backfill হয় না।

## ৬. Ingredient batch ও expiry tracking

Admin/kitchen → **Batches & expiry**। Existing ingredients-এর aggregate inventory/recipes আগের মতো চলে; tracking ingredient অনুযায়ী explicit opt in।

1. Admin **Enable batch tracking for an ingredient** থেকে actual opening lots দিন। এক বা একাধিক lot-এর whole base-unit quantity যোগফল বর্তমান available stock-এর সমান হতে হবে। প্রতিটি unique lot code ও real expiry দিন; non-perishable হলে স্পষ্ট checkbox দিন। Reserved orders-এর stock এই available balance-এর অংশ নয়।
2. Tracked ingredient-এর stock receive/positive correction-এ batch details লাগে। Existing **Ingredients & recipes** screen-এর stock form-ও lot-aware। Waste/negative correction-এ যে batch থেকে বাদ যাচ্ছে সেটি বাছুন; expired/quarantined lot physically discard করা যায়।
3. Recipe reservation earliest-expiry-first (FEFO) order-এ released, unexpired stock নেয়; non-perishable stock পরে নেয়। Expiry date Bangladesh calendar-এর **শেষ usable দিন**; পরের দিন expired। নতুন allocations expired/quarantined stock নেয় না।
4. Before cooking/preparing, reserved lots আবার expiry/quarantine check হয়। Recall হওয়া batch admin reason দিয়ে quarantine করলে সেই lot-এর pending preparation blocked থাকে। **Review batch condition** থেকে actual expiry/condition সঠিক করে record করুন।
5. Approved pre-cooking cancellation/reduction original allocated lots-এ stock ফেরায়। Already cooked food restock হয় না। Tracking enable-এর আগে reserved stock ফেরত এলে provenance unknown হওয়ায় `RETURN-...` lot quarantined থাকে; physical condition/expiry যাচাই করে admin release করবেন।
6. Alerts-এ expired, next 7 days ও quarantined lots দেখায়; ingredient/condition filters আছে। Recorded stock-এর মধ্যে unusable lot থাকলেও **Usable for new orders** শুধু usable remaining quantity। Ingredient-specific view-তে exhausted batches-ও দেখা যায়।

Inventory quantity whole base units: g/ml/pcs; kg থেকে g, litre থেকে ml-এ convert করুন। Purchase receipt বা stock adjustment retry একই request key-এ duplicate stock তৈরি করে না। Single receipt line-এ একটি lot record হয়; একই ingredient একাধিক actual lot-এ এলে আলাদা counted receipt দিন।

## ৭. Supplier ও purchase management

Admin/cashier → **Suppliers & purchases**:

| কাজ | Admin | Cashier | Kitchen |
|---|---|---|---|
| Supplier directory / balance দেখা | হ্যাঁ | হ্যাঁ | না |
| Supplier create/edit/archive | হ্যাঁ | না | না |
| Purchase তৈরি/confirm/cancel/receive | হ্যাঁ | না | না |
| Actual supplier payment record | হ্যাঁ | হ্যাঁ | না |
| Batch/expiry দেখা ও waste record | হ্যাঁ | না | হ্যাঁ |
| Batch opt-in / condition review | হ্যাঁ | না | না |

1. **Add supplier**-এ contact details দিন। Archive করলে history/debt থাকে; নতুন confirmed purchase-এর জন্য active supplier লাগবে। একই নামের duplicate supplier তৈরি হয় না।
2. **Create purchase order**-এ ingredients, whole base-unit quantities, agreed BDT price এবং price কত base units-এর জন্য তা দিন। যেমন 1,000 g rice-এর price ৳200 হলে quantity 1000, price 200, price units 1000। Optional due date/notes দিন।
3. Saved **draft** review করে reason দিয়ে confirm করুন। Draft দরকারমতো cancel করে correct draft তৈরি করুন; received history/price retroactively edit হয় না। Creating/confirming নিজে supplier-কে message পাঠায় না।
4. **Receive delivery**-এ physically counted quantity, delivery note/invoice reference, reason ও tracked ingredient-এর batch/expiry দিন। Partial delivery supported; outstanding-এর বেশি receive হয় না। Stock এবং received goods-এর exact payable value একই transaction-এ record হয়। Per-base-unit fractional price cumulative rounding ব্যবহার করে, তাই partial receipts-এর sum final agreed amount-এর সমান।
5. **Record supplier payment**-এ actual paid amount/channel দিন; non-cash reference ও verification লাগে। Unpaid **received** goods-এর balance-এর বেশি pay record হয় না। Cash expense open drawer-এ যায়; bank/wallet payment drawer cash বদলায় না। App নিজে supplier-কে money transfer করে না।
6. **Cancel remaining delivery** unreceived quantity বাতিল করে; received stock/debt/payments থাকে। View record-এ receipt/lot/payment/history দেখুন। Supplier directory total outstanding দেখায়। Purchase list recent 100; older record পেতে exact `PO-...` reference search করুন।

## ৮. Release verification

- Production build successful; automated MongoDB-backed suite-এ **87 tests**: আগের 71 regression tests এবং নতুন audit/cash/MFA/cloud/batch/purchasing tests। Original test files অপরিবর্তিত।
- Coverage includes role checks, transaction rollback/concurrency, partial receipt/refund cash effects, stale shift closing, replay/single-use recovery, shared MFA lock, expired/recalled stock, original-lot returns, balanced opening lots, partial receipt rounding, duplicate delivery/payment prevention, encrypted-cloud corruption and recovery checks।
- Browser checks cover the six new screens and existing guest/staff ordering flows, plus mobile overflow/error checks। Screens/UI operation এবং external provider delivery আলাদা acceptance concerns। Real cloud/SMTP/SMS/push/merchant services নিজের credentials দিয়ে পরীক্ষা করুন।

Official integration references: [OTPAuth](https://github.com/hectorm/otpauth), [AWS S3 JavaScript v3 examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html), [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)।
