import { QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// Temporal where the webview has none yet; native where it does.
import "temporal-polyfill/global"

import { App } from "./app.tsx"
import { queryClient } from "./query.ts"
import { Panel } from "./ui/panel.tsx"
import "./index.css"

/** The quick search panel loads the same page with ?panel. */
const isPanel = new URLSearchParams(location.search).has("panel")

const root = document.querySelector("#root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {isPanel ? <Panel /> : <App />}
      </QueryClientProvider>
    </StrictMode>,
  )
}
