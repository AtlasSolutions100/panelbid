/**
 * The two public pages: Privacy and Terms.
 *
 * Anyone can read them without signing in (Google asks for both links before
 * a mailbox can be connected), so they sit OUTSIDE the sign-in gate in
 * App.tsx and make no call to the server.
 *
 * Every sentence about data here describes what the code does today. When
 * the code changes what it reads, keeps or sends, change this page with it.
 */
import type { ReactNode } from "react"
import { Building2 } from "lucide-react"
import { CONTACT_EMAIL, LEGAL_UPDATED, OPERATOR_NAME } from "@/lib/operator"

const BASE = import.meta.env.BASE_URL

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-3xl px-4 py-4 flex items-center justify-between">
          <a href={BASE} className="flex items-center gap-2 font-bold text-lg tracking-tight text-primary">
            <Building2 className="h-5 w-5" />
            PanelBid
          </a>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href={`${BASE}privacy`} className="hover:text-foreground" data-testid="link-privacy">
              Privacy
            </a>
            <a href={`${BASE}terms`} className="hover:text-foreground" data-testid="link-terms">
              Terms
            </a>
            <a href={BASE} className="hover:text-foreground" data-testid="link-sign-in">
              Sign in
            </a>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="legal-title">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated {LEGAL_UPDATED}</p>
        <div className="space-y-8 text-[15px] leading-relaxed">{children}</div>
      </main>
    </div>
  )
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">{heading}</h2>
      <div className="space-y-3 text-foreground/90">{children}</div>
    </section>
  )
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc pl-5 space-y-1.5">{children}</ul>
}

function Contact() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary underline underline-offset-2">
      {CONTACT_EMAIL}
    </a>
  )
}

export function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <Section heading="Who we are">
        <p>
          PanelBid is a private web app run by {OPERATOR_NAME} ("we", "us") for a wall-panel contractor
          ("the customer"). The customer's staff use it to collect invitations to bid, read plans, build
          takeoffs and write proposals. Only people with the customer's sign-in can use it.
        </p>
        <p>
          Questions about this page, or a request to see or delete data: <Contact />.
        </p>
      </Section>

      <Section heading="What we collect">
        <Bullets>
          <li>
            <strong>Files you upload:</strong> plan sets and price sheets (PDF).
          </li>
          <li>
            <strong>What you type:</strong> jobs, rooms, wall lengths, prices, proposals, your keyword list
            and your contractor list.
          </li>
          <li>
            <strong>Sign-in:</strong> a sign-in cookie in your browser. The cookie holds no password.
          </li>
          <li>
            <strong>Gmail, only if the customer connects a mailbox:</strong> see the next section.
          </li>
          <li>
            <strong>Technical records:</strong> times, counts, job numbers and error messages, so we can fix
            problems. These records do not hold the text of e-mails.
          </li>
        </Bullets>
      </Section>

      <Section heading="Gmail: what we read and what we keep">
        <p>
          Connecting Gmail is optional. When the customer connects a mailbox, PanelBid asks Google for{" "}
          <strong>read-only</strong> access. It cannot send, change or delete mail.
        </p>
        <p>
          <strong>What it reads:</strong> new messages in the inbox since its last check: who sent each one,
          the subject, the date, the message text, and PDF attachments.
        </p>
        <p>
          <strong>What it does with them:</strong> it looks for invitations to bid. It skips messages that
          match the customer's own skip list (for example invoices and newsletters). It saves PDF plans from
          attachments and from plan links in the message, and it opens a job for them. It uses the message
          text only to find a job address and links to plans.
        </p>
        <p>
          <strong>What it keeps:</strong> for each message it looked at, Google's ID number for the message,
          the sender, the subject, the date and what was done with it (including which contractor on the
          customer's list it matched); the plan PDFs; the job name and address it found; and the address of
          the connected mailbox. The keys Google gives us for the mailbox are stored encrypted.
        </p>
        <p>
          <strong>What it does not keep:</strong> the text of the messages.
        </p>
      </Section>

      <Section heading="How we use it">
        <Bullets>
          <li>To run PanelBid for the customer: find bid invitations, read plans, build takeoffs and proposals.</li>
          <li>To fix problems and keep the service secure.</li>
        </Bullets>
        <p>
          We do not sell this information. We do not use it for advertising. We do not use it to train AI
          models. Our own staff look at a customer's data only to support that customer, to keep the service
          secure, or when the law requires it.
        </p>
      </Section>

      <Section heading="AI reading of plans">
        <p>
          When a person presses the button to read rooms from a plan or prices from a price sheet, the
          pages are sent as pictures to an AI service (Anthropic's Claude, reached through our host,
          Replit) so they can be read. The answer comes back as a list of rooms or prices for the person to
          check. This includes plans that arrived by e-mail. The text of e-mails is not sent to the AI
          service.
        </p>
      </Section>

      <Section heading="Information from Google">
        <p>
          PanelBid's use of information received from Google APIs, and any transfer of it to another app,
          follows the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="text-primary underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including its Limited Use requirements. We use Gmail data only to provide the bid-intake feature
          described above, for the customer who connected the mailbox.
        </p>
      </Section>

      <Section heading="Who else handles it">
        <p>We use these companies to run the service. They handle the data only to do that job for us.</p>
        <Bullets>
          <li>
            <strong>Replit:</strong> hosts the app and its database.
          </li>
          <li>
            <strong>Google:</strong> Gmail, when the customer connects a mailbox.
          </li>
          <li>
            <strong>Anthropic, through Replit:</strong> reads plan and price-sheet pages when a person asks.
          </li>
        </Bullets>
        <p>We share it with no one else, unless the law requires it.</p>
      </Section>

      <Section heading="How it is protected">
        <Bullets>
          <li>The connection to the site is encrypted (HTTPS).</li>
          <li>Nothing can be read without signing in.</li>
          <li>The keys for a connected mailbox are stored encrypted.</li>
        </Bullets>
      </Section>

      <Section heading="Keeping and deleting">
        <Bullets>
          <li>We keep the customer's data until the customer deletes it or asks us to.</li>
          <li>Deleting a job deletes its plans.</li>
          <li>
            <strong>Disconnect Gmail</strong> (in Settings) removes the stored keys and asks Google to end
            the access. The customer can also end it from their Google Account, under third-party access.
          </li>
          <li>
            To have everything deleted, write to <Contact />.
          </li>
        </Bullets>
      </Section>

      <Section heading="Children">
        <p>PanelBid is a business tool. It is not meant for children.</p>
      </Section>

      <Section heading="Changes to this page">
        <p>If what we collect or how we use it changes, we will update this page and the date at the top.</p>
      </Section>
    </LegalPage>
  )
}

