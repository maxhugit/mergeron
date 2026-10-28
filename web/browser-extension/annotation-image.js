// Runs only inside an extension-owned page, never inside the annotated website.
export async function markCapture(source, geometry) {
  if (
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(source) ||
    source.length > 4_000_000
  )
    throw Error('INVALID_CAPTURE');
  const { width, height, box, masks } = geometry ?? {};
  const rectValid = (rect) =>
    rect &&
    ['x', 'y', 'width', 'height'].every(
      (key) => Number.isFinite(rect[key]) && rect[key] >= 0,
    ) &&
    rect.x + rect.width <= width + 1 &&
    rect.y + rect.height <= height + 1;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > 16_384 ||
    height > 16_384 ||
    !rectValid(box) ||
    !Array.isArray(masks) ||
    masks.length > 400 ||
    !masks.every(rectValid)
  )
    throw Error('INVALID_GEOMETRY');
  const image = new Image();
  image.src = source;
  await image.decode();
  if (
    image.naturalWidth * image.naturalHeight > 50_000_000 ||
    Math.abs(image.naturalWidth / image.naturalHeight - width / height) > 0.03
  )
    throw Error('VIEWPORT_CHANGED');
  const scale = Math.min(
    1,
    1280 / image.naturalWidth,
    1000 / image.naturalHeight,
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) throw Error('CANVAS_UNAVAILABLE');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const sx = canvas.width / width,
    sy = canvas.height / height;
  // Redact before drawing the marker or exposing a preview. Never send raw capture.
  context.fillStyle = '#344155';
  for (const rect of masks)
    context.fillRect(
      Math.floor(rect.x * sx) - 3,
      Math.floor(rect.y * sy) - 3,
      Math.ceil(rect.width * sx) + 6,
      Math.ceil(rect.height * sy) + 6,
    );
  context.strokeStyle = '#168bff';
  context.lineWidth = 3;
  context.strokeRect(
    Math.max(2, box.x * sx),
    Math.max(2, box.y * sy),
    Math.max(1, Math.min(box.width * sx, canvas.width - box.x * sx - 3)),
    Math.max(1, Math.min(box.height * sy, canvas.height - box.y * sy - 3)),
  );
  const x = Math.max(14, Math.min(canvas.width - 14, box.x * sx + 12));
  const y = Math.max(14, Math.min(canvas.height - 14, box.y * sy + 12));
  context.fillStyle = '#168bff';
  context.beginPath();
  context.arc(x, y, 12, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#fff';
  context.font = 'bold 16px system-ui';
  context.textAlign = 'center';
  context.fillText('1', x, y + 6);
  for (const quality of [0.85, 0.65, 0.45]) {
    const marked = canvas.toDataURL('image/jpeg', quality);
    if (marked.length <= 750_000) return marked;
  }
  throw Error('CAPTURE_TOO_LARGE');
}
