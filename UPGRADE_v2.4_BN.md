# Angar Kitchen v2.4 — Upgrade, setup ও recovery

এই release আপনার সর্বশেষ **Angar_Kitchen_React_v2.3.zip** থেকে তৈরি। React, Node.js/Express, MongoDB, QR table ordering, পুরোনো bill/receipt, staff roles, guest pages ও restaurant assets রাখা হয়েছে। নিচের চারটি feature ও প্রয়োজনীয় integration যোগ হয়েছে। আগের v2.1–v2.3 guides historical; নতুন feature-এ এই guide প্রযোজ্য।

## ১. Existing data রেখে upgrade

1. পুরোনো app terminal-এ `Ctrl+C` দিন; MongoDB চালু রাখুন। পুরোনো folder, `.env`, database backup ও review photos রাখুন।
2. নতুন ZIP **আলাদা folder**-এ extract করুন। পুরোনো `.env` নতুন `angar-kitchen-react` folder-এ copy করুন। একই `MONGODB_URI`, `MONGODB_DB`, `COOKIE_SECRET`, `APP_ORIGIN`, mail/payment credentials রাখুন।
3. পুরোনো `data/reviews` নতুন folder-এ copy করুন, অথবা আগের persistent `UPLOAD_DIR` ব্যবহার করুন। Existing backup files থাকলে সেগুলো ও তাদের **মূল backup encryption key** রাখুন।
4. নতুন folder-এর terminal-এ ক্রমানুসারে চালান:

```bash
npm ci
```

Lockfile অনুযায়ী dependencies install করে; এই release-এ Web Push-এর dependency যুক্ত হয়েছে। Node.js **24 বা নতুন** লাগবে।

```bash
npm run setup
```

আগের values রাখে; missing options যোগ করে। Missing `BACKUP_ENCRYPTION_KEY` ও সম্পূর্ণ missing VAPID pair তৈরি করে। একটি VAPID key আগে থেকে থাকলে setup সেটি silently replace করে না; complete pair দিতে বলে।

```bash
npm run build
```

Production frontend ও local fonts প্রস্তুত করে।

```bash
npm start
```

Restaurant: `http://localhost:3000` · Staff: `/staff` · Pickup/delivery: `/takeaway` · Alerts: `/notifications`। নিজের `APP_ORIGIN` অনুযায়ী URL ব্যবহার করুন।

**Existing database-এ `seed`, reset বা volume deletion দরকার নেই।** নতুন collections/indexes startup-এ তৈরি হয়। নতুন folder থেকে অন্য Compose database চালাবেন না। Fresh installation-এর Docker/replica-set নির্দেশনা README-তে আছে। `.env`, real credentials, backup bundles ও private outboxes ZIP/Git-এ রাখা হয়নি।

## ২. Automated backups ও verified recovery

### Backup চালু করা

Admin → **Backups & recovery**:

- **Create backup now** database ও referenced review photos-এর encrypted `.akbackup` bundle তৈরি করে। প্রতিটি new bundle নিজে থেকে আলাদা temporary database/media folder-এ restore করে document/photo checksum যাচাই করার পর completed দেখায়।
- **Automatic schedule** চালু করতে current administrator password দিন। প্রতি ১–১৬৮ ঘণ্টা interval এবং latest ১–৩০ completed backup রাখার policy আছে। Default schedule বন্ধ।
- **Download encrypted backup** শুধু authenticated administrator ব্যবহার করতে পারেন। **Verify isolated restore** দিয়ে পরে আবার পরীক্ষা করা যায়।
- Background worker app চলাকালে কাজ করে; restart-এর পরে due schedule আবার চলে। App বন্ধ থাকলে backup তৈরি হয় না। Backup কাজ চললেও notifications-এর worker আলাদা tick-এ চলে।

Configuration:

```dotenv
BACKUP_ENCRYPTION_KEY=YOUR_ORIGINAL_64_HEX_CHARACTER_KEY
BACKUP_DIR=/YOUR_PRIVATE_PERSISTENT_BACKUP_DIRECTORY
```

