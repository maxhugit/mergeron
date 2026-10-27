export const BROWSER_ANNOTATION_EVENT = 'mergeron:browser-annotation';
export interface BrowserAnnotationRequest {
  threadId: string;
  text: string;
  image: File;
  accepted?: boolean;
  complete: (error?: string) => void;
}
export async function markedScreenshot(
  image: string,
  box: { x: number; y: number; width: number; height: number },
): Promise<File> {
  const source = new Image();
  source.src = image;
  await source.decode();
  const canvas = document.createElement('canvas');
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Screenshot unavailable');
  context.drawImage(source, 0, 0);
  context.strokeStyle = '#006aff';
  context.lineWidth = 3;
  context.strokeRect(
    Math.max(1, box.x),
    Math.max(1, box.y),
    Math.min(box.width, canvas.width - box.x - 2),
    Math.min(box.height, canvas.height - box.y - 2),
  );
  context.fillStyle = '#006aff';
  context.beginPath();
  context.arc(
    Math.max(13, box.x + 12),
    Math.max(13, box.y + 12),
    12,
    0,
    2 * Math.PI,
  );
  context.fill();
  context.fillStyle = '#ffffff';
  context.font = 'bold 16px sans-serif';
  context.fillText('1', Math.max(9, box.x + 8), Math.max(19, box.y + 18));
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('Screenshot unavailable')),
      'image/png',
    ),
  );
  return new File([blob], 'browser-annotation.png', { type: 'image/png' });
}
export function insertBrowserAnnotation(
  request: Omit<BrowserAnnotationRequest, 'complete' | 'accepted'>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const detail: BrowserAnnotationRequest = {
      ...request,
      complete: (error) => (error ? reject(new Error(error)) : resolve()),
    };
    window.dispatchEvent(new CustomEvent(BROWSER_ANNOTATION_EVENT, { detail }));
    if (!detail.accepted) reject(new Error('Conversation input unavailable'));
  });
}
