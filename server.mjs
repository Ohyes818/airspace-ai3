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
上衣：不同領型、不同袖型、不同細節設計、上衣、洋裝+外件套裝、連身褲、內外套裝、上下套裝。
套裝／上身內外套裝：不同領型、不同袖型、不同細節設計、上衣、洋裝+外件套裝。若原圖或使用者文字判定為套裝／上身內外套裝，必須優先依照此順序延伸，不可先跳到褲子或不相關品類；至少要有一款上衣延伸、一款洋裝+外件套裝延伸。
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
  if (modelBlob && productBlob) {
    form.append("image[]", modelBlob, "as-digital-human-reference.png");
    form.append("image[]", productBlob, "product-reference.png");
  } else if (modelBlob) {
    form.append("image", modelBlob, "as-digital-human-reference.png");
  } else if (productBlob) {
    form.append("image", productBlob, "product-reference.png");
  }

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

function formatGenerationRules(rules) {
  if (!rules || typeof rules !== "object") return "";
  const parts = [];
  if (rules.defaultModel?.description) parts.push(`預設數字人：${rules.defaultModel.description}`);
  if (rules.explicitRules) parts.push(rules.explicitRules);
  if (rules.branchIntroDocxText) parts.push(`AS支線介紹：\n${String(rules.branchIntroDocxText).slice(0, 5000)}`);
  if (rules.coreLogicPdfText) parts.push(`AS核心設計邏輯：\n${String(rules.coreLogicPdfText).slice(0, 3000)}`);
  return parts.join("\n\n");
}