`BACKUP_DIR` খালি হলে `data/backups`। Key setup তৈরি করে; উদাহরণের placeholder দিয়ে generated key replace করবেন না। **Key-এর আলাদা নিরাপদ copy ছাড়া encrypted backup recover করা যাবে না।** Key bundle-এর ভেতরে নেই। Encrypted bundle অন্য durable storage-এ copy/download রাখুন; একই disk হারালে সেই disk-এর backup-ও হারাবে। Remote cloud upload এই release-এর অংশ নয়।

Snapshot-এ application collections, indexes ও referenced uploaded review photos থাকে। Static menu/brand assets project ZIP-এ আছে। `.env`/credentials/server configuration bundle-এ থাকে না। Database ও photos মিলিয়ে encoded application backup সর্বোচ্চ **96 MiB / 250,000 documents**; বড় deployment-এ managed database/media backup ব্যবহার করুন। MongoDB replica set প্রয়োজন। Backup user-এর application reads ছাড়াও isolated verification/restore database তৈরি, index তৈরি ও নিজের drill database সরানোর অনুমতি লাগবে। Production-এ operator-নির্ধারিত backup permissions ব্যবহার করুন।

### CLI backup ও verification

```bash
npm run backup:create
```

নতুন encrypted snapshot তৈরি ও isolated restore verify করে; `backupId` print হয়। নিচের commands-এ `YOUR_BACKUP_ID` সেই exact ID দিয়ে বদলান।

```bash
npm run backup:verify -- --id YOUR_BACKUP_ID
```

Temporary verification target-এর documents, indexes ও photos পরীক্ষা করে, শুধু সেই temporary target সরায়। Live database/photos বদলায় না।

### Recovery — আগে আলাদা target-এ restore

1. একই MongoDB deployment-এ পৌঁছানো যায় এবং original `BACKUP_ENCRYPTION_KEY` আছে নিশ্চিত করুন। Bundle-টি configured `BACKUP_DIR`-এ তার আসল filename-এ রাখুন।
2. এমন নতুন database name বাছুন যা আগে নেই। উদাহরণ `angar_recovered_v24`। Existing database বা existing media directory-তে restore command কাজ করে না।

```bash
npm run backup:restore -- --id YOUR_BACKUP_ID --target-db angar_recovered_v24 --confirm-new-database angar_recovered_v24
```

3. Command নতুন database এবং default `BACKUP_DIR/restored-angar_recovered_v24` media folder তৈরি করে; checksum যাচাই শেষে `verified: true`, database ও media path print করে। Custom **নতুন** folder চাইলে `--media-dir /YOUR_NEW_PRIVATE_MEDIA_PATH` দিন। Windows-এ নিজের valid path ব্যবহার করুন।
4. Restore copy-তে active staff/customer sessions, password/verification links, phone codes, pending notification jobs ও browser push subscriptions cleared থাকে। Backup schedule disabled থাকে। পুরোনো বার্তা আবার পাঠানো আটকাতে email/SMS/push preferences-ও বন্ধ থাকে; প্রয়োজনমতো নতুন করে opt in করবেন। Business documents, original invoices ও financial/provider references রাখা হয়। আবার sign in করতে হবে; push device আবার enable করতে হবে।
5. Recovery copy আলাদাভাবে পর্যালোচনা করুন। Backup-এর পর gateway-তে হওয়া payments/refunds live provider-এর সঙ্গে reconcile করুন; pending money attempts অন্ধভাবে পুনরায় initiate করবেন না। Staff accounts, latest orders, stock, invoices ও photos মিলিয়ে নিন। Restore failure হলে partial target isolated রাখুন; live data overwrite করবেন না।
6. Recovery মেনে নেওয়ার পরে app বন্ধ করে `.env`-এর `MONGODB_DB` ও `UPLOAD_DIR` verified নতুন target-এ দিন। পুরোনো database/media রাখুন, app start করে smoke test করুন। Command নিজে এই switch বা live deletion করে না।

## ৩. Event deposit ও excess online-payment refunds

