// @orca-managed-pi-extension
export default function (pi) {
  pi.on('session_start', async (event, ctx) => {
    if (!process.env.ORCA_PANE_KEY || ctx?.hasUI === false) return
    if (event.reason !== 'startup') return
    const prefill = process.env.ORCA_PI_PREFILL
    if (!prefill || typeof ctx?.ui?.setEditorText !== 'function') return
    delete process.env.ORCA_PI_PREFILL
    try {
      ctx.ui.setEditorText(prefill)
    } catch {}
  })
}
