# CGTIA — Firebase Backend Blueprint

This describes the backend behind the CGTIA site: what gets stored where,
how the login-code auth flow works end to end, and what's still needed on
the frontend to actually connect the HTML pages to it.

---

## 1. The auth flow, step by step

This is the exact flow as specced, mapped onto Firebase:

**Certificate / Diploma / Higher Diploma applicants:**
1. Student fills out the Apply form, picks **Full Payment** or **3
   Installments** on the payment screen, and submits → an `applications`
   document is created with `status: "pending"`, `paymentStatus: "unpaid"`,
   `paymentPlan: "full"` (`installmentsTotal: 1`) or `paymentPlan:
   "installment"` (`installmentsTotal: 3`), and `installmentsPaid: 0`.
2. They're approved and taken to the payment screen (Transfer or Card),
   which shows either the full amount or just the first installment,
   depending on the plan they picked.
3. That first payment is confirmed:
   - **Card** → Paystack calls the `paystackWebhook` Cloud Function
     server-to-server, which verifies it.
   - **Transfer** → staff manually confirm it via the
     `adminConfirmTransferPayment` callable function once they see it hit
     the account.
   Either way, this increments `installmentsPaid` by one and sets
   `paymentStatus` to `"paid"` (full plan, or the 3rd installment just
   landed) or `"partially_paid"` (1st or 2nd installment of three).
4. The moment `installmentsPaid` goes from **0 to 1** — i.e. the very
   first payment, whether that's the full amount or just installment 1 of
   3 — the `onApplicationPaid` Firestore trigger fires automatically and:
   - Creates their Firebase Auth account (email + a randomly generated
     temporary password).
   - Emails them that temporary password as their **login code**, via Gmail.
   - Sets `mustChangePassword: true` on their `users/{uid}` document.
   This is intentional and matches what you asked for: they get access
   after the *first* installment, not after paying in full. Installments 2
   and 3 (if applicable) just update `installmentsPaid`/`paymentStatus` —
   they don't trigger provisioning again (there's an idempotency guard
   either way).
5. Student logs in with their email + the emailed code (a normal Firebase
   Auth email/password sign-in).
6. On that first login, the client sees `mustChangePassword: true` and shows
   a **"set your new password"** screen before anything else — this calls
   Firebase Auth's `updatePassword()`, then flips `mustChangePassword` to
   `false` on their own user doc (the only field they're ever allowed to
   write on it — see `firestore.rules`).
7. Once that's done, they land on their dashboard. Which dashboard depends
   on `users/{uid}.program` (`certificate` / `diploma` / `higher-diploma`) —
   route to the matching dashboard view client-side based on that field.
   If they're on the installment plan, the dashboard should show their
   remaining balance (`installmentsTotal - installmentsPaid`) somewhere
   visible, with a way to pay the next one.

**Licensing and Custom (individual / school / organization) applicants:**
- These **never** get an account created for them automatically. Their
  submissions land in `licensingApplications` and `customRequests`
  respectively, for staff to review and follow up with manually (email,
  phone, WhatsApp) — no login code is ever sent for these two paths, by
  design, matching what you asked for.

---

## 2. Firestore schema

### `applications/{appId}`
Certificate / Diploma / Higher Diploma applications from the Apply form.

| Field | Type | Notes |
|---|---|---|
| `fullName`, `email`, `phone` | string | from the form |
| `program` | string | `certificate` \| `diploma` \| `higher-diploma` |
| `startDate` | string | the fixed cohort date shown on the form |
| `message` | string | optional "tell us about you" text |
| `status` | string | `pending` → `enrolled` (set by the provisioning function) |
| `paymentPlan` | string | `full` \| `installment` — picked on the payment screen |
| `installmentsTotal` | number | `1` for full payment, `3` for the installment plan |
| `installmentsPaid` | number | `0` to `installmentsTotal` — provisioning fires the moment this reaches `1` |
| `paymentStatus` | string | `unpaid` → `partially_paid` (some but not all installments in) → `paid` (fully settled) |
| `paymentMethod` | string | `transfer` \| `card`, set on each payment |
| `paystackReference` | string | set for card payments |
| `uid` | string | set once their account is provisioned |
| `createdAt`, `updatedAt` | timestamp | |

