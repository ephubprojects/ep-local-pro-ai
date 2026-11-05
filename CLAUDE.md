# EP Local Pro AI — Claude Code Guide

## What this project is
EP Local Pro AI (eplocalproai.com) is a standalone AI-powered business platform for local businesses.
It is COMPLETELY SEPARATE from EP HUB (ephub.ai) — different codebase, different Firebase project, different Netlify site.

## Business model
- Admin (Eddie) creates demos by business category
- EP HUB members refer local business owners and earn commissions
- Business owners sign up → get their own AI ordering/assistant page
- Customers visit the business's page → AI takes orders → payment button appears

## Stack
| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML / CSS / JS (no framework, no bundler — fastest possible) |
| Hosting | Netlify |
| Database | Firebase Firestore (NEW project: ep-local-pro-ai) |
| Auth | Firebase Authentication |
| AI Voice | ElevenLabs Conversational AI (@11labs/client SDK) |
| Payments | Stripe / PayPal / CashApp / Zelle links per business |
| Email | Resend API |
| SMS | Twilio |
| Documents | OpenAI GPT-4o-mini (invoices, estimates, contracts) |

## Project structure
```
public/               ← Netlify serves this
  index.html          ← Marketing landing page
  admin.html          ← Super admin (Eddie only)
  dashboard.html      ← Business owner portal
  order.html          ← Customer-facing AI ordering page
  kitchen.html        ← Kitchen display (restaurants)
  auth.html           ← Login / signup
  assets/             ← Long-cached static assets
    logo.svg
    logo-white.svg
    categories/       ← SVG icons per category
  css/
    main.css          ← Global CSS variables + reset (all pages)
    admin.css         ← Admin only
    dashboard.css     ← Business owner only
    order.css         ← Customer page only
    kitchen.css       ← Kitchen display only
  js/
    firebase.js       ← Firebase init (shared, tiny)
    admin.js          ← Admin panel logic
    dashboard.js      ← Business owner dashboard
    order.js          ← Customer AI ordering + cart
    kitchen.js        ← Kitchen display

netlify/functions/    ← One function = one job
  ai-session.js       ← ElevenLabs session config
  business.js         ← Business CRUD
  demo.js             ← Demo management
  convert-demo.js     ← Demo → Account conversion
  order.js            ← Order management
  invoice-generate.js ← AI invoice PDF
  estimate-generate.js← AI estimate
  contract-generate.js← AI contract
  receipt-generate.js ← Receipt
  send-invite.js      ← Invite email
  send-notification.js← Order SMS/email alerts

data/
  categories.json     ← Business category templates

firestore.rules
firestore.indexes.json
netlify.toml
package.json
```

## Performance rules — NEVER BREAK THESE
- Each HTML page loads ONLY its own CSS and JS (no shared bundles)
- order.html must load under 30KB total JS (ElevenLabs SDK loaded lazily only when call starts)
- No jQuery, no Bootstrap, no heavy dependencies
- System fonts only (no Google Fonts requests)
- Assets in /assets/ folder get 1-year cache headers
- Firebase SDK loaded from Google CDN (already cached on most browsers)

## Firebase project
- Project ID: ep-local-pro-ai (create at console.firebase.google.com)
- Admin email: ezperfilsystem@gmail.com

## Netlify
- Site: eplocalproai.com
- Build: no build step needed (publish = "public")

## EP HUB connection (the ONLY connection)
When a business converts from demo to paid account, write to Firestore:
  collection: ep_referrals
  doc: { sponsorUsername, businessSlug, convertedAt, plan }
EP HUB commission system reads this to pay the referring member.

## Branch strategy
- main → production (eplocalproai.com)
- dev → staging
Never commit directly to main. All work on dev.

## ⚠️ DO NOT touch EP HUB files
This project has zero dependency on EP HUB code.