Admin/cashier → **Refunds & credit notes → Event deposits & excess online payments**। সর্বশেষ ৫০টি received event deposit এবং ৫০টি verified excess payment-এর sources দেখা যায়। Food bill ও source refund একই approval/return desk ব্যবহার করে, কিন্তু আলাদা balance থাকে।

1. Source বেছে **Request source refund** দিন; available amount-এর মধ্যে full/partial amount, reason এবং event হলে return channel বাছুন। Pending requests-ও balance reserve করে।
2. Admin reason দিয়ে approve/reject করেন। Approval নিজে থেকে money returned নয়।
3. Event cash/bKash/Nagad/card return বাস্তবে সম্পন্ন হওয়ার পরে staff **Record money returned** ও verification দেন; non-cash হলে reference লাগে। App নিজে wallet/card transfer করে না।
4. Excess online payment original SSLCOMMERZ transaction/mode/merchant দিয়ে ফেরত যায়। Initiation-এর পরে provider reconciliation-এ confirmed refund পাওয়া পর্যন্ত balance ফেরত দেওয়া হয়েছে দেখায় না। Uncertain response-এ আগের refund attempt-ই recover/recheck করুন।
5. Confirmed return-এর separate numbered credit note হয়। Original deposit/payment record থাকে। Food sales, food VAT ও loyalty points এই source return-এর কারণে বদলায় না।

**Event booking:** সাধারণ refund request booking active রাখে। Future confirmed booking বাতিল করতে admin স্পষ্টভাবে cancellation checkbox বাছতে পারেন; এতে request জমার সময় venue hold release হয়। Refund approval/return আলাদা কাজ। Past/completed event বা নতুন event changes-এর জন্য existing policies ব্যবহার করুন।

**Excess funds:** সম্পূর্ণ flagged excess gateway transaction ফেরত দেওয়া যায়; bill-এ আগে credited অংশ এই source নয়। Excess record reconciliation-safe status-এ থাকে, ফলে late duplicate callback food invoice-এ দ্বিতীয় credit দেয় না। Original merchant credentials ও provider permissions প্রয়োজন।

## ৪. Order / reservation notifications

Guest/customer → **Order & reservation alerts** বা `/notifications`। Channels আলাদাভাবে opt in করতে হয়। In-app inbox private; member history account-owned এবং guest history signed browser cookie-owned। Channel চালু হওয়ার পরের নতুন updates পাঠানো হয়।

- **In-app:** order acceptance/preparation/ready/completion/cancellation, reservation updates ও waiting-list call inbox-এ আসে। Inbox ৩০ দিন থাকে।
- **Email:** signed-in account-এর verified email এবং SMTP দরকার। v2.3-এর `MAIL_MODE=smtp`, sender ও SMTP settings একইভাবে ব্যবহার করুন।
- **SMS:** phone ownership যাচাই না করে order SMS চালু হয় না। **Send phone verification code**-এ সম্মতি দিয়ে code পাঠান; ৫ মিনিটের code verify করুন; তারপর **SMS updates → Save alert preferences** দিন। Code-এ ৫ guesses, request cooldown, IP ও per-phone daily limits আছে। Code-এর send outcome uncertain হলে নতুন code request করুন; admin OTP resend করেন না।
- **Web Push:** supported browser-এ HTTPS বা localhost, notification permission ও device subscription প্রয়োজন। **Enable push on this device** browser permission নিয়ে registration করে। Per-device disable এবং account/channel opt-out আছে। Alerts lock screen-এ দেখা যেতে পারে।
- Confirmed table booking পরের এক ঘণ্টার মধ্যে হলে একবার reminder দেওয়া হয়। Waiting-list staff call-এর update যায়। Status worker interval-এর মধ্যে একাধিকবার বদলালে latest state পাঠানো হতে পারে; obsolete queued messages skip হয়।

### SMS setup (Twilio)

```dotenv
SMS_MODE=twilio
TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
TWILIO_FROM=YOUR_INTERNATIONAL_SENDER_NUMBER
```

