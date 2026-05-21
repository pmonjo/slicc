let activeOverlay: HTMLElement | null = null;
let activeCleanup: (() => void) | null = null;

export function showImagePreview(src: string, originEl: HTMLElement): () => void {
  if (activeOverlay) {
    dismissImmediate();
  }

  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';

  const backdrop = document.createElement('div');
  backdrop.className = 'image-preview-backdrop';
  overlay.appendChild(backdrop);

  const img = document.createElement('img');
  img.className = 'image-preview-image';
  img.src = src;
  img.alt = 'Image preview';
  overlay.appendChild(img);

  document.body.appendChild(overlay);
  activeOverlay = overlay;

  const originRect = originEl.getBoundingClientRect();
  img.style.position = 'absolute';
  img.style.top = `${originRect.top}px`;
  img.style.left = `${originRect.left}px`;
  img.style.width = `${originRect.width}px`;
  img.style.height = `${originRect.height}px`;
  img.style.borderRadius = `${Math.min(originRect.width, originRect.height) * 0.15}px`;

  const animateOpen = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxW = vw * 0.9;
    const maxH = vh * 0.9;

    const natW = img.naturalWidth || originRect.width * 4;
    const natH = img.naturalHeight || originRect.height * 4;
    const scale = Math.min(maxW / natW, maxH / natH, 1);
    const finalW = natW * scale;
    const finalH = natH * scale;

    const finalLeft = (vw - finalW) / 2;
    const finalTop = (vh - finalH) / 2;

    img.style.top = `${finalTop}px`;
    img.style.left = `${finalLeft}px`;
    img.style.width = `${finalW}px`;
    img.style.height = `${finalH}px`;
    img.style.borderRadius = '6px';

    overlay.classList.add('image-preview-overlay--visible');
  };

  if (img.complete && img.naturalWidth > 0) {
    requestAnimationFrame(animateOpen);
  } else {
    img.onload = () => requestAnimationFrame(animateOpen);
    img.onerror = () => {
      overlay.remove();
      activeOverlay = null;
    };
  }

  const dismiss = () => {
    if (!activeOverlay || overlay !== activeOverlay) return;

    overlay.classList.add('image-preview-overlay--closing');
    overlay.classList.remove('image-preview-overlay--visible');

    const currentOriginRect = originEl.getBoundingClientRect();
    if (currentOriginRect.width > 0 && currentOriginRect.height > 0) {
      img.style.top = `${currentOriginRect.top}px`;
      img.style.left = `${currentOriginRect.left}px`;
      img.style.width = `${currentOriginRect.width}px`;
      img.style.height = `${currentOriginRect.height}px`;
      img.style.borderRadius = `${Math.min(currentOriginRect.width, currentOriginRect.height) * 0.15}px`;
    }

    const cleanup = () => {
      overlay.remove();
      if (activeOverlay === overlay) {
        activeOverlay = null;
      }
      if (activeCleanup) {
        activeCleanup();
        activeCleanup = null;
      }
    };
    overlay.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 300);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };
  overlay.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);

  activeCleanup = () => {
    document.removeEventListener('keydown', onKey);
  };

  return dismiss;
}

function dismissImmediate(): void {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
}
