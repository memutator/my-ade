import { useEffect, useRef } from 'react'
import { Editor, defaultValueCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history } from '@milkdown/kit/plugin/history'
import { indent } from '@milkdown/kit/plugin/indent'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/gapcursor/style/gapcursor.css'
import '@milkdown/kit/prose/tables/style/tables.css'

// Obsidian-style single-surface markdown editor (Milkdown/ProseMirror WYSIWYG).
// onChange fires with the serialized markdown on every document edit.
export default function MarkdownEditor({
  initialValue,
  onChange
}: {
  initialValue: string
  onChange: (md: string) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const initialRef = useRef(initialValue)

  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, host)
        ctx.set(defaultValueCtx, initialRef.current)
        ctx.get(listenerCtx).markdownUpdated((_ctx, md, prev) => {
          if (md !== prev) onChangeRef.current(md)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(clipboard)
      .use(history)
      .use(indent)
      .use(listener)

    let alive = true
    editor.create().catch((e) => {
      if (alive) console.error('milkdown create failed', e)
    })
    return () => {
      alive = false
      editor.destroy().catch(() => {})
    }
  }, [])

  return <div className="md-editor" ref={hostRef} />
}