export function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <Section heading="What this is">
        <p>
          PanelBid is a private web app run by {OPERATOR_NAME} ("we", "us") for a wall-panel contractor
          ("the customer"). These terms cover the use of this site by the customer and its staff ("you").
          If the customer has a written agreement with us, that agreement comes first where the two differ.
        </p>
      </Section>

      <Section heading="Your sign-in">
        <p>
          Keep the sign-in private and share it only with your own staff. You are responsible for what is
          done with it. Tell us right away if you think someone else has it.
        </p>
      </Section>

      <Section heading="Your content">
        <p>
          Your plans, lists, takeoffs and proposals stay yours. You let us store and process them so the
          service can work, as the Privacy Policy describes. Upload only material you have the right to use.
        </p>
      </Section>

      <Section heading="Connecting Gmail">
        <p>
          Connecting a mailbox is optional. The access is read-only, and you can end it at any time in
          Settings or from your Google Account.
        </p>
      </Section>

      <Section heading="Check every number">
        <p>
          PanelBid reads plans and suggests rooms, sheet counts, material quantities and prices. Some of
          that reading is done by AI. It can be wrong or incomplete. Check every takeoff and every proposal
          against the plans before you send it. You are responsible for your bids.
        </p>
      </Section>

      <Section heading="Fair use">
        <p>
          Do not use the service to break the law, to get into data that is not yours, or in a way that
          could harm or overload it.
        </p>
      </Section>

      <Section heading="Changes and availability">
        <p>
          We work to keep PanelBid running, and we improve it often. It may change, and it may be
          unavailable at times. It is provided as it is, without a promise that it is free of errors.
        </p>
      </Section>

      <Section heading="Ending">
        <p>
          You can stop using PanelBid at any time, and we can end access if these terms are not followed.
          On request we delete your data, as the Privacy Policy describes.
        </p>
      </Section>

      <Section heading="Changes to these terms">
        <p>If these terms change, we will update this page and the date at the top.</p>
      </Section>

      <Section heading="Contact">
        <p>
          <Contact />
        </p>
      </Section>
    </LegalPage>
  )
}
