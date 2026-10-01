# Four Flavours — Premium Restaurant POS v2

Vanilla JavaScript + Supabase restaurant ordering and management SPA.

## v2 architecture

This version is built around a single restaurant/table dining-session concept.
A table visit has one `dining_sessions` row. Every customer/POS ordering round
is an `orders` row linked to that session. The final bill is calculated once for
the complete session.

### Customer flow

```text
Scan QR
  ↓
Menu only
  ↓
Add dishes
  ↓
Next
  ↓
Review
  ↓
Confirm order
  ↓
Order received
  ├── Order more → menu → another round
  └── Bill → request final bill
              ↓
        staff prepares bill
              ↓
          View final bill
```

The customer never sees a running bill on the menu. Bill totals/details are
only returned after the session reaches `bill_ready` or `closed`.

### Main UI changes

- No page-level horizontal scrolling.
- Product images use one `4:3` media ratio across devices.
- Main POS has no permanent cart/bill pane.
- POS order review appears only after **Next**.
- Customer cart/order review appears only after **Next**.
- Long products, tables and session lists live inside vertical scroll containers.
- The Four Flavours logo/icon is centered at the top of each interface.
- Forest green / olive / warm cream / subtle gold palette is based on the
  supplied green cutlery icon.
- Phosphor icons are used for actions instead of repeated text labels.
- Desktop, tablet and mobile breakpoints have intentionally different density.
- No browser `alert()`, `confirm()` or `prompt()` is used anywhere.
- Table add/edit/delete uses branded in-site modals.

## File tree

```text
four-flavours-pos/
├── assets/
│   ├── images/
│   │   ├── website_icon.png
│   │   └── website_logo.png
│   └── icons/
├── src/
│   ├── core/
│   │   ├── config.js
│   │   ├── supabase.js
│   │   ├── posState.js
│   │   └── router.js
│   ├── components/
│   │   ├── navigation.js
│   │   └── lockScreen.js
│   ├── pos/
│   │   └── index.js
│   ├── customer/
│   │   └── index.js
│   └── admin/
│       └── index.js
├── sql/
│   └── schema.sql
├── index.html
├── styles.css
├── app.js
└── README.md
```

## Database upgrade

Run `sql/schema.sql` in Supabase SQL Editor.

It is designed to preserve the existing menu/data and add the new dining
session layer. It also upgrades `orders` and `order_items` with the fields
needed for consolidated billing.

After running the schema, verify that these tables/functions exist:

```text
public.dining_sessions
public.ensure_customer_session(...)
public.get_customer_session_state(...)
public.place_customer_order(...)
public.request_session_bill(...)
public.mark_session_bill_ready(...)
public.get_customer_session_bill(...)
public.complete_session_payment(...)
```

## Supabase configuration

The supplied project already contains the latest browser-safe Supabase URL
and publishable/anon key from the uploaded codebase. Do not replace it with a
service-role/secret key.

## Admin account

Create an Auth user in Supabase:

```text
Authentication → Users → Add user
```

Then set that user's profile role and PIN:

```sql
update public.profiles
set
  role = 'admin',
  pin_hash = extensions.crypt(
    'YOUR_REAL_6_DIGIT_PIN',
    extensions.gen_salt('bf')
  )
where id = 'YOUR-AUTH-USER-UUID';
```

The web UI then requests:

```text
Email + Supabase password + 6-digit PIN
```

## Routes

```text
Staff POS:
/

Admin:
#/4

Customer table menu:
https://tff.vercel.app/?table=<TABLE_UUID>
```

`Ctrl+F` routes staff/admin users to `#/4`. The customer QR experience does
not expose the app drawer/navigation.

## Table management

Admin → Tables supports:

- Add table
- Edit table number
- Edit capacity
- Activate/deactivate table
- Delete table
- View/print table QR

The interface does not use browser prompts or confirmations.

Deletion keeps historical order rows safe through `ON DELETE SET NULL` on
historical table references. An active dining session should be closed before
deleting a table; the final production version can enforce that rule via an
additional delete RPC if required.

## Realtime

The POS subscribes to `orders` inserts and `dining_sessions` changes. This is
used to surface:

- new QR orders
- bill requests
- bill readiness changes

For higher-scale realtime fan-out, Supabase Broadcast can later replace or
supplement the Postgres Changes subscription.

## APP_VERSION cache busting

Current version:

```js
export const APP_VERSION = "2.0.0";
```

For a release, change it to e.g.:

```js
export const APP_VERSION = "2.0.1";
```

Then globally Find/Replace in `index.html`:

```text
Find:    v=2.0.0
Replace: v=2.0.1
```

Dynamic JavaScript-created asset URLs use:

```js
versionedAsset("assets/images/website_icon.png")
```

so they automatically receive the current version query string.

## Local development

Do not use `file://`.

Use Python:

```bash
cd four-flavours-pos
python -m http.server 5173
```

Open:

```text
http://localhost:5173/
```

## Production next steps

For a complete enterprise rollout, add:

```text
Kitchen Display System
Inventory / stock ledger
Purchasing
Shift management
Cash drawer
Payment gateway/webhooks
Audit trail
Role/permission matrix
Offline/PWA POS queue
Multi-branch architecture
Automated migrations
Automated tests
Observability/error tracking
```