Provider account, approved sender, destination permissions ও billing নিজের provider-এ configure করতে হবে। SMS submission মানেই delivery receipt নয়। Twilio API reference: https://www.twilio.com/docs/messaging/api/message-resource । Credentials server-only রাখুন।

**Local testing:** `MAIL_MODE=outbox`, `SMS_MODE=outbox` দিয়ে app restart করুন। Messages internet/phone-এ যায় না; private local outbox-এ থাকে। সর্বশেষ test messages/code/link দেখতে:

```bash
npm run notifications:outbox
```

এই command sensitive verification links/codes দেখায়; terminal output share করবেন না। Production-এ outbox mode নিষিদ্ধ।

### Web Push setup

```dotenv
WEB_PUSH_ENABLED=true
PUSH_VAPID_PUBLIC_KEY=YOUR_EXISTING_PUBLIC_KEY
PUSH_VAPID_PRIVATE_KEY=YOUR_EXISTING_PRIVATE_KEY
PUSH_VAPID_SUBJECT=mailto:YOUR_OPERATOR_EMAIL
```

Setup-generated key pair রাখুন; placeholder paste করবেন না। Production HTTPS ও নিজের operator contact দিন। Key pair বদলালে পুরোনো devices পুনরায় subscribe করতে হতে পারে। Browser support/OS settings ও provider availability অনুযায়ী actual display বদলাতে পারে। Web Push implementation reference: https://github.com/web-push-libs/web-push । Service worker কেবল notification handling করে; website caching আচরণ বদলায় না।

### Delivery logs / failure handling

Admin → **Notification delivery**: masked recipient, channel, attempt ও queued/submitted/skipped/unknown status। Submitted অর্থ provider গ্রহণ করেছে; inbox/mailbox/phone display নিশ্চিত হয়েছে দাবি করে না। Sending outcome uncertain হলে automatic duplicate send হয় না। Provider দেখে admin reason ও possible-duplicate acknowledgement দিয়ে **Review retry** করতে পারেন; সর্বোচ্চ ৩ attempts, unexpired message। Opt-out, changed ownership, inactive account, newer status বা cancelled reservation হলে delivery skip হয়। External jobs expiry-তে সরানো হয়; inbox আলাদা ৩০ দিন থাকে।

## ৫. Takeaway / delivery

### Admin configuration

সব roles-এর নতুন **Pickup & delivery** desk আছে। Admin → **Ordering hours & delivery areas**:

- Pickup/delivery আলাদাভাবে enable করুন; দুটিই default বন্ধ। Restaurant global ordering pause এখানেও প্রযোজ্য।
- Bangladesh time-এ open/last requested time দিন; overnight window এই release-এ নেই। Minimum prep ১০–১৮০ minutes; advance window ১–৩০ দিন।
- Delivery-র অন্তত একটি area দিতে হয়। Name, fee, minimum food subtotal এবং travel estimate দিন। Address সত্যিই area-র ভেতরে কিনা staff acceptance-এর আগে পর্যালোচনা করবেন। Geo-fencing/courier API নেই।
- Optional restaurant service charge এবং configured VAT delivery fee-তে প্রযোজ্য কিনা বাছুন। নিজের applicable tax configuration ব্যবহার করুন। Fee/tax/request price পরে settings বদলালেও saved quote/invoice snapshot-এ থাকে।

### Guest flow

Menu-এর **Takeaway & delivery**, My orders-এর link বা `/takeaway` খুলুন। Existing cart/dish options ব্যবহার করে খাবার বাছুন। Pickup/delivery, requested time (blank = next available), name ও phone দিন। Delivery-তে area/address লাগে। Signed-in member coupons/points ব্যবহার করতে পারেন; guest checkout-ও আছে।

**Review price & time** → food/discount/charge/delivery fee/VAT ও requested time দেখুন → **Confirm order request**। Server price/options/availability/fee পুনরায় যাচাই করে। Retry একই request key ব্যবহার করে duplicate order আটকায়। Staff acceptance-এর আগে invoice/payment তৈরি হয় না।

### Staff flow

