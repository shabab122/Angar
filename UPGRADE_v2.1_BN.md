# Angar Kitchen v2.1 — Upgrade ও acceptance check

বর্তমান React v2-এর ওপর এই release তৈরি হয়েছে। Home/brand design, React–Express–MongoDB stack, ordering, table billing, counter payment, review ও event feature রাখা হয়েছে। নির্বাচিত পাঁচটি update ছাড়া নতুন payment gateway, delivery বা অন্য roadmap feature যোগ হয়নি।

## পুরোনো data রেখে চালানো

1. পুরোনো Node app-এ `Ctrl+C` দিন। পুরোনো folder এবং database backup রাখুন। MongoDB চলতে দিন।
2. ZIP আলাদা folder-এ extract করুন। পুরোনো `.env` নতুন `angar-kitchen-react` folder-এ copy করুন। MongoDB URI/database, cookie secret ও origin বদলাবেন না। Photo থাকলে `data/reviews` copy করুন বা একই `UPLOAD_DIR` দিন।
3. নতুন project folder-এ ক্রমানুসারে:

```bash
npm ci
npm run setup
npm run build
npm start
```

4. http://localhost:3000 এবং http://localhost:3000/staff খুলুন। পুরোনো staff account/password ব্যবহার করুন। পুরোনো database থাকলে demo seed দরকার নেই।

নতুন installation হলে Node.js 24+, Docker/Podman Compose ও MongoDB replica set প্রয়োজন। Full fresh-install commands `README.md`-এ আছে। এই update-এ Compose file বদলানো হয়নি। পুরোনো initialized MongoDB-ই reuse করুন; নতুন folder থেকে দ্বিতীয় MongoDB instance চালালে 27017 port conflict/অন্য volume হতে পারে।

## ১. Waiter ও bill request

- Active table QR scan করে Menu-তে **Call waiter** চাপুন। Button pending থাকবে, staff অপেক্ষার message দেখা যাবে। একই টেবিলের দুই ফোন একই type-এর request করলে একটিই তৈরি হবে।
- আলাদা browser/profile-এ `waiter` দিয়ে login করুন। যেকোনো staff tab-এ sidebar-এর **Floor requests** count দেখুন। সেখানে **Acknowledge** চাপুন। Guest-এ acknowledgement পৌঁছাবে।
- সাহায্য করা শেষে **Resolve request** দিন। Guest completion দেখবেন এবং আবার request করতে পারবেন। Bill request একইভাবে কাজ করে; request দিলেই bill finalize/payment হয় না।
- Dashboard-এ **Enable alerts** দিন, এরপর নতুন request করে sound event দেখুন। Browser background হলে polling/audio browser দ্বারা সীমিত হতে পারে।

## ২. Food availability

- `kitchen` বা `admin` → **Food availability** → একটি dish **Mark sold out** করুন।
- Guest menu সর্বোচ্চ পরের ৫ সেকেন্ডের refresh-এ sold out দেখাবে; Add disabled হবে। আগে cart-এ থাকলেও checkout backend reject করবে।
- **Make available** দিলে আবার order করা যাবে। আগে গ্রহণ করা order queue থেকে মুছে যাবে না। Kitchen এই screen/API দিয়ে price বদলাতে পারবে না।

## ৩. Sales report ও CSV

- Guest-এর order admin → kitchen → waiter দিয়ে Served করুন। Counter/Billing-এ finalize করে বাস্তবে টাকা পাওয়ার পরে verified payment record করুন।
- `admin`/`cashier` → **Sales reports** → Today/Last 7 days/This month বা নিজস্ব date range দিন। Daily/Monthly grouping বদলে **Apply range** দিন।
- Collected, food sales, service charges, average paid bill ও paid-bill count দেখুন। Popular dishes/payment methods মিলিয়ে দেখুন।
- Summary, Daily/monthly, Dishes, Payments CSV download করুন। Range সর্বোচ্চ ৩৬৬ দিন; Bangladesh time অনুযায়ী প্রথম/শেষ দিন অন্তর্ভুক্ত। Unpaid bills, cancelled orders, event deposits বাদ থাকে। এটি profit হিসাব নয়।

## ৪. Kitchen timer ও alert

- নতুন order দিন; **Order desk**-এ total elapsed ও বর্তমান stage timer চলবে। Stage পাল্টালে শুধু stage timer নতুন করে শুরু হবে।
- Awaiting staff ৫ মিনিট, queued ১০, preparing ২০, ready ৫ মিনিটের পর delayed marker দেখাবে। Quantity/note approval দিয়ে stage timer reset হয় না।
- **Enable alerts** দিয়ে নতুন station ticket test করুন। প্রথমবার dashboard খুললে পুরোনো backlog-এর জন্য একসঙ্গে sound হয় না; পরবর্তী নতুন update-এ হয়।

## ৫. পরিবর্তন ও cancellation approval

- নতুন order দিয়ে **My orders → Request changes** খুলুন। Quantity বা note বদলান ও কারণ লিখুন। Quantity ০ দিলে একটি line বাদ যায়; সব line বাদ দিতে cancellation request ব্যবহার করুন।
- Pending অবস্থায় original order/total দেখুন। Admin Order desk-এ guest-এর reason, proposed quantities ও নতুন total দেখবেন। Send/start cooking blocked থাকবে।
- Admin decision reason লিখে **Approve changes** বা **Reject request** দিন। Approval-এ order/total বদলাবে; rejection-এ আগেরটা থাকবে। Guest সিদ্ধান্ত ও কারণ দেখবেন।
- মূল order-এর unit price/size/add-on snapshot অপরিবর্তিত থাকে। Quantity বাড়াতে approval-এর সময়ও dish available থাকতে হবে। অন্য dish যোগ করতে আলাদা order দিন।
- **Request cancellation**-এর পরে order তখনই Cancelled হবে, যখন admin approve করেন। Cancelled order billed sales-এ যায় না।
- Cooking শুরু হয়ে গেলে change request ও direct admin cancellation আর নেওয়া হয় না। একসঙ্গে request/start হলে backend একটি কার্যক্রমই গ্রহণ করে।

## Database compatibility ও versioning

আগের orders-এ `revision` না থাকলে ০ ধরে চলে; নতুন request fields optional। বিদ্যমান bills-এর snapshot থেকেই report তৈরি হয়। Required index startup-এ নিশ্চিত হয়; data reset বা destructive migration প্রয়োজন নেই। Photo/database/secret আগের মতো রেখে upgrade করুন।

Git commit suggestion:

```text
feat: add Angar Kitchen v2.1 service controls and order change approvals
```
