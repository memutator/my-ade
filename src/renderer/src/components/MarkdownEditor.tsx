import { useEffect, useRef } from 'react'
import { commandsCtx, Editor, defaultValueCtx, rootCtx } from '@milkdown/kit/core'
import {
  listItemBlockComponent,
  listItemBlockConfig
} from '@milkdown/kit/component/list-item-block'
import {
  configureLinkTooltip,
  linkTooltipConfig,
  linkTooltipPlugin,
  toggleLinkCommand
} from '@milkdown/kit/component/link-tooltip'
import { commonmark, linkSchema } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history } from '@milkdown/kit/plugin/history'
import { indent } from '@milkdown/kit/plugin/indent'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { $prose, $useKeymap } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { useT } from '../i18n'
import { useStore } from '../store'
import { isDetachedWin, detachedWsId, detachedPaneId } from '../detached'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/gapcursor/style/gapcursor.css'
import '@milkdown/kit/prose/tables/style/tables.css'

// Ctrl/Cmd+K toggles a link on the selection — opens the edit tooltip input
const linkKeymap = $useKeymap('adeLink', {
  ToggleLink: {
    shortcuts: 'Mod-k',
    command: (ctx) => (): boolean => {
      void ctx.get(commandsCtx).call(toggleLinkCommand.key)
      return true
    }
  }
})

// links open ADE-first — an in-app browser pane (the tooltip's window.open
// is bounced back by the main process as 'open-url' and lands the same way;
// a detached editor relays through pane:cmd since only the main store owns
// workspaces). A plain click just moves the caret.
function openLink(href: string): void {
  if (isDetachedWin && detachedWsId && detachedPaneId) {
    window.ade.win.paneCmd({
      action: 'openUrl',
      wsId: detachedWsId,
      paneId: detachedPaneId,
      url: href
    })
  } else {
    useStore.getState().openUrlInBrowser(href)
  }
}

const linkOpenPlugin = $prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey('ade-link-open'),
      props: {
        handleDOMEvents: {
          click: (view, event) => {
            if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
            if (!coords) return false
            const href = view.state.doc
              .nodeAt(coords.pos)
              ?.marks.find((m) => m.type === linkSchema.mark.type(ctx))?.attrs.href
            if (typeof href !== 'string' || !href || !/^https?:\/\//.test(href)) return false
            event.preventDefault()
            openLink(href)
            return true
          }
        }
      }
    })
)

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
  const t = useT()
  const tRef = useRef(t)

  useEffect(() => {
    onChangeRef.current = onChange
    tRef.current = t
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
        // task items get a real box glyph instead of the default ☑/□ text
        ctx.update(listItemBlockConfig.key, (prev) => ({
          ...prev,
          renderLabel: ({ label, listType, checked }) => {
            if (checked == null) return listType === 'bullet' ? '•' : label
            return `<span class="taskbox${checked ? ' checked' : ''}">${checked ? '✓' : ''}</span>`
          }
        }))
        ctx.update(linkTooltipConfig.key, () => ({
          linkIcon: '⧉',
          editButton: '✎',
          removeButton: '✕',
          confirmButton: '✓',
          onCopyLink: () => {},
          inputPlaceholder: tRef.current('linkPlaceholder')
        }))
        configureLinkTooltip(ctx)
      })
      .use(commonmark)
      .use(gfm)
      .use(listItemBlockComponent)
      .use(linkTooltipPlugin)
      .use(linkKeymap)
      .use(linkOpenPlugin)
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
