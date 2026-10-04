function findSvg(element) {
  return element.querySelector("svg");
}

function svgToCanvas(svg, width, height) {
  return new Promise((resolve, reject) => {
    const clone = svg.cloneNode(true);
    clone.setAttribute("width", width);
    clone.setAttribute("height", height);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

    const data = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([data], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext("2d");
      ctx.scale(2, 2);
      ctx.fillStyle = "#040D1A";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to render chart"));
    };
    img.src = url;
  });
}

async function captureChart(element, title, dateRange) {
  const svg = findSvg(element);
  if (!svg) throw new Error("No chart found in this area");

  // Capture the SVG at its own aspect ratio. The wrapper can also contain a
  // legend, whose height must not stretch the exported chart.
  const rect = svg.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (!(width > 0 && height > 0)) throw new Error("The chart is hidden or has no visible size");

  const chartCanvas = await svgToCanvas(svg, width, height);

  const headerHeight = title || dateRange ? 56 : 0;
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = (height + headerHeight) * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  ctx.fillStyle = "#040D1A";
  ctx.fillRect(0, 0, width, height + headerHeight);

  if (title) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 16px 'Space Grotesk', sans-serif";
    ctx.fillText(title, 20, 26);
  }
  if (dateRange) {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px 'Inter', sans-serif";
    ctx.fillText(dateRange, 20, 46);
  }

  ctx.drawImage(chartCanvas, 0, headerHeight, width, height);
  return canvas;
}

export async function exportChartPng(element, fileName, title, dateRange) {
  const canvas = await captureChart(element, title, dateRange);
  const link = document.createElement("a");
  link.download = fileName;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

export async function copyChartToClipboard(element, title, dateRange) {
  if (!navigator.clipboard || !window.ClipboardItem) {
    throw new Error("Clipboard not supported in this browser");
  }
  const canvas = await captureChart(element, title, dateRange);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not create the chart image for the clipboard");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
