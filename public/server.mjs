import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 10000);
const publicDir = path.join(__dirname, "public");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const extensionRules = `
AI 高評分改款延伸規則：
1. 先分析圖片：品類、版型、輪廓、長度、領型、袖型、面料、圖案、顏色、熱銷設計元素、熱銷標籤。
2. 改款時必須保留所有高分熱銷標籤、熱銷版型、熱銷細節與商品核心賣點，不得失去商品辨識度。
3. 依品類延伸：
上衣：不同領型、不同袖型、不同細節設計、洋裝、連身褲、內外套裝、上下套裝。
短褲：連身褲、長裙、短裙、長褲、褲裙、上下套裝。
長褲：連身褲、長裙、短裙、短褲、褲裙、上下套裝。
短裙／褲裙：洋裝、長裙、長褲、短褲、其他短裙、上下套裝。
長裙：洋裝、短裙、長褲、短褲、上下套裝、連身褲。
長洋裝：其他洋裝版型、連身褲、上下套裝、長裙、內外套裝。
短洋裝：其他洋裝版型、連身褲、上下套裝、短裙、內外套裝。
外套：上衣、其他外套版型、洋裝、內外套裝。
4. AI 自行排序：延伸評分 = 保留熱銷元素分數 + 新品成功率 + 相似商品歷史銷售分數 + 標籤權重。
5. 每款都要說明：推薦款名、保留元素、新增元素、原因。
6. 優先權：保留熱銷元素 > 跨品類延伸 > 同品類版型延伸 > 同版型細節變化 > 配色與面料變化。
`;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) {
        reject(new Error("上傳資料太大，請減少圖片張數或壓縮圖片。"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function serveFile(filePath, res) {
  const data = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".json" || ext === ".html" ? "no-store" : "public, max-age=86400"
  });
  res.end(data);
}

async function serveStatic(urlPath, res) {
  const decodedPath = decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const filePath = path.resolve(publicDir, decodedPath);
  const publicRoot = path.resolve(publicDir);
  if (!filePath.startsWith(publicRoot + path.sep) && filePath !== publicRoot) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }
  try {
    await serveFile(filePath, res);
    return true;
  } catch {
    return false;
  }
}

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Render Environment 尚未設定 OPENAI_API_KEY。");
  return key;
}

function safeJson(content) {
  const text = String(content || "{}").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

async function callOpenAiJson(messages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey()}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `OpenAI 分析失敗 HTTP ${response.status}`);
  return safeJson(data.choices?.[0]?.message?.content);
}

function dataUrlToBlob(dataUrl, fallbackType = "image/png") {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  return new Blob([bytes], { type: match[1] || fallbackType });
}

async function editImage(prompt, productDataUrl, modelDataUrl) {
  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-1");
  form.append("prompt", prompt);
  form.append("size", process.env.OPENAI_IMAGE_SIZE || "1024x1024");
  const productBlob = dataUrlToBlob(productDataUrl);
  const modelBlob = dataUrlToBlob(modelDataUrl);
  if (productBlob) form.append("image", productBlob, "product-reference.png");
  if (modelBlob) form.append("image", modelBlob, "as-digital-human-reference.png");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey()}` },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `OpenAI 參考圖生成失敗 HTTP ${response.status}`);
  const item = data.data?.[0] || {};
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  throw new Error("OpenAI 沒有回傳圖片。");
}

async function generateImage(prompt) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey()}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
      prompt,
      size: process.env.OPENAI_IMAGE_SIZE || "1024x1024",
      n: 1
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `OpenAI 生成圖片失敗 HTTP ${response.status}`);
  const item = data.data?.[0] || {};
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  throw new Error("OpenAI 沒有回傳圖片。");
}

async function analyzeImage(payload) {
  const branchName = payload.branchName || "AS";
  const categories = Array.isArray(payload.categories) ? payload.categories : [];
  const factorText = payload.factorText || "";
  const note = payload.note || "";
  const prompt = `
你是 AIR SPACE 商品企劃與服裝設計分析助手。
目前支線：${branchName}
可用大品類：${categories.join("、")}
使用者補充說明：${note || "無"}
目前暢滯銷標籤摘要：
${factorText || "無"}

${extensionRules}

請依圖片先判斷原商品，再提出 ${Number(payload.variantCount || 3)} 款最值得生成的改款延伸。
每款優先跨品類延伸，但不得失去原商品高分賣點。
每款 title、category、middleCategory 必須與生成 prompt 完全一致。例如 category 是洋裝，prompt 必須描述一件完整洋裝，不可只生成上衣或背心；category 是外套，必須是外套；category 是褲子，必須是褲裝。

