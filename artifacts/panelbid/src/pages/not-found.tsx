import { Layout } from "@/components/layout"

export default function NotFound() {
  return (
    <Layout>
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center">
        <h1 className="text-4xl font-bold font-mono text-primary tracking-tighter mb-4">404</h1>
        <h2 className="text-xl font-semibold mb-2">Page Not Found</h2>
        <p className="text-muted-foreground max-w-md">
          The requested page could not be found. Check the URL or return to the dashboard.
        </p>
      </div>
    </Layout>
  )
}
