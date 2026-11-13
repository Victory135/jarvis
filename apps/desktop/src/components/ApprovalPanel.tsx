// Shows the exact proposed action, target and risk, with Confirm / Cancel (blueprint V2.4 ApprovalPanel).
export type ApprovalRequest = { action: string; target: string; risk: 'low' | 'medium' | 'high'; detail?: string }

export function ApprovalPanel({ request, preview = false, onConfirm, onCancel }: {
  request: ApprovalRequest
  preview?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="approval" role="alertdialog" aria-labelledby="approval-title">
      <h3 id="approval-title">APPROVAL REQUIRED{preview ? ' · PREVIEW EXAMPLE' : ''}</h3>
      <dl className="kv" style={{ margin: 0 }}>
        <dt>ACTION</dt><dd>{request.action}</dd>
        <dt>TARGET</dt><dd title={request.target}>{request.target}</dd>
        <dt>RISK</dt><dd style={{ color: request.risk === 'high' ? 'var(--hud-red)' : 'var(--hud-amber)' }}>{request.risk.toUpperCase()}</dd>
      </dl>
      {request.detail && <p className="note" style={{ margin: '8px 0 0' }}>{request.detail}</p>}
      <div className="btns">
        <button type="button" className="btn" onClick={onCancel}>CANCEL</button>
        <button type="button" className="btn amber" onClick={onConfirm}>CONFIRM</button>
      </div>
    </div>
  )
}