只回傳 JSON，不要 Markdown。格式：
{
  "analysis": {
    "title": "原商品判斷名稱",
    "category": "大品類",
    "middleCategory": "中分類或款式型",
    "features": ["標籤"],
    "summary": "一句分析"
  },
  "variants": [
    {
      "title": "延伸款名",
      "category": "大品類",
      "middleCategory": "中分類或款式型",
      "features": ["標籤"],
      "kept": ["保留元素"],
      "added": ["新增元素"],
      "reason": "為何推薦",
      "prompt": "給圖片生成模型的完整服裝描述"
    }
  ]
}`;

  const parsed = await callOpenAiJson([
    { role: "system", content: "你只能回傳可解析 JSON。標籤請用繁體中文，且可依目視與品名語意自由萃取，例如綁帶、透膚、百褶、波點、鏤空、魚尾、蕾絲、格紋。" },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: payload.imageDataUrl } }
      ]
    }
  ]);

  const count = Math.max(1, Math.min(3, Number(payload.variantCount || 3)));
  const variants = Array.isArray(parsed.variants) ? parsed.variants.slice(0, count) : [];
  return {
    analysis: parsed.analysis || {},
    variants
  };
}

async function extendStyle(payload) {
  const analyzed = await analyzeImage(payload);
  const original = analyzed.analysis || {};
  const variants = [];
  for (const [index, variant] of analyzed.variants.entries()) {
    const imagePrompt = [
      "Create a clean ecommerce fashion product photo of one full-body female AS digital human model wearing the new AIR SPACE derived style.",
      "Model direction: use a consistent virtual model similar to a blonde western fashion fitting model, fair skin, slim 170cm proportion, clean modern commercial look, inspired by Hailey Rhode Bieber's minimal beauty direction but do not imitate or recreate any real person.",
      payload.modelDataUrl ? "Use the uploaded AS digital human reference image as the primary model identity reference. Keep the same virtual model face direction, hair color, body proportion, clean fitting-model temperament, and studio catalog feeling." : "",
      "Use the uploaded product image as the garment design reference. Preserve the high scoring garment elements, silhouette, material feeling, and core details before extending into the new category.",
      "The generated garment must exactly match the variant category and title. If the variant says dress, show a complete one-piece dress from shoulder to hem. If it says top, show a top. If it says outerwear, show outerwear. Do not output a cropped top when the title/category says dress.",
      "Show the complete garment clearly, full body, not a close-up crop. Keep the full hem, sleeve, neckline, waist and silhouette visible.",
      "Use a plain white or warm off-white studio background, full-body front pose, natural standing posture, clear garment details, premium online shop catalog lighting.",
      "Keep the original product's strongest selling points and visual identity, but make it a new commercially viable design.",
      "No text, no logo, no collage, no layout board, no watermark.",
      `Original analysis: ${JSON.stringify(original)}`,
      `Variant ${index + 1}: ${JSON.stringify(variant)}`,
      `Generation prompt: ${variant.prompt || ""}`
    ].join("\n");
    try {
      const imageDataUrl = payload.modelDataUrl
        ? await editImage(imagePrompt, payload.imageDataUrl, payload.modelDataUrl)
        : await generateImage(imagePrompt);
      variants.push({ ...variant, imageDataUrl });
    } catch (error) {
      variants.push({ ...variant, imageError: error.message || String(error) });
    }
  }
  return { analysis: original, variants };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, hasApiKey: Boolean(process.env.OPENAI_API_KEY) });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/analyze" || url.pathname === "/api/extend-style")) {
    try {
      const payload = JSON.parse(await readBody(req) || "{}");
      const data = url.pathname === "/api/extend-style" ? await extendStyle(payload) : await analyzeImage(payload);
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 500, { error: error.message || String(error) });
    }
    return;
  }

  if (req.method === "GET") {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      await serveFile(path.join(publicDir, "index.html"), res);
      return;
    }
    if (await serveStatic(url.pathname, res)) return;
  }

  sendJson(res, 404, { error: "Not found" });
}

http.createServer((req, res) => {
  handler(req, res).catch(error => sendJson(res, 500, { error: error.message || String(error) }));
}).listen(port, "0.0.0.0", () => {
  console.log(`AIR SPACE style extension app running on port ${port}`);
});
