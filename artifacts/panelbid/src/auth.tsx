/**
 * The page's side of the sign-in.
 *
 * - <AuthGate> asks the server whether this browser is signed in and shows
 *   the app, the sign-in page, or the "not set up" page.
 * - Every call the page makes to /api is watched (one small wrapper around
 *   fetch, so no screen has to remember to do it). When the server says
 *   "sign in first", the app is taken off the screen and its loaded data is
 *   dropped; the person lands on the sign-in page.
 * - The session lives in an http-only cookie: this code never sees it and
 *   never keeps the password.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Building2, Loader2, Lock, LogOut, ServerOff, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "@/hooks/use-toast"

const API = `${import.meta.env.BASE_URL}api`

type AuthState =
  | { kind: "checking" }
  | { kind: "signed-in" }
  | { kind: "signed-out"; notice?: string }
  | { kind: "not-set-up"; missing: string[] }
  | { kind: "unreachable" }

interface ServerSays {
  code?: string
  message?: string
  missing?: unknown
  retryAfterSeconds?: unknown
}

async function readJson(response: Response): Promise<ServerSays> {
  try {
    const data: unknown = await response.json()
    return data && typeof data === "object" ? (data as ServerSays) : {}
  } catch {
    return {}
  }
}

function missingNames(says: ServerSays): string[] {
  return Array.isArray(says.missing)
    ? says.missing.filter((name): name is string => typeof name === "string")
    : []
}

// ---------------------------------------------------------------------------
// Watching every /api call
// ---------------------------------------------------------------------------

type Listener = (state: AuthState) => void
const listeners = new Set<Listener>()

function tell(state: AuthState): void {
  for (const listener of listeners) listener(state)
}

function isApiCall(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, window.location.href)
    return url.origin === window.location.origin && url.pathname.startsWith(`${API}/`)
  } catch {
    return false
  }
}

let watching = false

/**
 * Wrap fetch once. The reply is handed back untouched; for the three
 * answers below a copy of it is read to see what the server said.
 */
function watchApiCalls(): void {
  if (watching) return
  watching = true
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(input, init)
    if ([401, 429, 503].includes(response.status) && isApiCall(input)) {
      void readJson(response.clone()).then((says) => {
        if (response.status === 401 && says.code === "sign_in_required") {
          tell({ kind: "signed-out", notice: "You have been signed out. Sign in again to carry on." })
        } else if (response.status === 503 && says.code === "not_configured") {
          tell({ kind: "not-set-up", missing: missingNames(says) })
        } else if (response.status === 429 && says.code === "ai_limit") {
          // A moment later, so this is the message that stays on screen.
          window.setTimeout(() => {
            toast({
              title: "Slow down: the AI buttons are limited",
              description: says.message ?? "Try again in a minute.",
              variant: "destructive",
            })
          }, 150)
        }
      })
    }
    return response
  }) as typeof window.fetch
}

async function askServer(): Promise<AuthState> {
  try {
    const response = await fetch(`${API}/auth/session`, { headers: { accept: "application/json" } })
    if (response.ok) return { kind: "signed-in" }
    const says = await readJson(response)
    if (response.status === 503 && says.code === "not_configured") {
      return { kind: "not-set-up", missing: missingNames(says) }
    }
    if (response.status === 401) return { kind: "signed-out" }
    return { kind: "unreachable" }
  } catch {
    return { kind: "unreachable" }
  }
}

