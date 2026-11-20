// The quick search panel (⇧⌘Space, over whatever's in front): type, move with the arrows, Enter
// copies the password, ⌘C the username, ⇧⌘C the code; Esc closes. It unlocks first if it must.
import { useForm, useSelector } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useEffectEvent, useRef, useState } from "react"

import type { ShownItem } from "../../shared/rpc.ts"
import { ask, useBridge } from "../bridge.ts"
import { detailOf, listed, mainOf, totpOf, usernameField } from "../listing.ts"
import { copyMutation, copyTextMutation, unlockMutation } from "../mutations.ts"
import { useForgetWhenLocked } from "../forget.ts"
import { itemsQuery, statusQuery } from "../queries.ts"
import { Stop } from "./marks.tsx"
import { Caps, Key } from "./parts.tsx"

const close = () => {
  void ask.panelClose({})
}

type What = "password" | "username" | "code"

const Locked = () => {
  const unlock = useMutation(unlockMutation)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-paper">
      <Key
        go
        autoFocus
        disabled={unlock.isPending}
        onClick={() => {
          unlock.mutate()
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            close()
          }
        }}
        className="h-9 px-5 text-ui"
      >
        Unlock
      </Key>
      {unlock.error && (
        <span className="flex items-center gap-2 text-small text-ink">
          <Stop size={12} />
          {unlock.error.message}
        </span>
      )}
    </div>
  )
}

const Search = () => {
  const { data: all = [] } = useQuery(itemsQuery)
  const form = useForm({ defaultValues: { query: "" } })
  const query = useSelector(form.store, (s) => s.values.query)
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const copy = useMutation(copyMutation)
  const copyText = useMutation(copyTextMutation)
  const hits = listed(all, "all", query).toSorted((a, b) => Number(b.favorite) - Number(a.favorite))
  const chosen: ShownItem | undefined = hits[Math.min(at, hits.length - 1)]
  const rows = useVirtualizer({
    count: hits.length,
    getScrollElement: () => viewport,
    estimateSize: () => 36,
    getItemKey: (i) => hits[i]?.id ?? i,
    overscan: 8,
  })
  const lastCopy = useRef(0)
  const failed = copy.error ?? copyText.error

  const take = (what: What) => {
    if (!chosen) {
      return
    }
    lastCopy.current = Date.now()
    const done = { onSuccess: close }
    if (what === "username") {
      const f = usernameField(chosen)
      if (f) {
        copyText.mutate(f.value, done)
      }
      return
    }
    const f = what === "code" ? totpOf(chosen) : mainOf(chosen)
    if (f) {
      copy.mutate({ id: chosen.id, field: f.id }, done)
    }
  }

  useBridge(
    (c) => {
      if (c.kind === "panel") {
        form.setFieldValue("query", "")
        setAt(0)
        copy.reset()
        copyText.reset()
        input.current?.focus()
      }
    },
    () => ({ page: "panel", item: null, query, listed: hits.length, locked: false }),
  )

  // ⌘C may reach the page as the menu's Copy rather than a key: take it as the username too.
  const onCopy = useEffectEvent((e: ClipboardEvent) => {
    e.preventDefault()
    if (Date.now() - lastCopy.current > 200) {
      take("username")
    }
  })
  useEffect(() => {
    const l = (e: ClipboardEvent) => {
      onCopy(e)
    }
    document.addEventListener("copy", l)
    return () => {
      document.removeEventListener("copy", l)
    }
  }, [])

  return (
    <>
      <form.Field name="query">
        {(field) => (
          <input
            ref={input}
            type="search"
            aria-label="Search"
            placeholder="Search"
            autoFocus
            value={field.state.value}
            onChange={(e) => {
              field.handleChange(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const next = Math.min(
                  hits.length - 1,
                  Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)),
                )
                setAt(next)
                rows.scrollToIndex(next)
              } else if (e.key === "Enter") {
                e.preventDefault()
                take("password")
              } else if (e.key === "Escape") {
                e.preventDefault()
                close()
              } else if (e.metaKey && e.key.toLowerCase() === "c") {
                e.preventDefault()
                take(e.shiftKey ? "code" : "username")
              }
            }}
            className="selectable h-[52px] w-full flex-none border-0 bg-paper px-inset text-[18px] text-ink outline-none hairline-b [&::-webkit-search-cancel-button]:hidden"
          />
        )}
      </form.Field>
      <div ref={setViewport} className="min-h-0 flex-1 overflow-y-auto bg-paper" aria-label="Items">
        {hits.length === 0 && (
          <p className="m-0 flex h-line items-center px-inset text-ui text-ink3">Nothing</p>
        )}
        <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
          {rows.getVirtualItems().map((row) => {
            const item = hits[row.index]
            if (!item) {
              return null
            }
            return (
              <button
                key={row.key}
                type="button"
                tabIndex={-1}
                style={{ transform: `translateY(${row.start}px)`, height: row.size }}
                onMouseDown={(e) => {
                  e.preventDefault()
                }}
                onClick={() => {
                  setAt(row.index)
                }}
                onDoubleClick={() => {
                  take("password")
                }}
                className={`absolute top-0 left-0 flex w-full items-center gap-2.5 px-inset text-left text-ui text-ink outline-none hairline-b hover:bg-wash ${item.id === chosen?.id ? "bg-selection" : "bg-transparent"}`}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="max-w-[45%] flex-none truncate pl-3 font-mono text-data text-ink3">
                  {detailOf(item)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <footer className="flex h-line flex-none items-center gap-4 bg-paper px-inset text-small text-ink2 rule-t">
        {failed ? (
          <span className="flex min-w-0 items-center gap-2 text-ink">
            <Stop size={12} />
            <span className="truncate">{failed.message}</span>
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <Caps>↵</Caps>Password
            </span>
            <span className="flex items-center gap-1.5">
              <Caps>⌘C</Caps>Username
            </span>
            <span className="flex items-center gap-1.5">
              <Caps>⇧⌘C</Caps>Code
            </span>
          </>
        )}
      </footer>
    </>
  )
}

export const Panel = () => {
  const { data: status } = useQuery(statusQuery)
  const open = status?.stage === "open"
  useForgetWhenLocked(open)
  return <div className="flex h-full flex-col">{open ? <Search /> : <Locked />}</div>
}