function normalizeFeatureText(value) {
  return String(value || "")
    .replace(/^[^:：]*[:：]/, "")
    .replace(/[（(]\d+[)）]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function splitFeatureText(value) {
  return String(value || "")
    .split(/[、,，\/|]/)
    .map(normalizeFeatureText)
    .filter(Boolean)
    .filter(x => x !== "無" && x !== "未明顯命中");
}

function uniqueList(list) {
  return [...new Set((list || []).map(normalizeFeatureText).filter(Boolean))];
}

function categoryFromText(value) {
  const text = String(value || "");
  if (/洋裝\+外件|洋裝加外件|內外套裝|上下套裝|兩件式套裝|成套|同布料套裝|同花色套裝/.test(text)) return "套裝";
  if (/洋裝|長洋|短洋|連身裙/.test(text)) return "洋裝";
  if (/裙子|短裙|長裙|褲裙|魚尾裙|蛋糕裙/.test(text)) return "裙子";
  if (/褲子|長褲|短褲|寬褲|牛仔褲|喇叭褲/.test(text)) return "褲子";
  if (/外套|罩衫|針織外套|皮外套/.test(text)) return "外套";
  if (/上衣|背心|襯衫|針織上衣|BRA/.test(text)) return "上衣";
  return "";
}

function parseFactorText(factorText) {
  const map = new Map();
  String(factorText || "").split(/\r?\n/).forEach(line => {
    const match = line.match(/^(.+?)\s*熱銷[:：](.*?)；滯銷[:：](.*)$/);
    if (!match) return;
    const category = normalizeFeatureText(match[1]);
    map.set(category, {
      hot: splitFeatureText(match[2]),
      slow: splitFeatureText(match[3])
    });
  });
  return map;
}

function optimizeVariantForScore(variant, original, factorText) {
  const factorMap = parseFactorText(factorText);
  const category =
    categoryFromText(`${variant.category || ""}${variant.middleCategory || ""}${variant.title || ""}`) ||
    categoryFromText(`${original.category || ""}${original.middleCategory || ""}${original.title || ""}`) ||
    variant.category ||
    original.category ||
    "上衣";
  const factors = factorMap.get(category) || factorMap.get(variant.category) || factorMap.get(original.category) || { hot: [], slow: [] };
  const slowSet = new Set((factors.slow || []).map(normalizeFeatureText));
  const hotList = uniqueList(factors.hot || []);
  const rawFeatures = uniqueList([...(variant.features || []), variant.middleCategory, variant.title]);
  const removed = rawFeatures.filter(x => slowSet.has(normalizeFeatureText(x)));
  const keptFeatures = rawFeatures.filter(x => !slowSet.has(normalizeFeatureText(x)));
  const neededHot = hotList
    .filter(x => !keptFeatures.includes(x))
    .slice(0, Math.max(6, 10 - keptFeatures.length));
  const optimizedFeatures = uniqueList([...keptFeatures, ...neededHot]).slice(0, 14);
  const kept = uniqueList(variant.kept || []).filter(x => !slowSet.has(normalizeFeatureText(x)));
  const added = uniqueList([...(variant.added || []), ...neededHot]);
  const repairText = [
    removed.length ? `移除/弱化低分滯銷元素：${removed.join("、")}` : "",
    neededHot.length ? `補入同品類熱銷元素：${neededHot.join("、")}` : "",
    `此方案必須以 ${category} 評分邏輯優化到 8 分以上`
  ].filter(Boolean).join("；");

  return {
    ...variant,
    category,
    features: optimizedFeatures,
    kept,
    added,
    reason: `${repairText}。${variant.reason || ""}`.trim(),
    prompt: [
      variant.prompt || "",
      `Mandatory score repair: ${repairText}.`,
      `Use these high-scoring visible design labels in the garment: ${optimizedFeatures.join(", ")}.`,
      removed.length ? `Do not visibly preserve these low-scoring labels as main selling points: ${removed.join(", ")}.` : ""
    ].filter(Boolean).join("\n")
  };
}

function normalizeSetMislabel(variant) {
  const text = `${variant.title || ""} ${variant.middleCategory || ""} ${(variant.features || []).join("、")} ${variant.prompt || ""}`;
  const saysSet = /套裝|兩件式|上下套裝|內外套裝|洋裝\+外件|洋裝加外件/.test(text);
  const trueSet = /洋裝\+外件|洋裝加外件|內外套裝|上下套裝|兩件式套裝|成套|同布料|同花色|同系列/.test(text);
  const topBottomOnly = /上衣.+褲|褲.+上衣|短袖.+褲|襯衫.+褲|背心.+褲|針織.+褲/.test(text);
  if ((variant.category === "套裝" || saysSet) && !trueSet && topBottomOnly) {
    const fixedFeatures = uniqueList(variant.features || []).filter(x => !/套裝|兩件式|上下套裝/.test(x));
    return {
      ...variant,
      category: "上衣",
      middleCategory: variant.middleCategory && !/套裝/.test(variant.middleCategory) ? variant.middleCategory : "上衣延伸",
      features: fixedFeatures,
      added: uniqueList(variant.added || []).filter(x => !/套裝|兩件式|上下套裝/.test(x)),
      reason: `此款僅為上下身搭配照，不是同系列成套設計，已改以「上衣」邏輯評分與生成。${variant.reason || ""}`,
      prompt: `${variant.prompt || ""}\nThis is not a set unless the top and bottom are visibly designed as a matching same-fabric or same-pattern set. Do not label a random top-and-pants outfit as a set.`
    };
  }
  return variant;
}

async function analyzeImage(payload) {
  const branchName = payload.branchName || "AS";
  const categories = Array.isArray(payload.categories) ? payload.categories : [];
  const factorText = payload.factorText || "";
  const note = payload.note || "";
  const forcedCategory = payload.forcedCategory || "";
  const requestedCount = Math.max(1, Math.min(5, Number(payload.variantCount || 5)));
  const generationRuleText = formatGenerationRules(payload.generationRules);
  const prompt = `
你是 AIR SPACE 商品企劃與服裝設計分析助手。
目前支線：${branchName}
可用大品類：${categories.join("、")}
使用者補充說明：${note || "無"}
使用者指定品類：${forcedCategory || "無"}
AS支線核心邏輯與風格定位：
${generationRuleText || "無"}

目前暢滯銷標籤摘要：
${factorText || "無"}

${extensionRules}

請依圖片先判斷原商品，再提出 ${requestedCount} 款最值得生成的改款延伸。
每款延伸都必須以本系統評分 8 分以上為硬性目標。若初始方向可能低於 8 分，不要放棄生成，而是保留原商品設計重點後，主動加入更高權重的熱銷標籤、修正版型/領型/材質/細節，改到預估 8 分以上再輸出。
不要回覆「低於 8 分所以不做」。你必須給出已優化後的改款方案。
輸出 variants 前必須先自評：若任何方案預估低於 8 分，請直接改寫該方案的 category、middleCategory、features、kept、added、reason、prompt，直到預估 8 分以上。不要把低分草案放進 JSON。
原圖元素若在目前摘要中偏滯銷，不可盲目保留；只能保留真正構成辨識度的核心賣點，其他扣分元素要替換成同品類或跨品類更熱銷的相近元素。例如 V領、過短、弱勢材質或弱勢圖案造成扣分時，請改成更高分的領型/版型/細節，但 reason 必須說明「改掉低分元素」。
features 必須列出實際能加分、且會畫在圖上的熱銷標籤；不要列入沒有畫出來、沒有保留、或已被替換掉的元素。
若原商品是套裝／上身內外套裝，${requestedCount} 款方案中必須優先包含：不同領型、不同袖型、不同細節設計、上衣、洋裝+外件套裝；不得只產生一款，也不得全部集中在同一個延伸方向。
每款優先跨品類延伸，但不得失去原商品高分賣點。除非使用者明確要求只做同品類，否則 ${requestedCount} 款中至少 3 款要是跨品類延伸。
每款 title、category、middleCategory 必須與生成 prompt 完全一致。例如 category 是洋裝，prompt 必須描述一件完整洋裝，不可只生成上衣或背心；category 是外套，必須是外套；category 是褲子，必須是褲裝。
如果「使用者指定品類」不是無，analysis.category 必須等於該指定品類，且延伸方向也必須從該品類出發，不可自行改判成套裝或其他品類。
若原圖或品名有明顯設計，例如前車線、綁帶、鏤空、蕾絲、透膚、百褶、開衩、魚尾、荷葉、牛仔、高腰、顯瘦，且列在 kept 或 features，生成 prompt 必須具體描述該元素出現在服裝哪個位置，不能只寫文字不畫出來。
特別注意：「前車線」不是普通素面褲，必須描述為褲子正面從腰頭往下延伸的可見縱向車線/拼接線/壓線，左右腿正面都要清楚可見。
搭配請參考 AIR SPACE 官網商品照精神：乾淨、顯比例、微甜微性感、實穿但有設計點；避免醜搭配、厚重混搭、廉價感、奇怪配件、過度前衛或非 AIR SPACE 風格。

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

  const variants = Array.isArray(parsed.variants)
    ? parsed.variants
        .slice(0, requestedCount)
        .map(variant => optimizeVariantForScore(normalizeSetMislabel(variant), parsed.analysis || {}, factorText))
    : [];
  return {
    analysis: parsed.analysis || {},
    variants
  };
}

async function extendStyle(payload) {
  const analyzed = await analyzeImage(payload);
  const original = analyzed.analysis || {};
  const generationRuleText = formatGenerationRules(payload.generationRules);
  const variants = [];
  for (const [index, variant] of analyzed.variants.entries()) {
    const imagePrompt = [
      "Create a clean ecommerce fashion product photo of one full-body female AS digital human model wearing the new AIR SPACE derived style.",
      payload.modelDataUrl
        ? "MANDATORY MODEL REFERENCE: use the uploaded AS digital human reference image as the primary model identity reference. Preserve the same virtual face structure, blonde hair color and hairstyle, fair skin tone, slim 170cm 47kg body proportion, D-cup bust proportion, fitting-model posture, and clean AIR SPACE catalog temperament. Do not invent a different model. If garment and model references conflict, prioritize keeping the AS digital human model identity."
        : "Model direction: use a consistent virtual blonde western fashion fitting model, fair skin, slim 170cm 47kg proportion, D-cup bust proportion, clean modern commercial look. Do not imitate or recreate any real person.",
      "Use the uploaded product image as the garment design reference. Preserve the high scoring garment elements, silhouette, material feeling, and core details before extending into the new category.",
      "The generated garment must exactly match the variant category and title. If the variant says dress, show a complete one-piece dress from shoulder to hem. If it says top, show a top. If it says outerwear, show outerwear. Do not output a cropped top when the title/category says dress.",
      "If the variant keeps a visual detail such as front seam lines, lace-up ties, cutout, lace, sheer fabric, pleats, slit, fishtail, ruffles, denim wash, high waist, or slimming seams, that detail must be visibly present in the generated image at the correct garment location.",
      "When preserving front seam lines on pants or denim, render clear vertical seam/panel lines on the front of both legs from waistband toward hem. Do not replace them with a plain smooth pant front.",
      "Show the complete garment clearly, full body, not a close-up crop. Keep the full hem, sleeve, neckline, waist and silhouette visible.",
      "Styling direction must feel like AIR SPACE online store product styling: clean modern Taiwanese ecommerce fashion, flattering body proportion, sweet-sexy but wearable, minimal accessories, neat hair, no awkward layering, no random streetwear pieces, no heavy or ugly outfit matching.",
      "Use a plain white or warm off-white studio background, full-body front pose, natural standing posture, clear garment details, premium online shop catalog lighting.",
      "Keep the original product's strongest selling points and visual identity, but make it a new commercially viable design.",
      "Target score requirement is mandatory: the design should be likely to score 8/10 or higher in the AIR SPACE scoring system. Avoid slow-selling features and weak category mismatches.",
      "If an original feature is likely to reduce the score according to the hot/slow tag context, do not preserve it literally. Replace it with a visually related higher-scoring alternative while keeping the product identity. For example, if V-neck or another neckline is a slow-selling factor, convert it to a higher-scoring neckline or styling instead of keeping it.",
      "For set or inner-outer set extensions, follow the required priority: neckline variation, sleeve variation, detail variation, top, dress plus outer layer set. Do not generate unrelated pants-only ideas first.",
      "The final generated image must represent an optimized 8+ design, not a low-score draft.",
      `AS branch design rules and positioning: ${generationRuleText || "Use AIR SPACE AS sweet-sexy, body-flattering, clean ecommerce styling."}`,
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