### `licensingApplications/{id}`
| Field | Type | Notes |
|---|---|---|
| `fullName`, `email`, `phone` | string | |
| `certificateFileUrl`, `idFileUrl`, `selfieFileUrl` | string | Storage paths, see §4 |
| `status` | string | `pending` \| `under_review` \| `approved` \| `rejected` |
| `paymentStatus` | string | `unpaid` \| `paid` |
| `createdAt`, `updatedAt` | timestamp | |

### `customRequests/{id}`
| Field | Type | Notes |
|---|---|---|
| `applicantType` | string | `individual` \| `school` \| `organization` |
| `name`, `email`, `phone` | string | |
| `details` | map | the type-specific fields (school name, student count, org request type, etc.) |
| `status` | string | `new` \| `contacted` \| `quoted` \| `closed` |
| `createdAt` | timestamp | |

### `contactMessages/{id}`
Both the general Contact form and each FAQ's "Still have a question?" box
write here.

| Field | Type | Notes |
|---|---|---|
| `name`, `email` | string | optional depending on which form |
| `message` | string | |
| `faqTopic` | string | set only when it came from an FAQ item |
| `preferredContactMethod` | string | `email` \| `whatsapp` |
| `contactValue` | string | the email or WhatsApp number they gave |
| `status` | string | `new` \| `answered` |
| `createdAt` | timestamp | |

### `users/{uid}`
One doc per Firebase Auth account — only ever created by the
`provisionStudentAccount` logic (Admin SDK) or the first-admin bootstrap
script, never directly by a client.

| Field | Type | Notes |
|---|---|---|
| `email`, `fullName`, `phone` | string | |
| `role` | string | `student` \| `admin` (mirrors the custom claim) |
| `program` | string | which dashboard to route them to |
| `applicationId` | string | back-reference to their `applications` doc |
| `mustChangePassword` | boolean | drives the forced first-login password screen |
| `status` | string | `active` \| `suspended` |
| `createdAt` | timestamp | |

### `programs/{programKey}` *(optional reference data)*
Public read-only docs (`certificate`, `diploma`, `higher-diploma`,
`licensing`) holding the name/amount/fixed start date, if you'd rather pull
pricing from Firestore than hardcode it in the HTML like it is today.

### `certificates/{id}`
Powers `verify.html` — anyone can look up a certificate/license by its
serial number to confirm it's genuine. Staff create these manually (there's
no automated pipeline generating serial numbers yet) via the Firebase
Console or the Admin SDK once a student actually completes a program.

| Field | Type | Notes |
|---|---|---|
| `serialNumber` | string | printed on the physical certificate; this is what the lookup form queries by |
| `studentName` | string | |
| `program` | string | display name, e.g. "CGTIA Certificate" |
| `issueDate` | string | |
| `status` | string | `valid` \| `revoked` |

Read is public (`allow read: if true`) since verification only works if
anyone can check it without an account — write is admin-only.

---

## 3. Cloud Functions (`functions/index.js`)

| Function | Trigger | Does |
|---|---|---|
| `onApplicationPaid` | Firestore update on `applications/{id}` | Provisions the student's account + emails their login code, the moment `paymentStatus` becomes `paid` |
| `paystackWebhook` | HTTPS (called by Paystack) | Verifies the webhook signature, confirms the card payment, sets `paymentStatus: "paid"` |
| `adminConfirmTransferPayment` | Callable (admin only) | Staff manually confirm a bank transfer |
| `setAdminRole` | Callable (admin only) | Promote another account to staff/admin |
| `notifyOnNewApplication` | Firestore create on `applications/{id}` | Emails staff a summary the moment a new application comes in |
| `notifyOnNewLicensingApplication` | Firestore create on `licensingApplications/{id}` | Same, for Licensing submissions |
| `notifyOnNewCustomRequest` | Firestore create on `customRequests/{id}` | Same, for Individual/School/Organization requests |
| `notifyOnNewContactMessage` | Firestore create on `contactMessages/{id}` | Same, for the Contact form and each FAQ's "Ask us" box |

Secrets required (`firebase functions:secrets:set NAME`):
- `GMAIL_USER` — the Gmail address sending login-code and staff-notification emails
- `GMAIL_APP_PASSWORD` — a Gmail **App Password**, not the normal account
  password (Google Account → Security → 2-Step Verification → App
  Passwords). Gmail blocks plain-password SMTP login.
- `PAYSTACK_SECRET_KEY` — from the Paystack dashboard, used to verify
  webhook signatures