| Stage / action | কার কাজ | ফল |
|---|---|---|
| Placed → Accept | Admin | Availability/recipe stock যাচাই, stock reserve, quoted benefits commit, immutable invoice তৈরি |
| Accepted → Start preparing | Admin/kitchen | Reserved ingredients consumed হিসেবে mark |
| Preparing → Mark ready | Admin/kitchen | Handover queue-তে প্রস্তুত |
| Ready pickup → Confirm collection | Admin/waiter | সম্পূর্ণ verified payment হলে collected |
| Ready delivery → Dispatch delivery | Admin/waiter | Courier/delivery-staff name প্রয়োজন; COD হলে payment pending থাকা অবস্থায় dispatch করা যায় |
| Dispatched → Confirm delivered | Admin/waiter | Cash/online payment সম্পূর্ণ verified হলে delivered |
| Record full payment / receipt | Admin/cashier | Existing verified counter/gateway billing; payment নিজে fulfilment status এগিয়ে দেয় না |

Pickup/delivery bill একবারে **full remaining balance** দিয়ে পরিশোধ হয়। Existing table bills-এর splits/partial receipts আগের মতো আছে। Online checkout একই SSLCOMMERZ verification ব্যবহার করে; configured না হলে counter/staff-verified payment ব্যবহার করুন। Cash on delivery-তে courier-এর টাকা পাওয়া restaurant যাচাই করার পর staff record করবেন। External courier booking, live GPS বা automatic transfer যোগ করা হয়নি।

### Cancellation / refunds / inventory

- Guest নিজে শুধু **placed** request reason দিয়ে cancel করতে পারেন। Accepted request-এর জন্য restaurant-এ যোগাযোগ করবেন; admin reason দিয়ে uncompleted order cancel করেন।
- Preparation-এর আগে reserved ingredients release হয়; preparing/cooked stock ফেরত যোগ হয় না। Unpaid invoice void হয় এবং committed coupon/redeemed points ফেরত আসে।
- Paid cancellation original invoice/payment বদলায় না। **Refunds & credit notes** দিয়ে explicit approval ও actual return প্রয়োজন। Pending online hold আগে reconcile করতে হবে।
- Coupon expiry/usage বা points acceptance-এর আগে বদলালে acceptance safe error দেয়; guest revised request করতে পারেন। Quote-time preview কোনো loyalty points তখনই কাটে না।
- Invoice/receipt-এ delivery fee আলাদা থাকে। Full refund-এর শেষে food/service/VAT/delivery components ঠিকমতো reverse হয়; partial refund paisa পর্যন্ত proportional হয়। Stock refund থেকে স্বয়ংক্রিয় restock হয় না।
- Sales reports dining/pickup/delivery settled bills ধরে, tax থেকে পৃথক delivery fees দেখায়; event/excess returns food sales কমায় না।
- Kitchen-কে address/phone/payment ledger দেওয়া হয় না। Guest private tracking, own receipt, courier/status/history `/takeaway`-তে দেখেন। Sign in করলে নিজের signed guest cookie-এর unclaimed orders account-এ claim হয়; browser cookie মুছলে guest access হারাতে পারে।

## ৬. Verification / acceptance

Local replica-set integration tests:

```bash
npm test
```

এগুলো isolated test databases তৈরি/সরায়; নিজের configured application database reset করে না। Test Mongo user-এর test database permissions লাগবে। Production database-এ tests চালাবেন না।

Release checks cover existing table ordering/billing/roles, encrypted backup/restore/corruption/key failure, source refund balances/approval/provider reconciliation, notification privacy/consent/OTP/retries/reminder cancellation, pickup/delivery state transitions, stock, fees/VAT, payments, refunds and existing workflow regressions. Browser checks cover the new guest/staff flows and English/Bengali mobile layouts.

Go-live-এর আগে নিজের SMTP inbox, SMS destination, browser/OS push permission, actual delivery areas, staff handover/COD process এবং merchant sandbox/live refund permissions দিয়ে acceptance test করুন। এই ZIP-এ controlled transports দিয়ে integration যাচাই করা হয়েছে; বাস্তব mailbox/SMS/push delivery বা real merchant money movement করা হয়নি।