/** Sign this browser out, then load the page afresh so nothing stays in memory. */
export async function signOut(): Promise<void> {
  try {
    const response = await fetch(`${API}/auth/sign-out`, { method: "POST" })
    if (!response.ok && response.status !== 401) throw new Error("sign-out refused")
  } catch {
    toast({
      title: "Could not sign out",
      description: "The server did not answer. Check your connection and try again.",
      variant: "destructive",
    })
    return
  }
  window.location.assign(import.meta.env.BASE_URL)
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

interface AuthGateProps {
  children: ReactNode
  /** Called when the session ends, so loaded data can be dropped. */
  onSignedOut: () => void
}

export function AuthGate({ children, onSignedOut }: AuthGateProps) {
  const [state, setState] = useState<AuthState>({ kind: "checking" })
  const wasSignedIn = useRef(false)

  useEffect(() => {
    watchApiCalls()
    const listener: Listener = (next) => {
      setState((current) => {
        if (next.kind !== "signed-out") return next
        // "You have been signed out" is only true for someone who was in.
        if (current.kind === "signed-in") return next
        // While the sign-in page is up, late answers to old calls must not
        // wipe what it is showing.
        if (current.kind === "signed-out") return current
        return { kind: "signed-out" }
      })
    }
    listeners.add(listener)
    void askServer().then(setState)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (state.kind === "signed-in") {
      wasSignedIn.current = true
    } else if (wasSignedIn.current && state.kind !== "checking") {
      wasSignedIn.current = false
      onSignedOut()
    }
  }, [state, onSignedOut])

  const checkAgain = () => {
    setState({ kind: "checking" })
    void askServer().then(setState)
  }

  switch (state.kind) {
    case "signed-in":
      return <>{children}</>
    case "checking":
      return (
        <Frame>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-10">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking…
          </div>
        </Frame>
      )
    case "not-set-up":
      return <NotSetUp missing={state.missing} onCheckAgain={checkAgain} />
    case "unreachable":
      return <Unreachable onCheckAgain={checkAgain} />
    case "signed-out":
      return (
        <SignIn
          notice={state.notice}
          onSignedIn={() => setState({ kind: "signed-in" })}
          onNotSetUp={(missing) => setState({ kind: "not-set-up", missing })}
        />
      )
  }
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="flex items-center gap-2 font-bold text-xl tracking-tight text-primary mb-6">
        <Building2 className="h-6 w-6" />
        PanelBid
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The sign-in page
// ---------------------------------------------------------------------------

interface SignInProps {
  notice?: string
  onSignedIn: () => void
  onNotSetUp: (missing: string[]) => void
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`
  return `${Math.ceil(seconds / 60)} minutes`
}

function SignIn({ notice, onSignedIn, onNotSetUp }: SignInProps) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const inputRef = useRef<HTMLInputElement>(null)

  const waitSeconds = Math.max(0, Math.ceil((waitUntil - now) / 1000))

  // Count the wait down on screen.
  useEffect(() => {
    if (waitUntil <= Date.now()) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [waitUntil])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || waitSeconds > 0) return
    if (password.trim() === "") {
      setError("Type the password.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${API}/auth/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ password }),
      })
      if (response.ok) {
        setPassword("")
        onSignedIn()
        return
      }
      const says = await readJson(response)
      if (response.status === 503 && says.code === "not_configured") {
        onNotSetUp(missingNames(says))
        return
      }
      const wait = typeof says.retryAfterSeconds === "number" ? says.retryAfterSeconds : 0
      if (wait > 0) {
        setNow(Date.now())
        setWaitUntil(Date.now() + wait * 1000)
      }
      if (response.status === 401) {
        setError("Wrong password.")
      } else if (response.status === 429) {
        setError("Too many wrong passwords.")
      } else {
        setError(says.message ?? "Sign-in did not work. Try again.")
      }
      inputRef.current?.select()
    } catch {
      setError("The server did not answer. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame>
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Lock className="h-5 w-5 text-muted-foreground" />
            Sign in
          </CardTitle>
          <CardDescription>Type the company password to open PanelBid.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" data-testid="sign-in-form">
            {notice && !error && (
              <p className="text-sm text-muted-foreground" data-testid="sign-in-notice">
                {notice}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="company-password">Password</Label>
              <Input
                id="company-password"
                ref={inputRef}
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "sign-in-error" : undefined}
              />
            </div>
            {error && (
              <p id="sign-in-error" role="alert" className="text-sm font-medium text-destructive" data-testid="sign-in-error">
                {error}
                {waitSeconds > 0 && ` Wait ${waitText(waitSeconds)}, then try again.`}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy || waitSeconds > 0}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Signing in…
                </>
              ) : waitSeconds > 0 ? (
                `Wait ${waitText(waitSeconds)}`
              ) : (
                "Sign in"
              )}
            </Button>
            <p className="text-xs text-muted-foreground">Forgot the password? Ask the owner.</p>
          </form>
        </CardContent>
      </Card>
    </Frame>
  )
}

// ---------------------------------------------------------------------------
// "Not set up" and "cannot reach the server"
// ---------------------------------------------------------------------------

const SETTING_HELP: Record<string, string> = {
  APP_PASSWORD: "the company password, at least 12 characters",
  SESSION_SECRET: "the signing secret the app already uses, at least 16 characters",
}

function NotSetUp({ missing, onCheckAgain }: { missing: string[]; onCheckAgain: () => void }) {
  return (
    <Frame>
      <Card className="shadow-sm" data-testid="not-set-up">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Wrench className="h-5 w-5 text-muted-foreground" />
            This site is not set up yet
          </CardTitle>
          <CardDescription>
            Nobody can sign in until the owner finishes the set-up. Until then the site answers nothing: no jobs, no
            plans, no customer list.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-medium">For the owner</p>
            <p className="text-muted-foreground">
              {missing.length === 1 ? "One setting is" : "These settings are"} missing or too short on the server:
            </p>
            <ul className="mt-2 space-y-1">
              {(missing.length > 0 ? missing : ["APP_PASSWORD", "SESSION_SECRET"]).map((name) => (
                <li key={name}>
                  <code className="font-mono font-semibold">{name}</code>
                  {SETTING_HELP[name] && <span className="text-muted-foreground"> ({SETTING_HELP[name]})</span>}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-2">
              Add it where the server keeps its settings, restart the server, then press Check again. The steps are in
              SIGNIN-SETUP.md.
            </p>
          </div>
          <Button variant="outline" className="w-full" onClick={onCheckAgain}>
            Check again
          </Button>
        </CardContent>
      </Card>
    </Frame>
  )
}

function Unreachable({ onCheckAgain }: { onCheckAgain: () => void }) {
  return (
    <Frame>
      <Card className="shadow-sm" data-testid="server-unreachable">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <ServerOff className="h-5 w-5 text-muted-foreground" />
            The server did not answer
          </CardTitle>
          <CardDescription>
            It may be starting up, or your connection dropped. Nothing is wrong with your password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={onCheckAgain}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </Frame>
  )
}

/** The Sign out button for the header. */
export function SignOutButton() {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void signOut().finally(() => setBusy(false))
      }}
      data-testid="sign-out"
    >
      <LogOut className="mr-2 h-4 w-4" />
      Sign out
    </Button>
  )
}