- `STAFF_EMAIL` — where new-submission notifications are sent; can be a
  single address or a comma-separated list. If this secret isn't set, the
  notification functions just skip sending quietly rather than erroring.

---

## 4. Storage layout

```
/licensing/{requestId}/certificate.(pdf|png|jpg)
/licensing/{requestId}/id.(pdf|png|jpg)
/licensing/{requestId}/selfie.(png|jpg)
```

`{requestId}` should be generated client-side (`crypto.randomUUID()`) and
used as **both** the Storage folder name and the `licensingApplications`
document id, so the two are linked.

Licensing applicants are never authenticated (per the flow above), so these
uploads happen while signed out — `storage.rules` allows the upload itself
but restricts *reading* the files back to staff only. Before this goes live
with real documents and selfies, turn on **Firebase App Check** on the
project so this open upload endpoint can only be hit from your actual site,
not a script hitting the API directly.

---

## 5. Security model summary

- **Public (signed out) can:** create an `applications`, `licensingApplications`,
  `customRequests`, or `contactMessages` doc; upload to `/licensing/{id}/`.
  Nothing else.
- **Students (role: student) can:** read their own `applications` doc and
  their own `users` doc; flip `mustChangePassword` to `false` on their own
  account after actually changing it. Nothing else.
- **Admins (role: admin) can:** read/write everything, confirm transfers,
  promote other admins.
- Every collection has a default-deny fallback rule — nothing is readable
  or writable unless a rule explicitly allows it.

---

## 6. Setup order

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # pick/create your Firebase project, update .firebaserc

# Secrets
firebase functions:secrets:set GMAIL_USER
firebase functions:secrets:set GMAIL_APP_PASSWORD
firebase functions:secrets:set PAYSTACK_SECRET_KEY
firebase functions:secrets:set STAFF_EMAIL

# Install function dependencies
cd functions && npm install && cd ..

# Deploy
firebase deploy --only firestore:rules,firestore:indexes,storage,functions,hosting
```

### Creating your first admin
`setAdminRole` requires you to already be an admin — a bootstrapping
problem for account #1. Use `scripts/createFirstAdmin.js` once (see the
comments in that file for the two setup steps), then use `setAdminRole`
for every admin after that.

### Hosting
Firebase Hosting expects your site files in a `public/` folder. Move
`index.html`, `about.html`, `programs.html`, `tuition.html`, `gallery.html`,
`contact.html`, `licensing.html`, and `custom.html` into `/public` before
running `firebase deploy --only hosting`.

---

## 7. Frontend integration checklist — not done yet

Being direct about where things stand: the backend above is ready to
deploy, but **the site's current JavaScript doesn't call Firebase at all
yet.** Right now, `handleApplySubmit`, `handleLicensingSubmit`,
`handleCustomSubmit`, and `handleContactSubmit` all simulate success/failure
with `Math.random()` — none of them write to Firestore, upload to Storage,
or initiate a real Paystack transaction tied to a document id. To actually
connect this backend, the following still needs doing on the HTML/JS side:

1. Add the Firebase SDK (`firebase-app`, `firebase-firestore`,
   `firebase-auth`, `firebase-storage`) to each page, initialized with your
   project's config object.
2. Replace each `Math.random()` simulation with a real
   `addDoc()`/`setDoc()` call into the matching collection.
3. For the Apply form specifically: create the `applications` doc *first*
   (on submit), including `paymentPlan`, `installmentsTotal` (1 or 3), and
   `installmentsPaid: 0` based on which plan they picked on the payment
   screen. Keep the doc's id in memory, and pass that id as the `reference`
   in `PaystackPop.setup({ reference: applicationId, ... })` — the webhook
   depends on this id match to find the right document. For bank transfer,
   the amount they were shown (full amount, or just the first installment)
   needs to reach staff somehow so they know what to expect hitting the
   account — either store it on the application doc too, or rely on the
   transfer remark carrying the program name as the site already prompts
   for.
4. For the Licensing form: generate the `requestId`, upload the three files
   to `/licensing/{requestId}/...` in Storage, then create the
   `licensingApplications/{requestId}` doc referencing those paths.
5. Build the actual student dashboard pages (one per program, or one
   dashboard that reads `users/{uid}.program` and adapts) plus the
   forced-password-change screen described in §1.
6. Build a lightweight admin view (or just use the Firebase Console
   directly at first) for staff to review applications and confirm
   transfers via `adminConfirmTransferPayment`.

Happy to build any of these next — just say which piece you want first.
