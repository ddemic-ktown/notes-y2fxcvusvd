# App Launch Plan — Web + App Store

## Overall Approach: Web First, Then React Native + Expo

---

## Phase 0 — Move Off GitHub Pages (Before Selling)

**Current setup:** The app is hosted on GitHub Pages (`ddemic-ktown.github.io/notes-y2fxcvusvd/`). This is fine for development but has limitations:

- GitHub Pages has a 100GB/month bandwidth limit (~200,000 page loads)
- GitHub's terms of service discourage using Pages for commercial purposes
- No custom domain without extra setup
- Not suitable once you're actively selling subscriptions

**Steps:**

1. Buy a domain (e.g. `companyorganizerninja.com`) — ~$15/year via Namecheap or Google Domains
2. Set up **Firebase Hosting** (best fit since you're already on Firebase) — one command: `firebase deploy`. Free tier includes 10GB storage and 360MB/day transfer
3. Point your custom domain at Firebase Hosting
4. Update Firebase's authorized domains list to include the new domain so Google sign-in keeps working

**Alternative:** Netlify — drag and drop the project folder, free up to 100GB/month, easy custom domain setup.

---

## Phase 1 — Launch Web App with Subscriptions (Weeks 1–4)

The app is already built. Add Stripe for billing:

- Integrate **Stripe** — payment page on your website, monthly/annual pricing
- On sign-in, check Stripe subscription status → if inactive, show paywall
- Store subscription status in Firestore
- The existing PWA already works on mobile browsers and can be installed on phone home screens — this covers mobile users immediately with no app store needed

Revenue: you keep ~97% (Stripe takes 2.9% + 30¢)

---

## Phase 2 — Get First Paying Customers

- Build a simple landing page (Netlify, free) with screenshots, pricing, "Sign in with Google" button
- Share the URL, collect feedback, iterate
- Use this revenue and feedback to validate before investing in native apps

---

## Phase 3 — Google Ads

**Goal:** Drive traffic to your landing page and convert visitors to paying subscribers.

**Campaign type:** Search ads — shows when people actively search for what you offer. Best for intent-driven SaaS.

**Targeting:**
- Keywords: "notes app for contractors", "customer management app trades", "job site organizer app", "small business customer tracker"
- Match type: phrase match to start — captures variations without being too broad
- Location: start with your local area or one city/region to keep costs low and test messaging

**Budget:**
- Start small: $10–$20/day (~$300–$600/month)
- Expect $1–$5 per click for niche B2B terms
- At $2/click and $300/month: ~150 visitors/month
- If 5% convert to paid: ~7–8 new customers/month

**Ad headlines to test:**
- "Organize Your Customers & Job Notes"
- "The Notes App Built for Tradespeople"
- "Keep Track of Every Customer & Job"
- Always include a clear call to action: "Try Free" or "Start Today"

**Landing page must-haves:**
- Clear headline matching the ad
- Screenshots of the app
- Pricing upfront
- One obvious button: "Start Free Trial" or "Sign Up"
- Fast load time — Google penalizes slow pages with higher ad costs

**Measuring success:**
- Set up Google Analytics on the landing page
- Track: clicks → visits → sign-ups → paid conversions
- Cost per acquisition (CPA) = total ad spend ÷ paying customers
- Target CPA should be less than your first month's subscription price

**When to scale:**
- If CPA is profitable after 30 days, increase budget
- If not, adjust keywords or landing page before spending more

---

## Phase 4 — Rebuild Frontend in React Native (Weeks 4–12, in parallel)

Same Firebase backend, only the UI changes. Key libraries:

- `@react-native-firebase` — same Firebase already in use
- **RevenueCat** — handles in-app subscriptions for both stores in one API, also supports Stripe so all billing is in one dashboard
- `expo-router` — screen navigation
- **Expo EAS Build** — build for both platforms without needing a Mac

Subscription logic: check both Stripe (web customers) and RevenueCat (app store customers) on sign-in — either active = full access. No double-charging.

### Using Claude Code to Build the React Native App

Rather than building manually, use **Claude Code** as an AI coding agent supervised by Claude (Cowork) to write the code:

**Setup:**
1. Install Claude Code: `npm install -g @anthropic/claude-code`
2. Get an Anthropic API key at console.anthropic.com
3. Run `claude` in the project folder

**Workflow:**
1. Claude (Cowork) writes detailed task-by-task specs
2. You paste each spec into Claude Code in Terminal
3. Claude Code implements it autonomously — reads, writes, and edits files
4. You test on your phone using **Expo Go** (scan a QR code, see changes live)
5. Report results back, Claude (Cowork) reviews and writes the next instruction

**Estimated coding time with Claude Code:** 11–17 hours of AI work across multiple sessions, plus your testing time on device.

**Screens to build:**

| Screen            | Description                                           |
|-------------------|-------------------------------------------------------|
| Sign in           | Google auth                                           |
| Home              | Notes, customers card, aggregator cards               |
| Customer list     | Search, sort, add                                     |
| Customer notes    | Per-customer note list                                |
| Note editor       | Full editor with search, checkboxes, keyboard handling|
| Aggregator detail | Keyword matches across all customers                  |
| Settings          | Counts, keywords, users, invite, theme, sign out      |

**Note:** The note editor will require the most iteration — keyboard handling on mobile is complex and typically needs several rounds of fixes.

---

## Phase 5 — App Store Setup (Weeks 10–14)

**Apple:**
- $99/year Apple Developer Program
- Submit via Expo EAS Build (no Mac needed)
- Review 1–3 days, stricter rules
- Important: don't mention cheaper web pricing inside the iOS app — Apple prohibits it (anti-steering rule)
- You CAN include a Help or FAQ button that links to your website — support and help links are allowed. Your website can then include pricing info; you just can't direct users there explicitly for the purpose of buying
- Android does not have this restriction — linking to your website for purchases is allowed on Google Play

**Google:**
- $25 one-time Google Play Console fee
- Submit via Expo EAS Build
- Review a few hours to 2 days, more lenient
- Consider launching Android only first — cheaper, faster, easier to iterate

---

## Phase 6 — Landing Page + Marketing

- Update landing page with App Store / Google Play download buttons alongside the web signup
- Existing web/PWA customers keep their accounts — data is identical across all platforms

---

## Realistic Timeline

| Phase                               | Timeline           |
|-------------------------------------|--------------------|
| Phase 0 — Move off GitHub Pages     | Before selling     |
| Phase 1 — Web + Stripe              | Weeks 1–2          |
| Phase 2 — First customers           | Ongoing from week 2|
| Phase 3 — Google Ads                | Week 2 onwards     |
| Phase 4 — React Native              | Weeks 4–12         |
| Phase 5 — Store submission + review | Weeks 10–14        |
| Phase 6 — Landing page update       | Week 14+           |
| **First app store customer**        | **~3–4 months**    |

Paying web customers from week 2.

---

## Grandfathering / Founding Member Pricing

As the user base grows, you can raise prices for new customers while keeping existing customers at their original rate forever. Stripe handles this automatically.

**How it works:**
- Create a new higher price in Stripe — never modify or delete the old price
- Point new signups to the new price
- Existing subscriptions automatically continue billing at their original rate on every renewal
- If a grandfathered customer cancels and resubscribes, they'd get the new price — you can override this manually in the Stripe dashboard if needed

**Founding member strategy:**
- Set an intentionally low launch price (e.g. $19/month)
- Advertise "first 100 customers locked in at this rate forever"
- Creates urgency to sign up early and rewards early adopters
- Once you hit the limit, raise the price for new customers (e.g. $29/month)

**Multiple grandfathered tiers example:**

| Tier   | Customers  | Price      | Label          |
|--------|------------|------------|----------------|
| Tier 1 | First 100  | $19/month  | Founding Member|
| Tier 2 | 101–500    | $24/month  | Early Adopter  |
| Tier 3 | 500+       | $29/month  | Standard       |

Each tier is a separate price in Stripe. You decide when to move to the next tier — by customer count, a date, or whenever you choose. Customers are permanently locked to the price they signed up with.

**In the app:**
- Show "Founding Member" badge or label on the account/settings screen for grandfathered users
- Store the pricing tier in Firestore alongside subscription status so the app can display it

---

## Key Notes

- All platforms share the same Firebase backend — data is identical across web, PWA, and native app
- RevenueCat free up to $10k/month revenue, then 1%
- Apple prohibits mentioning cheaper web pricing inside iOS app
- Android-only launch is a valid cost-saving first step ($25 vs $99/year)

---

## Skills Required to Administer The Operation

Use this list when hiring someone to manage the technical and marketing side.

### Technical Skills

- **Firebase** — Firestore database, Authentication, Hosting, Security Rules, Cloud Functions
- **JavaScript / Node.js** — the app is plain JS; Cloud Functions are Node.js
- **React Native + Expo** — for building and maintaining the mobile app
- **Git / GitHub** — version control, pushing updates, managing the repository
- **HTML / CSS** — for maintaining and updating the web app
- **Stripe** — subscription setup, webhook configuration, price management, dashboard
- **RevenueCat** — in-app purchase setup for iOS and Android, dashboard monitoring
- **Google Play Console** — submitting updates, managing the Android app listing
- **App Store Connect** — submitting updates, managing the iOS app listing, dealing with Apple review

### Marketing / Growth

- **Google Ads** — campaign setup, keyword research, bid management, conversion tracking
- **Google Analytics** — setting up tracking, reading reports, understanding funnels
- **Landing page** — ability to build and update a simple marketing website

### Business / Operations

- **Stripe dashboard** — monitoring revenue, handling refunds, managing subscriptions
- **Customer support** — responding to user issues, managing accounts
- **Domain management** — DNS settings, renewing domains
- **Firebase billing** — monitoring usage, understanding when free tier limits are approached

### Nice to Have

- Experience with PWAs
- Familiarity with Apple/Google developer program requirements
- Basic understanding of Firestore security rules

---

## Alternatives to Consider

- **Capacitor** — wrap existing web app in a mobile shell, much faster than React Native (1–2 weeks) but slightly less native feel
- **Android only first** — half the cost, faster review, validate demand before paying Apple's $99/year
- **RevenueCat** — free tier covers you until $10k/month, no upfront billing infrastructure cost
- **Skip native apps entirely** — many successful SaaS businesses run PWA-only with no app store presence
