import { useState } from 'react'
import type { BackgroundChoice } from '../../../../packages/protocol/src/backgrounds.ts'
import { backgroundUrl, useBackgrounds } from '../lib/backgrounds.ts'
import { uiT } from '../lib/i18n.ts'

export function AppBackground() {
  const backgrounds = useBackgrounds()
  return backgrounds.data?.selectedId ? <BackgroundSurface key={backgrounds.data.selectedId} value={backgrounds.data} /> : null
}

/** Only the image receives opacity. Text, controls and floating surfaces remain independent. */
export function BackgroundSurface({ value }: { value: BackgroundChoice }) {
  const [failed, setFailed] = useState(false)
  if (!value.selectedId) return null
  return <div className="background-surface">
    <img key={value.selectedId} src={backgroundUrl(value.selectedId)} alt="" aria-hidden="true" style={{ opacity: failed ? 0 : value.intensity / 100 }} onLoad={() => setFailed(false)} onError={() => setFailed(true)} />
    {failed && <span className="background-load-error" role="status">{uiT('背景图片未能加载，请在外观设置中重新选择。')}</span>}
  </div>
}
