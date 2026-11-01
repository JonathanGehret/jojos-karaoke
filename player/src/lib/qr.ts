import QRCode from 'qrcode';

export function drawQr(canvas: HTMLCanvasElement, text: string, size = 220) {
  return QRCode.toCanvas(canvas, text, { width: size, margin: 1, color: { dark: '#14112b', light: '#ffffff' } });
}
