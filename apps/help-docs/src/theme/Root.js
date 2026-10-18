import React, {useEffect, useRef, useState} from 'react';

// Enhance every documentation-content image, including Markdown and inline HTML.
// Header logos, footer assets and images outside the article are not interactive.
export default function Root({children}) {
  const dialog = useRef(null), opener = useRef(null);
  const [image, setImage] = useState(null), [natural, setNatural] = useState(false);
  const [en, setEn] = useState(false);
  useEffect(() => {
    const decorate = () => {
      const english = document.documentElement.lang.startsWith('en');
      document.querySelectorAll('.theme-doc-markdown img').forEach(img => {
        if (img.dataset.rnZoom === 'true') return;
        img.dataset.rnZoom = 'true';
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.setAttribute('aria-haspopup', 'dialog');
        img.setAttribute('aria-label', (english ? 'Enlarge image: ' : '放大图片：') + (img.alt || (english ? 'Document illustration' : '文档插图')));
        img.title = english ? 'Click to enlarge' : '点击放大';
      });
    };
    const open = (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.closest('.theme-doc-markdown')) return;
      if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();event.stopPropagation();
      opener.current = img;setNatural(false);
      setEn(document.documentElement.lang.startsWith('en'));
      setImage({src: img.currentSrc || img.src, alt: img.alt || ''});
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(document.body, {childList: true, subtree: true});
    document.addEventListener('click', open);
    document.addEventListener('keydown', open);
    return () => {observer.disconnect();document.removeEventListener('click', open);document.removeEventListener('keydown', open);};
  }, []);
  useEffect(() => {
    if (!image || !dialog.current) return;
    const node = dialog.current;
    if (!node.open) node.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {document.body.style.overflow = overflow;if (node.open) node.close();};
  }, [image]);
  const close = () => dialog.current?.close();
  return <>{children}<dialog ref={dialog} className="rn-doc-image-dialog" aria-label={en ? 'Enlarged document image' : '文档图片放大预览'} onClose={() => {setImage(null);if (opener.current?.isConnected) opener.current.focus();}} onClick={event => {if (event.target === event.currentTarget) close();}}>
    <div className="rn-doc-image-toolbar"><span>{image?.alt || (en ? 'Document illustration' : '文档插图')}</span><button type="button" onClick={() => setNatural(value => !value)}>{natural ? (en ? 'Fit to window' : '适应窗口') : (en ? 'Original size' : '查看原尺寸')}</button><button type="button" onClick={close} aria-label={en ? 'Close image preview' : '关闭图片预览'}>{en ? 'Close' : '关闭'} ×</button></div>
    <div className={'rn-doc-image-stage' + (natural ? ' rn-doc-image-natural' : '')}>{image && <img src={image.src} alt={image.alt}/>}</div>
    <p className="rn-doc-image-help">{en ? 'Use original size to read details and scroll the image. Press Esc or click outside to close.' : '查看原尺寸可滚动查看细节；按 Esc 或点击外部可关闭。'}</p>
  </dialog></>;
}
