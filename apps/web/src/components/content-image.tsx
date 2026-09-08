import { useState, type ComponentProps } from 'react'
import { ImageOff } from 'lucide-react'
import { uiT, useUiLanguage } from '../lib/i18n.ts'

/** Keep the image's slot and its host action usable when a local image cannot load. */
export function ContentImage(props: ComponentProps<'img'>) {
  return <ImageSource key={props.src} {...props} />
}

function ImageSource({ src, alt = '', className = '', onError, ...props }: ComponentProps<'img'>) {
  useUiLanguage()
  const [failedSource, setFailedSource] = useState<string>()
  const classes = `content-image ${className}`
  if (!src || failedSource === src) {
    const label = alt ? uiT('%{name} · 图片未能加载', { name: alt }) : uiT('图片未能加载')
    return <span className={`${classes} image-unavailable`} role="img" aria-label={label} title={label} style={props.style}><ImageOff size={20} aria-hidden="true" /></span>
  }
  return <img {...props} src={src} alt={alt} className={classes} onError={event => { setFailedSource(src); onError?.(event) }} />
}
