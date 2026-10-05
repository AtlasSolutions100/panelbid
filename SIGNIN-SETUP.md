# PanelBid sign-in: what the owner sets up

PanelBid now asks for one company password before it shows anything. Without it nobody can read the jobs, the plans,
the customer list or the e-mail activity, change or delete anything, cut the Gmail link, or press the AI buttons.

Until the two settings below are in place, the site answers nothing at all (see "What a person sees").

This page gives the NAMES of the settings. It never gives a value, and no value should ever be written here.

---

## 1. The two settings

Set them where your host keeps the server's settings (on Replit: the project's Secrets, and check that the published
app gets them too). Never put them in a file inside the project folder, in an e-mail or in a chat.

| Name | What it is | Rule |
|---|---|---|
| `APP_PASSWORD` | The company password that people type on the sign-in page. | At least 12 characters. |
| `SESSION_SECRET` | The secret the server signs with. The app already uses it to lock the Gmail link. | At least 16 characters. **If it is already set, leave it alone.** |

After you add or change a setting, restart the server (on Replit: publish again) so it picks the change up.

### Choosing `APP_PASSWORD`

- Four or five unrelated words, or 20 or more characters from a password manager.
- Not the company name, the street, a phone number or a year. Not a password used anywhere else.
- Spaces inside it are fine. Spaces at the very start or end are ignored.
- Shorter than 12 characters counts as "not set": the site stays closed and says so.

### About `SESSION_SECRET`

- If Gmail has ever been connected, this is already set. Do not change it: changing it cuts the Gmail link (someone
  must press Connect Gmail again with the mailbox's Google account) and signs everyone out.
- Only if the site says it is missing: make a long random value (40 or more characters from a password manager), set
  it, restart, then reconnect Gmail on the Settings page.

---

## 2. Check that it worked (two minutes)

1. Open the site **in its own browser tab**. You should see "Sign in".
2. Type a wrong password. It should say "Wrong password."
3. Type the right one. The job list opens, with "Sign out" at the top right.
4. In a private window (so you are not signed in), open `<your address>/api/jobs`. It must say `Sign in first`. If it
   shows jobs, stop and do not share the address.
5. Open `<your address>/api/healthz`. It should say `{"status":"ok"}`. This one address is open on purpose: the host
   uses it to see that the server is alive. It says nothing else.

---

## 3. Giving people the password

- Tell them by phone or in person, or share it from a password manager. Not by e-mail or text.
- Each person types it once per browser. They stay signed in for 7 days after they last used the site, and for 30
  days at the most. Then the site asks again.
- "Sign out" (top right) signs out that one browser. Use it on a computer that other people use.

## 4. Changing the password

Change the value of `APP_PASSWORD` and restart the server. That is all.

- **Everyone is signed out at once** and needs the new password.
- Anything typed into an open page and not yet saved is lost at that moment. Tell people to save first.
- Do it when someone leaves the company, when a laptop or phone is lost, or whenever you are not sure who knows it.

## 5. Signing everyone out

There is no separate button. **Changing the password is how you sign everyone out.** It ends every session
everywhere, including on a lost or stolen device.

"Sign out" only makes one browser forget its sign-in. It does not reach a copy of that sign-in taken from the
device beforehand. If a device may be in the wrong hands, change the password.

---

## 6. What a person sees

| On screen | What it means | What to do |
|---|---|---|
| **"This site is not set up yet"**, with the name of a setting | `APP_PASSWORD` or `SESSION_SECRET` is missing or too short on the server. The site is closed to everyone, signed in or not. | Owner: set it (section 1), restart, press "Check again". |
| **"Wrong password."** | A typing mistake. | Try again. |
| **"Wrong password. Wait 30 seconds..."** | Five wrong passwords in a row from the same place. Each further wrong one doubles the wait, up to 15 minutes. | Wait for the button to come back. The right password clears the count. |
| **"Sign-in is paused for a moment..."** | Many wrong passwords from many places: someone is guessing. Sign-in pauses for everyone for a few seconds at a time. People already signed in are not affected. | Try again in a few seconds. If it keeps happening for hours, tell your developer. |
| **"The password is right, but this browser did not keep the sign-in."** | The site is being shown inside another page (Replit's small preview pane does this), or cookies are switched off. | Open the site in its own tab. Allow cookies for it. |
| **"You have been signed out."** | 7 days without use, 30 days since the password was typed, or the owner changed the password. | Sign in again. |
| **"Slow down: the AI buttons are limited"** | "Extract Specs" and the price-sheet reader cost money on every press. Together they can be pressed 3 times a minute and 20 times an hour, for the whole company. | Wait the time shown. |

Connecting Gmail works as before, with one more condition: the browser that Google sends back must be signed in to
PanelBid. If it is not, nothing is connected and the sign-in page comes up.

---

## 7. What this does NOT do yet

So that nobody assumes more than there is:

- **One password for everyone.** There are no separate accounts, so the site cannot tell who did what, and one
  person cannot be removed without changing the password for all.
- **No "forgot my password".** The owner changes it on the host.
- **No roles.** Everyone who is signed in can do everything, including deleting jobs and disconnecting Gmail.
- **No record of sign-ins** other than lines in the server log (time and address, never the password).
- **The counts for wrong passwords and AI presses live in the server's memory.** A restart forgets them, and if the
  host ever runs two copies of the server, each keeps its own count.
- **Someone who keeps guessing from many places can keep the sign-in page paused** for a while. They still cannot
  get in, and people already signed in keep working.

Next steps, in this order: an account per person, a password reset, roles.

---

## 8. For a developer

- The gate: `artifacts/api-server/src/middlewares/apiGate.ts`. It is mounted first under `/api` in
  `artifacts/api-server/src/app.ts`. The pieces: `src/lib/auth.ts` (settings, password check, signed cookie) and
  `src/lib/rateLimit.ts` (the two limits). The page's side: `artifacts/panelbid/src/auth.tsx`.
- **Never register a route on `app` itself, outside `/api`, or in front of the gate.** `src/apiGuard.test.ts` reads
  the route list from Express and fails if any route answers without a session, or if anything new is mounted on
  the app. Changing its short "open" list is a decision about who can reach the client's data.
- Tests need no database and no outside service:
  `pnpm --filter @workspace/api-server exec vitest run src/apiGuard.test.ts src/signIn.test.ts src/lib/auth.test.ts src/lib/rateLimit.test.ts src/lib/gmailLogging.test.ts`
- Open without a session: `GET /api/healthz` and `POST /api/auth/sign-in`. Nothing else. Google's return address
  (`GET /api/gmail/oauth/callback`) needs the session cookie and the one-time signed state; without a session it
  redirects to the page and never uses the code Google sent.
- There is no CORS on purpose. A request that changes something must carry this site's own `Origin` (or
  `Sec-Fetch-Site: same-origin`). The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` whenever `NODE_ENV` is
  `production` or the request came over https.
- The address used for the "five wrong passwords" count is the first entry of `X-Forwarded-For`, else the
  connection's address. A caller can fake that header, which is why there is also one budget for the whole site
  (30 wrong passwords at once, then 3 a minute). If the host is known to put the real address in a fixed place,
  reading it from there would make the per-address count strict.
- Signing key for the cookie: made from `SESSION_SECRET` and `APP_PASSWORD` together, so a new password ends every
  session and `SESSION_SECRET` (which also locks the Gmail tokens) never has to change.
